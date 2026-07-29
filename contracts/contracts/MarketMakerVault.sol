// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title MarketMakerVault
/// @notice The liquidity/fee layer that sits on top of PriceOracle: a market maker
/// funds a pool of quote-token liquidity, traders open and close notional exposure
/// to the oracle's fair price against that pool, and the market maker earns fees
/// in return for taking the other side.
///
/// Manipulation resistance: this vault never lets a trader move the price it
/// trades at — every fill uses PriceOracle's independently-attested mid, full
/// stop. What a trader *can* influence is the fee they pay: opening or closing
/// exposure that pushes the book further out of balance (relative to the
/// market maker's inventory) costs progressively more, while flow that brings
/// the book back toward balance gets a discount. That symmetric skew is what
/// keeps the vault sustaining both buyers and sellers instead of only ever
/// favoring one side, and it is also exposed on-chain (`getInventorySkewBps`)
/// so the off-chain fair-price engine can factor real trading pressure into the
/// next attestation without the vault ever needing to trust that engine.
contract MarketMakerVault is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant MARKET_MAKER_ROLE = keccak256("MARKET_MAKER_ROLE");

    uint256 public constant BPS_DENOMINATOR = 10_000;

    IPriceOracle public immutable oracle;
    IERC20 public immutable quoteToken;
    bytes32 public immutable assetId;

    uint16 public baseFeeBps; // charged on notional at open and close
    uint16 public maxFeeBps; // ceiling on fee after skew penalty, and skew cap
    uint16 public skewSensitivityBps; // scales inventory skew into a fee penalty
    uint16 public maxPayoutMultipleBps; // payout cap as a multiple of notional, e.g. 20000 = 2x

    uint256 public totalLiquidity; // MM principal + realized trading pnl, backs open positions
    uint256 public reservedLiquidity; // worst-case liability earmarked against open positions
    uint256 public feesAccrued; // MM fee revenue, withdrawable independent of principal

    int256 public netNotional; // signed: positive = traders net long, MM net short

    struct Position {
        address trader;
        bool isLong;
        uint256 notional;
        uint256 entryPrice;
        uint256 reserved;
        bool open;
    }

    uint256 public nextPositionId = 1;
    mapping(uint256 => Position) public positions;

    event LiquidityDeposited(address indexed marketMaker, uint256 amount);
    event LiquidityWithdrawn(address indexed marketMaker, uint256 amount);
    event FeesWithdrawn(address indexed marketMaker, uint256 amount);
    event PositionOpened(
        uint256 indexed positionId,
        address indexed trader,
        bool isLong,
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

    error ZeroAmount();
    error InsufficientAvailableLiquidity(uint256 requested, uint256 available);
    error PositionNotOpen(uint256 positionId);
    error NotPositionOwner(uint256 positionId, address caller);
    error InsufficientFeeBalance(uint256 requested, uint256 available);
    error NoPrice();

    constructor(
        address admin,
        address marketMaker,
        IPriceOracle _oracle,
        IERC20 _quoteToken,
        bytes32 _assetId,
        uint16 _baseFeeBps,
        uint16 _maxFeeBps,
        uint16 _skewSensitivityBps,
        uint16 _maxPayoutMultipleBps
    ) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MARKET_MAKER_ROLE, marketMaker);
        oracle = _oracle;
        quoteToken = _quoteToken;
        assetId = _assetId;
        baseFeeBps = _baseFeeBps;
        maxFeeBps = _maxFeeBps;
        skewSensitivityBps = _skewSensitivityBps;
        maxPayoutMultipleBps = _maxPayoutMultipleBps;
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

    // ---------------------------------------------------------------------
    // Inventory skew
    // ---------------------------------------------------------------------

    /// @notice Signed inventory skew in bps: positive means traders are net long
    /// (the market maker is net short and at risk if price rises further).
    /// Read by the off-chain fair-price engine as informational context, and used
    /// directly on-chain to skew the taker fee below.
    function getInventorySkewBps() public view returns (int256) {
        if (totalLiquidity == 0) return 0;
        int256 raw = (netNotional * int256(uint256(skewSensitivityBps))) / int256(totalLiquidity);
        int256 cap = int256(uint256(maxFeeBps));
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
        int256 feeBps = int256(uint256(baseFeeBps)) + penalty;
        if (feeBps < 0) feeBps = 0;
        int256 ceiling = int256(uint256(maxFeeBps));
        if (feeBps > ceiling) feeBps = ceiling;
        return uint16(uint256(feeBps));
    }

    // ---------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------

    /// @notice Opens notional exposure to the oracle price, funded by `margin` of
    /// quote token. The position is 1x (notional == margin net of the open fee);
    /// max eventual payout is capped at `maxPayoutMultipleBps` of that notional so
    /// the market maker's liability per position is always bounded and provable
    /// solvent against pooled liquidity at open time.
    function openPosition(bool isLong, uint256 margin) external whenNotPaused nonReentrant returns (uint256 positionId) {
        if (margin == 0) revert ZeroAmount();
        quoteToken.safeTransferFrom(msg.sender, address(this), margin);

        uint16 feeBps = quoteFeeBps(isLong);
        uint256 fee = (margin * feeBps) / BPS_DENOMINATOR;
        uint256 notional = margin - fee;
        feesAccrued += fee;
        totalLiquidity += notional;

        (uint256 entryPrice, , ) = oracle.getPrice(assetId);
        if (entryPrice == 0) revert NoPrice();

        uint256 reserve = (notional * maxPayoutMultipleBps) / BPS_DENOMINATOR;
        uint256 available = availableLiquidity();
        if (reserve > available) revert InsufficientAvailableLiquidity(reserve, available);
        reservedLiquidity += reserve;

        positionId = nextPositionId++;
        positions[positionId] = Position({
            trader: msg.sender,
            isLong: isLong,
            notional: notional,
            entryPrice: entryPrice,
            reserved: reserve,
            open: true
        });

        netNotional += isLong ? int256(notional) : -int256(notional);

        emit PositionOpened(positionId, msg.sender, isLong, notional, entryPrice, feeBps);
    }

    /// @notice Closes a position at the current oracle price and settles PnL out
    /// of pooled liquidity, net of the close fee.
    function closePosition(uint256 positionId) external nonReentrant {
        Position storage position = positions[positionId];
        if (!position.open) revert PositionNotOpen(positionId);
        if (position.trader != msg.sender) revert NotPositionOwner(positionId, msg.sender);

        (uint256 exitPrice, , ) = oracle.getPrice(assetId);
        if (exitPrice == 0) revert NoPrice();

        int256 pnl = position.isLong
            ? (int256(position.notional) * (int256(exitPrice) - int256(position.entryPrice))) / int256(position.entryPrice)
            : (int256(position.notional) * (int256(position.entryPrice) - int256(exitPrice))) / int256(position.entryPrice);

        uint16 feeBps = quoteFeeBps(!position.isLong);
        uint256 fee = (position.notional * feeBps) / BPS_DENOMINATOR;

        int256 grossPayout = int256(position.notional) + pnl - int256(fee);
        uint256 payout = grossPayout <= 0 ? 0 : uint256(grossPayout);
        uint256 cap = (position.notional * maxPayoutMultipleBps) / BPS_DENOMINATOR;
        if (payout > cap) payout = cap;

        reservedLiquidity -= position.reserved;
        totalLiquidity -= (payout + fee);
        feesAccrued += fee;
        position.open = false;

        netNotional -= position.isLong ? int256(position.notional) : -int256(position.notional);

        if (payout > 0) {
            quoteToken.safeTransfer(msg.sender, payout);
        }

        emit PositionClosed(positionId, msg.sender, exitPrice, pnl, payout, feeBps);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
