// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title MarketMakerVault
/// @notice The leveraged liquidity/fee layer on top of PriceOracle: a market
/// maker funds a pool of quote-token capital, traders open leveraged long/short
/// exposure to the oracle's fair price against that pool, and the market maker
/// earns fees for taking the other side. Undercollateralized positions are
/// liquidated by permissionless keepers.
///
/// Manipulation resistance: this vault never lets a trader move the price it
/// trades at -- every fill and every liquidation uses PriceOracle's
/// independently-attested mid, full stop. What a trader *can* influence is the
/// fee they pay: opening or closing exposure that pushes the book further out
/// of balance (relative to the market maker's inventory) costs progressively
/// more, while flow that brings the book back toward balance gets a discount.
/// That symmetric skew is what keeps the vault sustaining both buyers and
/// sellers instead of only ever favoring one side, and it is also exposed
/// on-chain (`getInventorySkewBps`) so the off-chain fair-price engine can
/// factor real trading pressure into the next attestation without the vault
/// ever needing to trust that engine.
///
/// Accounting model -- three strictly separated pools, so trader collateral is
/// never silently spent as market-maker capital:
///   totalLiquidity  MM capital. Grows by realized trader losses and the MM's
///                   share of liquidation penalties, shrinks by realized
///                   trader profits.
///   totalMargin     Trader collateral held in escrow against open positions.
///                   Not the MM's money; only moves to totalLiquidity when a
///                   position realizes a loss.
///   feesAccrued     MM fee revenue, withdrawable without touching the capital
///                   backing open positions.
/// The contract's token balance always equals the sum of the three; see
/// `solvencyInvariantHolds()`.
contract MarketMakerVault is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant MARKET_MAKER_ROLE = keccak256("MARKET_MAKER_ROLE");

    uint256 public constant BPS_DENOMINATOR = 10_000;

    IPriceOracle public immutable oracle;
    IERC20 public immutable quoteToken;
    bytes32 public immutable assetId;

    struct VaultConfig {
        uint16 baseFeeBps; // charged on notional at open and close
        uint16 maxFeeBps; // ceiling on fee after skew penalty, and skew cap
        uint16 skewSensitivityBps; // scales inventory skew into a fee penalty
        uint32 maxPayoutMultipleBps; // payout ceiling as a multiple of margin, e.g. 30000 = 3x
        uint32 maxLeverageBps; // e.g. 100000 = 10x
        uint16 maintenanceMarginBps; // of notional; below this equity, position is liquidatable
        uint16 liquidationPenaltyBps; // of notional, taken from the liquidated position's residual equity
        uint16 liquidatorShareBps; // share of the penalty paid to the keeper; remainder to the MM
    }

    VaultConfig public config;

    uint256 public totalLiquidity;
    uint256 public totalMargin;
    uint256 public reservedLiquidity; // worst-case MM payout earmarked against open positions
    uint256 public feesAccrued;

    /// @notice Cumulative uncollected market-maker profit from positions whose
    /// losses exceeded the trader's posted margin (a price gap outran the
    /// liquidation). This is *missed* profit, not a drain on pooled capital --
    /// the MM still collects the full margin in that case -- but it is tracked
    /// because a rising number means liquidations are firing too late.
    uint256 public cumulativeShortfall;

    int256 public netNotional; // signed: positive = traders net long, MM net short

    struct Position {
        address trader;
        bool isLong;
        uint256 margin; // collateral, net of the open fee
        uint256 notional; // margin * leverage
        uint256 entryPrice;
        uint256 reserved; // MM capital earmarked for this position's max payout
        bool open;
    }

    uint256 public nextPositionId = 1;
    mapping(uint256 => Position) public positions;

    event LiquidityDeposited(address indexed marketMaker, uint256 amount);
    event LiquidityWithdrawn(address indexed marketMaker, uint256 amount);
    event FeesWithdrawn(address indexed marketMaker, uint256 amount);
    event ConfigUpdated(VaultConfig config);
    event PositionOpened(
        uint256 indexed positionId,
        address indexed trader,
        bool isLong,
        uint256 margin,
        uint256 notional,
        uint256 entryPrice,
        uint16 feeBps
    );
    event PositionClosed(
        uint256 indexed positionId,
        address indexed trader,
        uint256 exitPrice,
        int256 pnl,
        uint256 payout,
        uint16 feeBps
    );
    event PositionLiquidated(
        uint256 indexed positionId,
        address indexed trader,
        address indexed liquidator,
        uint256 markPrice,
        int256 pnl,
        uint256 liquidatorReward,
        uint256 traderRefund,
        uint256 shortfall
    );

    error ZeroAmount();
    error InsufficientAvailableLiquidity(uint256 requested, uint256 available);
    error PositionNotOpen(uint256 positionId);
    error NotPositionOwner(uint256 positionId, address caller);
    error InsufficientFeeBalance(uint256 requested, uint256 available);
    error NoPrice();
    error LeverageOutOfRange(uint32 leverageBps, uint32 maxLeverageBps);
    error FeeExceedsMargin(uint256 fee, uint256 margin);
    error PositionWouldBeLiquidatable(uint256 equity, uint256 maintenanceMargin);
    error PositionNotLiquidatable(uint256 positionId);
    error InvalidConfig();

    constructor(
        address admin,
        address marketMaker,
        IPriceOracle _oracle,
        IERC20 _quoteToken,
        bytes32 _assetId,
        VaultConfig memory _config
    ) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MARKET_MAKER_ROLE, marketMaker);
        oracle = _oracle;
        quoteToken = _quoteToken;
        assetId = _assetId;
        _setConfig(_config);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setConfig(VaultConfig calldata _config) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setConfig(_config);
    }

    function _setConfig(VaultConfig memory _config) internal {
        if (_config.maxLeverageBps < BPS_DENOMINATOR) revert InvalidConfig();
        if (_config.maxPayoutMultipleBps <= BPS_DENOMINATOR) revert InvalidConfig();
        if (_config.maintenanceMarginBps == 0 || _config.maintenanceMarginBps >= BPS_DENOMINATOR) revert InvalidConfig();
        if (_config.liquidatorShareBps > BPS_DENOMINATOR) revert InvalidConfig();
        if (_config.maxFeeBps > BPS_DENOMINATOR || _config.baseFeeBps > _config.maxFeeBps) revert InvalidConfig();
        // A position opened at max leverage must not be instantly liquidatable:
        // its opening equity (margin) has to exceed notional * maintenanceMargin.
        if (uint256(_config.maxLeverageBps) * _config.maintenanceMarginBps >= BPS_DENOMINATOR * BPS_DENOMINATOR) {
            revert InvalidConfig();
        }
        config = _config;
        emit ConfigUpdated(_config);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Market maker liquidity management
    // ---------------------------------------------------------------------

    function depositLiquidity(uint256 amount) external onlyRole(MARKET_MAKER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        quoteToken.safeTransferFrom(msg.sender, address(this), amount);
        totalLiquidity += amount;
        emit LiquidityDeposited(msg.sender, amount);
    }

    function withdrawLiquidity(uint256 amount) external onlyRole(MARKET_MAKER_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 available = availableLiquidity();
        if (amount > available) revert InsufficientAvailableLiquidity(amount, available);
        totalLiquidity -= amount;
        quoteToken.safeTransfer(msg.sender, amount);
        emit LiquidityWithdrawn(msg.sender, amount);
    }

    function withdrawFees(uint256 amount) external onlyRole(MARKET_MAKER_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > feesAccrued) revert InsufficientFeeBalance(amount, feesAccrued);
        feesAccrued -= amount;
        quoteToken.safeTransfer(msg.sender, amount);
        emit FeesWithdrawn(msg.sender, amount);
    }

    function availableLiquidity() public view returns (uint256) {
        return totalLiquidity > reservedLiquidity ? totalLiquidity - reservedLiquidity : 0;
    }

    /// @notice The vault holds exactly MM capital + trader escrow + accrued fees.
    /// Every settlement path is written to preserve this; the test suite asserts
    /// it after each operation.
    function solvencyInvariantHolds() external view returns (bool) {
        return quoteToken.balanceOf(address(this)) == totalLiquidity + totalMargin + feesAccrued;
    }

    // ---------------------------------------------------------------------
    // Inventory skew and fees
    // ---------------------------------------------------------------------

    /// @notice Signed inventory skew in bps: positive means traders are net long
    /// (the market maker is net short and at risk if price rises further).
    /// Read by the off-chain fair-price engine as informational context, and used
    /// directly on-chain to skew the taker fee below.
    function getInventorySkewBps() public view returns (int256) {
        if (totalLiquidity == 0) return 0;
        int256 raw = (netNotional * int256(uint256(config.skewSensitivityBps))) / int256(totalLiquidity);
        int256 cap = int256(uint256(config.maxFeeBps));
        if (raw > cap) return cap;
        if (raw < -cap) return -cap;
        return raw;
    }

    /// @notice Fee (in bps of notional) a trade in direction `isLong` would pay
    /// right now. Trading in the direction that worsens existing imbalance costs
    /// more than baseFeeBps; trading in the direction that reduces it costs less,
    /// floored at zero. The oracle's mid price is never touched by this.
    function quoteFeeBps(bool isLong) public view returns (uint16) {
        int256 skew = getInventorySkewBps();
        int256 penalty = isLong ? skew : -skew;
        int256 feeBps = int256(uint256(config.baseFeeBps)) + penalty;
        if (feeBps < 0) feeBps = 0;
        int256 ceiling = int256(uint256(config.maxFeeBps));
        if (feeBps > ceiling) feeBps = ceiling;
        return uint16(uint256(feeBps));
    }

    // ---------------------------------------------------------------------
    // Position views
    // ---------------------------------------------------------------------

    function getMarkPrice() public view returns (uint256) {
        (uint256 price, , ) = oracle.getPrice(assetId);
        if (price == 0) revert NoPrice();
        return price;
    }

    function _pnlAt(Position memory position, uint256 price) internal pure returns (int256) {
        int256 delta = int256(price) - int256(position.entryPrice);
        if (!position.isLong) delta = -delta;
        return (int256(position.notional) * delta) / int256(position.entryPrice);
    }

    /// @notice Position equity (margin + unrealized pnl) at `price`. Can be
    /// negative if a price move outran liquidation.
    function getPositionEquityAt(uint256 positionId, uint256 price) public view returns (int256) {
        Position memory position = positions[positionId];
        if (!position.open) revert PositionNotOpen(positionId);
        return int256(position.margin) + _pnlAt(position, price);
    }

    function getPositionEquity(uint256 positionId) public view returns (int256) {
        return getPositionEquityAt(positionId, getMarkPrice());
    }

    function maintenanceMarginFor(uint256 positionId) public view returns (uint256) {
        return (positions[positionId].notional * config.maintenanceMarginBps) / BPS_DENOMINATOR;
    }

    function isLiquidatable(uint256 positionId) public view returns (bool) {
        Position memory position = positions[positionId];
        if (!position.open) return false;
        int256 equity = int256(position.margin) + _pnlAt(position, getMarkPrice());
        return equity < int256(maintenanceMarginFor(positionId));
    }

    /// @notice Price at which this position becomes liquidatable. Derived from
    /// equity == maintenance margin:
    ///   long:  P = entry * (1 + mmBps/BPS - margin/notional)
    ///   short: P = entry * (1 - mmBps/BPS + margin/notional)
    /// Returns 0 for a long that can never be liquidated before price hits zero.
    function getLiquidationPrice(uint256 positionId) external view returns (uint256) {
        Position memory position = positions[positionId];
        if (!position.open) revert PositionNotOpen(positionId);

        uint256 marginRatioBps = (position.margin * BPS_DENOMINATOR) / position.notional;
        uint256 mmBps = config.maintenanceMarginBps;

        if (position.isLong) {
            if (marginRatioBps >= BPS_DENOMINATOR + mmBps) return 0;
            return (position.entryPrice * (BPS_DENOMINATOR + mmBps - marginRatioBps)) / BPS_DENOMINATOR;
        }
        return (position.entryPrice * (BPS_DENOMINATOR + marginRatioBps - mmBps)) / BPS_DENOMINATOR;
    }

    // ---------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------

    /// @notice Opens leveraged exposure to the oracle price, collateralized by
    /// `margin` of quote token. Notional is `margin * leverageBps` net of the
    /// open fee, which -- as on any perp venue -- is charged on notional rather
    /// than margin, so leverage scales the fee too.
    ///
    /// Max eventual payout is capped at `maxPayoutMultipleBps` of margin, and
    /// exactly that much MM capital is reserved at open time, so the market
    /// maker's liability per position is bounded and provably funded before the
    /// trade is accepted.
    function openPosition(
        bool isLong,
        uint256 margin,
        uint32 leverageBps
    ) external whenNotPaused nonReentrant returns (uint256 positionId) {
        if (margin == 0) revert ZeroAmount();
        if (leverageBps < BPS_DENOMINATOR || leverageBps > config.maxLeverageBps) {
            revert LeverageOutOfRange(leverageBps, config.maxLeverageBps);
        }

        uint256 entryPrice = getMarkPrice();
        quoteToken.safeTransferFrom(msg.sender, address(this), margin);

        uint16 feeBps = quoteFeeBps(isLong);
        uint256 fee = (((margin * leverageBps) / BPS_DENOMINATOR) * feeBps) / BPS_DENOMINATOR;
        if (fee >= margin) revert FeeExceedsMargin(fee, margin);

        uint256 netMargin = margin - fee;
        uint256 notional = (netMargin * leverageBps) / BPS_DENOMINATOR;

        uint256 maintenance = (notional * config.maintenanceMarginBps) / BPS_DENOMINATOR;
        if (netMargin < maintenance) revert PositionWouldBeLiquidatable(netMargin, maintenance);

        // Reserve only the MM's side of the worst case: the payout ceiling above
        // and beyond the trader's own escrowed margin.
        uint256 reserve = (netMargin * (config.maxPayoutMultipleBps - BPS_DENOMINATOR)) / BPS_DENOMINATOR;
        uint256 available = availableLiquidity();
        if (reserve > available) revert InsufficientAvailableLiquidity(reserve, available);

        feesAccrued += fee;
        totalMargin += netMargin;
        reservedLiquidity += reserve;

        positionId = nextPositionId++;
        positions[positionId] = Position({
            trader: msg.sender,
            isLong: isLong,
            margin: netMargin,
            notional: notional,
            entryPrice: entryPrice,
            reserved: reserve,
            open: true
        });

        netNotional += isLong ? int256(notional) : -int256(notional);

        emit PositionOpened(positionId, msg.sender, isLong, netMargin, notional, entryPrice, feeBps);
    }

    /// @notice Closes a position at the current oracle price, settling pnl
    /// between the trader's escrowed margin and the market maker's pool.
    function closePosition(uint256 positionId) external nonReentrant {
        Position memory position = positions[positionId];
        if (!position.open) revert PositionNotOpen(positionId);
        if (position.trader != msg.sender) revert NotPositionOwner(positionId, msg.sender);

        uint256 exitPrice = getMarkPrice();
        int256 pnl = _pnlAt(position, exitPrice);
        int256 equityBeforeFee = int256(position.margin) + pnl;

        // The payout ceiling is applied to the position's whole residual value
        // before the fee is carved out of it, so the MM's share of the outflow
        // (`residual - margin`) can never exceed what was reserved at open.
        uint256 residual = equityBeforeFee > 0 ? uint256(equityBeforeFee) : 0;
        uint256 cap = (position.margin * config.maxPayoutMultipleBps) / BPS_DENOMINATOR;
        if (residual > cap) residual = cap;

        uint16 feeBps = quoteFeeBps(!position.isLong);
        uint256 fee = (position.notional * feeBps) / BPS_DENOMINATOR;
        // Never charge more fee than the position is actually worth.
        if (fee > residual) fee = residual;

        uint256 payout = residual - fee;

        _releasePosition(positionId, position);
        _settle(position.margin, payout + fee, fee);

        if (payout > 0) quoteToken.safeTransfer(msg.sender, payout);

        emit PositionClosed(positionId, msg.sender, exitPrice, pnl, payout, feeBps);
    }

    /// @notice Permissionlessly liquidates a position whose equity has fallen
    /// below its maintenance margin, at the current oracle price.
    ///
    /// Deliberately callable while the vault is paused: pausing stops new risk
    /// from being opened, but blocking liquidations would strand the market
    /// maker holding undercollateralized exposure, which is precisely the
    /// situation pausing exists to contain.
    ///
    /// The liquidated position's residual equity pays a penalty of
    /// `liquidationPenaltyBps` of notional, split between the keeper who called
    /// this (`liquidatorShareBps`) and the market maker; whatever survives the
    /// penalty is returned to the trader. If the price gapped far enough that
    /// equity is already negative, the trader gets nothing, the market maker
    /// collects the full margin, and the uncollected remainder of the MM's
    /// winning side is recorded in `cumulativeShortfall`.
    function liquidate(uint256 positionId) external nonReentrant {
        Position memory position = positions[positionId];
        if (!position.open) revert PositionNotOpen(positionId);

        uint256 markPrice = getMarkPrice();
        int256 pnl = _pnlAt(position, markPrice);
        int256 equity = int256(position.margin) + pnl;

        uint256 maintenance = (position.notional * config.maintenanceMarginBps) / BPS_DENOMINATOR;
        if (equity >= int256(maintenance)) revert PositionNotLiquidatable(positionId);

        // Liquidatable implies equity < maintenance <= margin, so `residual`
        // never exceeds the escrowed margin and settlement stays funded.
        uint256 residual = equity > 0 ? uint256(equity) : 0;
        uint256 shortfall = equity < 0 ? uint256(-equity) : 0;

        uint256 penalty = (position.notional * config.liquidationPenaltyBps) / BPS_DENOMINATOR;
        if (penalty > residual) penalty = residual;

        uint256 liquidatorReward = (penalty * config.liquidatorShareBps) / BPS_DENOMINATOR;
        uint256 traderRefund = residual - penalty;

        _releasePosition(positionId, position);
        // The MM keeps everything not paid out to the keeper or refunded, which
        // is the trader's realized loss plus the MM's share of the penalty.
        _settle(position.margin, liquidatorReward + traderRefund, 0);

        if (shortfall > 0) cumulativeShortfall += shortfall;

        if (liquidatorReward > 0) quoteToken.safeTransfer(msg.sender, liquidatorReward);
        if (traderRefund > 0) quoteToken.safeTransfer(position.trader, traderRefund);

        emit PositionLiquidated(
            positionId,
            position.trader,
            msg.sender,
            markPrice,
            pnl,
            liquidatorReward,
            traderRefund,
            shortfall
        );
    }

    // ---------------------------------------------------------------------
    // Internal settlement
    // ---------------------------------------------------------------------

    function _releasePosition(uint256 positionId, Position memory position) internal {
        positions[positionId].open = false;
        reservedLiquidity -= position.reserved;
        netNotional -= position.isLong ? int256(position.notional) : -int256(position.notional);
    }

    /// @dev Moves a closed position's escrowed `margin` out of trader escrow and
    /// reconciles the difference against MM capital. `outflow` is everything
    /// leaving escrow for someone other than the MM (trader payout + keeper
    /// reward + fees); `feeShare` is the part of that outflow booked as MM fee
    /// revenue rather than paid out in tokens.
    function _settle(uint256 margin, uint256 outflow, uint256 feeShare) internal {
        totalMargin -= margin;
        if (feeShare > 0) feesAccrued += feeShare;

        if (outflow > margin) {
            // Trader profited: the excess over their own margin comes from MM capital.
            uint256 fromPool = outflow - margin;
            totalLiquidity -= fromPool;
        } else {
            // Trader lost: the unspent remainder of their margin becomes MM capital.
            totalLiquidity += margin - outflow;
        }
    }
}
