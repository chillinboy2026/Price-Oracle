import { expect } from "chai";
import { ethers } from "hardhat";
import { Wallet } from "ethers";
import {
  MarketSession,
  PriceAttestation,
  domainFor,
  signAttestationByAll,
} from "./helpers/attestation";

const ASSET_ID = ethers.keccak256(ethers.toUtf8Bytes("AAPL"));
const ONE = 10n ** 18n;
const BPS = 10_000n;

const CONFIG = {
  baseFeeBps: 100n, // 1%
  maxFeeBps: 1000n, // 10%
  skewSensitivityBps: 10_000n,
  maxPayoutMultipleBps: 30_000n, // 3x margin
  maxLeverageBps: 100_000n, // 10x
  maintenanceMarginBps: 500n, // 5% of notional
  liquidationPenaltyBps: 200n, // 2% of notional
  liquidatorShareBps: 5_000n, // half the penalty to the keeper
  skewSmoothingWindow: 0n, // smoothing tested separately; off here for determinism
};

function configTuple(overrides: Partial<typeof CONFIG> = {}) {
  const c = { ...CONFIG, ...overrides };
  return {
    baseFeeBps: c.baseFeeBps,
    maxFeeBps: c.maxFeeBps,
    skewSensitivityBps: c.skewSensitivityBps,
    maxPayoutMultipleBps: c.maxPayoutMultipleBps,
    maxLeverageBps: c.maxLeverageBps,
    maintenanceMarginBps: c.maintenanceMarginBps,
    liquidationPenaltyBps: c.liquidationPenaltyBps,
    liquidatorShareBps: c.liquidatorShareBps,
    skewSmoothingWindow: c.skewSmoothingWindow,
  };
}

function clampBps(v: bigint, cap: bigint): bigint {
  if (v > cap) return cap;
  if (v < -cap) return -cap;
  return v;
}

function expectedFeeBps(isLong: boolean, netNotional: bigint, totalLiquidity: bigint): bigint {
  const skew =
    totalLiquidity === 0n
      ? 0n
      : clampBps((netNotional * CONFIG.skewSensitivityBps) / totalLiquidity, CONFIG.maxFeeBps);
  const penalty = isLong ? skew : -skew;
  let fee = CONFIG.baseFeeBps + penalty;
  if (fee < 0n) fee = 0n;
  if (fee > CONFIG.maxFeeBps) fee = CONFIG.maxFeeBps;
  return fee;
}

/** Mirrors openPosition's sizing math so tests assert against an independent
 * derivation rather than reading the contract's own stored values back. */
function openMath(margin: bigint, leverageBps: bigint, feeBps: bigint) {
  const fee = (((margin * leverageBps) / BPS) * feeBps) / BPS;
  const netMargin = margin - fee;
  const notional = (netMargin * leverageBps) / BPS;
  const reserve = (netMargin * (CONFIG.maxPayoutMultipleBps - BPS)) / BPS;
  return { fee, netMargin, notional, reserve };
}

describe("MarketMakerVault", function () {
  async function deploy(configOverrides: Partial<typeof CONFIG> = {}) {
    const [admin, marketMaker, trader, keeper, other] = await ethers.getSigners();
    const reporter = Wallet.createRandom();

    const Oracle = await ethers.getContractFactory("PriceOracle", admin);
    const oracle = await Oracle.deploy(admin.address);
    await oracle.waitForDeployment();
    const REPORTER_ROLE = await oracle.REPORTER_ROLE();
    await oracle.grantRole(REPORTER_ROLE, reporter.address);
    await oracle.registerAsset(ASSET_ID, {
      registered: true,
      threshold: 1,
      maxDeviationBpsLive: 9999,
      maxDeviationBpsOffHours: 9999,
      maxStaleness: 86_400,
      minPrice: 0,
      maxPrice: 0,
      anchorBand: ethers.ZeroAddress,
    });

    const network = await ethers.provider.getNetwork();
    const domain = domainFor(network.chainId, await oracle.getAddress());

    const Token = await ethers.getContractFactory("MockERC20", admin);
    const token = await Token.deploy("Mock USD", "mUSD");
    await token.waitForDeployment();

    const Vault = await ethers.getContractFactory("MarketMakerVault", admin);
    const vault = await Vault.deploy(
      admin.address,
      marketMaker.address,
      await oracle.getAddress(),
      await token.getAddress(),
      ASSET_ID,
      configTuple(configOverrides)
    );
    await vault.waitForDeployment();

    for (const account of [marketMaker, trader, keeper, other]) {
      await token.mint(account.address, 1_000_000n * ONE);
      await token.connect(account).approve(await vault.getAddress(), ethers.MaxUint256);
    }

    let priceNonce = 0n;
    async function setPrice(price: bigint) {
      priceNonce += 1n;
      const block = await ethers.provider.getBlock("latest");
      const attestation: PriceAttestation = {
        assetId: ASSET_ID,
        price,
        timestamp: BigInt(block!.timestamp),
        session: MarketSession.LIVE,
        confidenceBps: 10n,
        nonce: priceNonce,
      };
      await oracle.updatePrice(attestation, await signAttestationByAll([reporter], domain, attestation));
    }

    /** Guardrails cap each individual update, so walk the price in steps to
     * reach a target the way the real oracle would. */
    async function walkPriceTo(target: bigint, steps = 40) {
      const [current] = await oracle.getPrice(ASSET_ID);
      for (let i = 1; i <= steps; i++) {
        await setPrice(current + ((target - current) * BigInt(i)) / BigInt(steps));
      }
    }

    async function expectSolvent() {
      expect(await vault.solvencyInvariantHolds()).to.equal(true);
    }

    return {
      admin,
      marketMaker,
      trader,
      keeper,
      other,
      oracle,
      token,
      vault,
      setPrice,
      walkPriceTo,
      expectSolvent,
    };
  }

  describe("liquidity management", () => {
    it("lets the market maker deposit and withdraw liquidity", async () => {
      const { marketMaker, vault, expectSolvent } = await deploy();
      await expect(vault.connect(marketMaker).depositLiquidity(100_000n * ONE))
        .to.emit(vault, "LiquidityDeposited")
        .withArgs(marketMaker.address, 100_000n * ONE);
      expect(await vault.totalLiquidity()).to.equal(100_000n * ONE);

      await vault.connect(marketMaker).withdrawLiquidity(40_000n * ONE);
      expect(await vault.totalLiquidity()).to.equal(60_000n * ONE);
      await expectSolvent();
    });

    it("rejects deposits from a non-market-maker", async () => {
      const { other, vault } = await deploy();
      await expect(vault.connect(other).depositLiquidity(1n * ONE)).to.be.reverted;
    });

    it("blocks withdrawing liquidity reserved against open positions", async () => {
      const { marketMaker, trader, vault, setPrice } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(100_000n * ONE);
      await setPrice(100n * ONE);
      await vault.connect(trader).openPosition(true, 1_000n * ONE, 50_000n);

      const available = await vault.availableLiquidity();
      expect(available).to.be.lessThan(await vault.totalLiquidity());
      await expect(vault.connect(marketMaker).withdrawLiquidity(available + 1n)).to.be.revertedWithCustomError(
        vault,
        "InsufficientAvailableLiquidity"
      );
      await expect(vault.connect(marketMaker).withdrawLiquidity(available)).to.not.be.reverted;
    });

    it("keeps trader margin out of withdrawable market-maker capital", async () => {
      const { marketMaker, trader, vault, setPrice, expectSolvent } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(100_000n * ONE);
      await setPrice(100n * ONE);

      const liquidityBefore = await vault.totalLiquidity();
      await vault.connect(trader).openPosition(true, 1_000n * ONE, 20_000n);

      // Trader collateral lands in escrow, never in the MM's spendable pool.
      expect(await vault.totalLiquidity()).to.equal(liquidityBefore);
      expect(await vault.totalMargin()).to.be.greaterThan(0n);
      await expectSolvent();
    });
  });

  describe("leverage", () => {
    it("sizes notional as margin * leverage, net of a fee charged on notional", async () => {
      const { marketMaker, trader, vault, setPrice, expectSolvent } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);

      const margin = 1_000n * ONE;
      const leverageBps = 50_000n; // 5x
      const { fee, netMargin, notional } = openMath(margin, leverageBps, CONFIG.baseFeeBps);

      await expect(vault.connect(trader).openPosition(true, margin, leverageBps))
        .to.emit(vault, "PositionOpened")
        .withArgs(1n, trader.address, true, netMargin, notional, 100n * ONE, CONFIG.baseFeeBps);

      const position = await vault.positions(1n);
      expect(position.notional).to.equal(notional);
      expect(position.margin).to.equal(netMargin);
      // 5x leverage on a 1% base fee costs 5% of margin.
      expect(fee).to.equal((margin * 5n) / 100n);
      expect(await vault.feesAccrued()).to.equal(fee);
      await expectSolvent();
    });

    it("rejects leverage above the configured maximum and below 1x", async () => {
      const { marketMaker, trader, vault, setPrice } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);

      await expect(
        vault.connect(trader).openPosition(true, 1_000n * ONE, CONFIG.maxLeverageBps + 1n)
      ).to.be.revertedWithCustomError(vault, "LeverageOutOfRange");

      await expect(vault.connect(trader).openPosition(true, 1_000n * ONE, 9_999n)).to.be.revertedWithCustomError(
        vault,
        "LeverageOutOfRange"
      );
    });

    it("amplifies pnl by the leverage multiple", async () => {
      const { marketMaker, trader, vault, token, setPrice, walkPriceTo, expectSolvent } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);

      const margin = 1_000n * ONE;
      await vault.connect(trader).openPosition(true, margin, 50_000n); // 5x
      const position = await vault.positions(1n);

      await walkPriceTo(110n * ONE); // +10% spot => +50% on 5x notional

      const pnl = (position.notional * (110n * ONE - position.entryPrice)) / position.entryPrice;
      expect(pnl).to.be.closeTo((position.margin * 50n) / 100n, ONE);

      const balanceBefore = await token.balanceOf(trader.address);
      await vault.connect(trader).closePosition(1n);
      const gained = (await token.balanceOf(trader.address)) - balanceBefore;

      // Payout is margin + pnl less the close fee, so strictly between the two.
      expect(gained).to.be.greaterThan(position.margin);
      expect(gained).to.be.lessThan(position.margin + pnl);
      await expectSolvent();
    });

    it("caps payout at maxPayoutMultiple of margin even on an extreme move", async () => {
      const { marketMaker, trader, vault, token, setPrice, walkPriceTo, expectSolvent } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);

      const margin = 1_000n * ONE;
      await vault.connect(trader).openPosition(true, margin, 100_000n); // 10x
      const position = await vault.positions(1n);

      await walkPriceTo(200n * ONE); // +100% spot => +1000% on 10x, far past the 3x cap

      const balanceBefore = await token.balanceOf(trader.address);
      await vault.connect(trader).closePosition(1n);
      const gained = (await token.balanceOf(trader.address)) - balanceBefore;

      const cap = (position.margin * CONFIG.maxPayoutMultipleBps) / BPS;
      expect(gained).to.be.lessThanOrEqual(cap);
      // The close fee comes out of the capped residual, so the trader receives
      // the cap less that fee -- not more, and not zero.
      expect(gained).to.be.greaterThan(cap - (position.notional * CONFIG.maxFeeBps) / BPS);
      await expectSolvent();
    });

    it("reserves market-maker capital for the payout ceiling and rejects underfunded opens", async () => {
      const { marketMaker, trader, vault, setPrice } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(1_000n * ONE);
      await setPrice(100n * ONE);

      const margin = 1_000n * ONE;
      const { reserve } = openMath(margin, 100_000n, CONFIG.baseFeeBps);
      expect(reserve).to.be.greaterThan(1_000n * ONE);

      await expect(vault.connect(trader).openPosition(true, margin, 100_000n)).to.be.revertedWithCustomError(
        vault,
        "InsufficientAvailableLiquidity"
      );
    });
  });

  describe("inventory skew", () => {
    it("skews the taker fee away from the side that worsens imbalance", async () => {
      const { marketMaker, trader, vault, setPrice } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(100_000n * ONE);
      await setPrice(100n * ONE);

      await vault.connect(trader).openPosition(true, 10_000n * ONE, 20_000n);

      const netNotional = await vault.netNotional();
      const totalLiquidity = await vault.totalLiquidity();
      const longFee = expectedFeeBps(true, netNotional, totalLiquidity);
      const shortFee = expectedFeeBps(false, netNotional, totalLiquidity);

      expect(await vault.quoteFeeBps(true)).to.equal(longFee);
      expect(await vault.quoteFeeBps(false)).to.equal(shortFee);
      expect(longFee).to.be.greaterThan(CONFIG.baseFeeBps);
      expect(shortFee).to.be.lessThan(CONFIG.baseFeeBps);
    });

    it("tracks netNotional with leverage and unwinds it on close", async () => {
      const { marketMaker, trader, vault, setPrice } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);

      await vault.connect(trader).openPosition(true, 1_000n * ONE, 50_000n);
      const long = await vault.positions(1n);
      expect(await vault.netNotional()).to.equal(long.notional);

      await vault.connect(trader).openPosition(false, 1_000n * ONE, 50_000n);
      const short = await vault.positions(2n);
      expect(await vault.netNotional()).to.equal(long.notional - short.notional);

      await vault.connect(trader).closePosition(1n);
      expect(await vault.netNotional()).to.equal(-short.notional);
    });
  });

  describe("liquidation", () => {
    it("reports a liquidation price consistent with the maintenance margin", async () => {
      const { marketMaker, trader, vault, setPrice } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);

      await vault.connect(trader).openPosition(true, 1_000n * ONE, 100_000n); // 10x
      const position = await vault.positions(1n);

      const marginRatioBps = (position.margin * BPS) / position.notional;
      const expected = (position.entryPrice * (BPS + CONFIG.maintenanceMarginBps - marginRatioBps)) / BPS;
      expect(await vault.getLiquidationPrice(1n)).to.equal(expected);

      // 10x long: liquidation sits just under a 10% adverse move.
      expect(expected).to.be.greaterThan((90n * ONE * 100n) / 100n);
      expect(expected).to.be.lessThan(96n * ONE);
    });

    it("is not liquidatable above the liquidation price, and is below it", async () => {
      const { marketMaker, trader, vault, setPrice, walkPriceTo } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);
      await vault.connect(trader).openPosition(true, 1_000n * ONE, 100_000n);

      expect(await vault.isLiquidatable(1n)).to.equal(false);

      await walkPriceTo(97n * ONE);
      expect(await vault.isLiquidatable(1n)).to.equal(false);

      await walkPriceTo(93n * ONE);
      expect(await vault.isLiquidatable(1n)).to.equal(true);
    });

    it("reverts when liquidating a healthy position", async () => {
      const { marketMaker, trader, keeper, vault, setPrice } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);
      await vault.connect(trader).openPosition(true, 1_000n * ONE, 100_000n);

      await expect(vault.connect(keeper).liquidate(1n)).to.be.revertedWithCustomError(
        vault,
        "PositionNotLiquidatable"
      );
    });

    it("pays the keeper its penalty share, refunds the remainder, and credits the MM", async () => {
      const { marketMaker, trader, keeper, vault, token, setPrice, walkPriceTo, expectSolvent } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);
      await vault.connect(trader).openPosition(true, 1_000n * ONE, 100_000n);
      const position = await vault.positions(1n);

      await walkPriceTo(93n * ONE);
      const markPrice = (await vault.getMarkPrice()) as bigint;

      const pnl = (position.notional * (markPrice - position.entryPrice)) / position.entryPrice;
      const equity = position.margin + pnl;
      expect(equity).to.be.greaterThan(0n);

      let penalty = (position.notional * CONFIG.liquidationPenaltyBps) / BPS;
      if (penalty > equity) penalty = equity;
      const liquidatorReward = (penalty * CONFIG.liquidatorShareBps) / BPS;
      const traderRefund = equity - penalty;

      const keeperBefore = await token.balanceOf(keeper.address);
      const traderBefore = await token.balanceOf(trader.address);
      const liquidityBefore = await vault.totalLiquidity();

      await expect(vault.connect(keeper).liquidate(1n))
        .to.emit(vault, "PositionLiquidated")
        .withArgs(1n, trader.address, keeper.address, markPrice, pnl, liquidatorReward, traderRefund, 0n);

      expect((await token.balanceOf(keeper.address)) - keeperBefore).to.equal(liquidatorReward);
      expect((await token.balanceOf(trader.address)) - traderBefore).to.equal(traderRefund);
      // MM collects the trader's realized loss plus its half of the penalty.
      expect((await vault.totalLiquidity()) - liquidityBefore).to.equal(
        position.margin - liquidatorReward - traderRefund
      );
      expect((await vault.positions(1n)).open).to.equal(false);
      expect(await vault.cumulativeShortfall()).to.equal(0n);
      await expectSolvent();
    });

    it("frees the position's reserved capital and netNotional on liquidation", async () => {
      const { marketMaker, trader, keeper, vault, setPrice, walkPriceTo } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);
      await vault.connect(trader).openPosition(true, 1_000n * ONE, 100_000n);

      expect(await vault.reservedLiquidity()).to.be.greaterThan(0n);
      await walkPriceTo(93n * ONE);
      await vault.connect(keeper).liquidate(1n);

      expect(await vault.reservedLiquidity()).to.equal(0n);
      expect(await vault.netNotional()).to.equal(0n);
      expect(await vault.totalMargin()).to.equal(0n);
    });

    it("records a shortfall and pays the trader nothing when a gap outruns liquidation", async () => {
      // A wide guardrail lets a single attestation gap the price straight
      // through the liquidation level, which is exactly what the oracle's
      // deviation cap exists to prevent in production.
      const { marketMaker, trader, keeper, vault, token, setPrice, expectSolvent } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);
      await vault.connect(trader).openPosition(true, 1_000n * ONE, 100_000n); // 10x
      const position = await vault.positions(1n);

      await setPrice(50n * ONE); // -50% in one step: a 10x long is far past bankrupt

      const markPrice = 50n * ONE;
      const pnl = (position.notional * (markPrice - position.entryPrice)) / position.entryPrice;
      const equity = position.margin + pnl;
      expect(equity).to.be.lessThan(0n);

      const traderBefore = await token.balanceOf(trader.address);
      const liquidityBefore = await vault.totalLiquidity();

      await expect(vault.connect(keeper).liquidate(1n))
        .to.emit(vault, "PositionLiquidated")
        .withArgs(1n, trader.address, keeper.address, markPrice, pnl, 0n, 0n, -equity);

      expect(await token.balanceOf(trader.address)).to.equal(traderBefore);
      expect(await vault.cumulativeShortfall()).to.equal(-equity);
      // The MM still collects the whole margin -- the shortfall is uncollected
      // profit, not a drain on pooled capital.
      expect((await vault.totalLiquidity()) - liquidityBefore).to.equal(position.margin);
      await expectSolvent();
    });

    it("liquidates short positions when price rises through their level", async () => {
      const { marketMaker, trader, keeper, vault, setPrice, walkPriceTo, expectSolvent } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);
      await vault.connect(trader).openPosition(false, 1_000n * ONE, 100_000n); // 10x short

      const liquidationPrice = (await vault.getLiquidationPrice(1n)) as bigint;
      expect(liquidationPrice).to.be.greaterThan(100n * ONE);

      await walkPriceTo(103n * ONE);
      expect(await vault.isLiquidatable(1n)).to.equal(false);

      await walkPriceTo(108n * ONE);
      expect(await vault.isLiquidatable(1n)).to.equal(true);
      await expect(vault.connect(keeper).liquidate(1n)).to.emit(vault, "PositionLiquidated");
      await expectSolvent();
    });

    it("still allows liquidation while the vault is paused", async () => {
      const { admin, marketMaker, trader, keeper, vault, setPrice, walkPriceTo } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);
      await vault.connect(trader).openPosition(true, 1_000n * ONE, 100_000n);
      await walkPriceTo(93n * ONE);

      await vault.connect(admin).pause();

      // New risk is blocked...
      await expect(vault.connect(trader).openPosition(true, 100n * ONE, 20_000n)).to.be.revertedWithCustomError(
        vault,
        "EnforcedPause"
      );
      // ...but the market maker can still be protected.
      await expect(vault.connect(keeper).liquidate(1n)).to.emit(vault, "PositionLiquidated");
    });

    it("reverts liquidating an already-closed position", async () => {
      const { marketMaker, trader, keeper, vault, setPrice } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);
      await vault.connect(trader).openPosition(true, 1_000n * ONE, 20_000n);
      await vault.connect(trader).closePosition(1n);

      await expect(vault.connect(keeper).liquidate(1n)).to.be.revertedWithCustomError(vault, "PositionNotOpen");
    });
  });

  describe("closing", () => {
    it("reverts closing a position you do not own", async () => {
      const { marketMaker, trader, other, vault, setPrice } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);
      await vault.connect(trader).openPosition(true, 1_000n * ONE, 20_000n);

      await expect(vault.connect(other).closePosition(1n)).to.be.revertedWithCustomError(
        vault,
        "NotPositionOwner"
      );
    });

    it("reverts closing an already-closed position", async () => {
      const { marketMaker, trader, vault, setPrice } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);
      await vault.connect(trader).openPosition(true, 1_000n * ONE, 20_000n);
      await vault.connect(trader).closePosition(1n);

      await expect(vault.connect(trader).closePosition(1n)).to.be.revertedWithCustomError(
        vault,
        "PositionNotOpen"
      );
    });

    it("lets the market maker withdraw accrued fees independent of principal", async () => {
      const { marketMaker, trader, vault, token, setPrice, expectSolvent } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);
      await vault.connect(trader).openPosition(true, 1_000n * ONE, 50_000n);

      const fees = await vault.feesAccrued();
      expect(fees).to.be.greaterThan(0n);

      const balanceBefore = await token.balanceOf(marketMaker.address);
      await vault.connect(marketMaker).withdrawFees(fees);
      expect((await token.balanceOf(marketMaker.address)) - balanceBefore).to.equal(fees);
      expect(await vault.feesAccrued()).to.equal(0n);
      await expectSolvent();
    });

    it("preserves the solvency invariant across a mixed sequence of trades", async () => {
      const { marketMaker, trader, keeper, other, vault, setPrice, walkPriceTo, expectSolvent } = await deploy();
      await vault.connect(marketMaker).depositLiquidity(500_000n * ONE);
      await setPrice(100n * ONE);

      await vault.connect(trader).openPosition(true, 5_000n * ONE, 30_000n);
      await expectSolvent();
      await vault.connect(other).openPosition(false, 3_000n * ONE, 80_000n);
      await expectSolvent();

      await walkPriceTo(112n * ONE);
      await expectSolvent();

      // The 8x short should be underwater by now; the 3x long is in profit.
      expect(await vault.isLiquidatable(2n)).to.equal(true);
      await vault.connect(keeper).liquidate(2n);
      await expectSolvent();

      await vault.connect(trader).closePosition(1n);
      await expectSolvent();

      expect(await vault.totalMargin()).to.equal(0n);
      expect(await vault.reservedLiquidity()).to.equal(0n);
      expect(await vault.netNotional()).to.equal(0n);
    });
  });

  describe("config validation", () => {
    it("rejects a maintenance margin that would make max-leverage positions instantly liquidatable", async () => {
      // 10x leverage with a 10% maintenance margin: opening equity (margin)
      // equals exactly notional * 1/10, so the position opens already at its
      // maintenance threshold.
      await expect(deploy({ maintenanceMarginBps: 1_000n })).to.be.reverted;
    });

    it("rejects a payout multiple at or below 1x", async () => {
      await expect(deploy({ maxPayoutMultipleBps: BPS })).to.be.reverted;
    });

    it("rejects a base fee above the fee ceiling", async () => {
      await expect(deploy({ baseFeeBps: 2_000n, maxFeeBps: 1_000n })).to.be.reverted;
    });
  });
});
