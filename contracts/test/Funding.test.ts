import { expect } from "chai";
import { ethers } from "hardhat";
import { Wallet } from "ethers";
import {
  MarketSession,
  PriceAttestation,
  domainFor,
  signAttestationByAll,
} from "./helpers/attestation";

const ASSET_ID = ethers.keccak256(ethers.toUtf8Bytes("ACME"));
const ONE = 10n ** 18n;
const BPS = 10_000n;
const HOUR = 3_600;
const DAY = 24 * HOUR;

const CONFIG = {
  baseFeeBps: 100n,
  maxFeeBps: 1000n,
  skewSensitivityBps: 10_000n,
  maxPayoutMultipleBps: 30_000n,
  maxLeverageBps: 100_000n,
  maintenanceMarginBps: 500n,
  liquidationPenaltyBps: 200n,
  liquidatorShareBps: 5_000n,
  // Smoothing off by default so funding starts at full strength immediately
  // and the arithmetic in these tests is exact.
  skewSmoothingWindow: 0n,
  fundingCoefficientBps: 1_000n, // 10% of skew becomes the daily rate
  maxFundingRateBpsPerDay: 200n, // capped at 2%/day
};

describe("funding rate", function () {
  async function deploy(overrides: Partial<typeof CONFIG> = {}) {
    const [admin, marketMaker, trader, other, keeper] = await ethers.getSigners();
    const reporter = Wallet.createRandom();

    const Oracle = await ethers.getContractFactory("PriceOracle", admin);
    const oracle = await Oracle.deploy(admin.address);
    await oracle.waitForDeployment();
    await oracle.grantRole(await oracle.REPORTER_ROLE(), reporter.address);
    await oracle.registerAsset(ASSET_ID, {
      registered: true,
      threshold: 1,
      maxDeviationBpsLive: 9_999,
      maxDeviationBpsOffHours: 9_999,
      maxStaleness: 86_400 * 365,
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
      { ...CONFIG, ...overrides }
    );
    await vault.waitForDeployment();

    for (const account of [marketMaker, trader, other, keeper]) {
      await token.mint(account.address, 10_000_000n * ONE);
      await token.connect(account).approve(await vault.getAddress(), ethers.MaxUint256);
    }

    let nonce = 0n;
    async function setPrice(price: bigint) {
      nonce += 1n;
      const block = await ethers.provider.getBlock("latest");
      const attestation: PriceAttestation = {
        assetId: ASSET_ID,
        price,
        timestamp: BigInt(block!.timestamp),
        session: MarketSession.LIVE,
        confidenceBps: 10n,
        nonce,
      };
      await oracle.updatePrice(attestation, await signAttestationByAll([reporter], domain, attestation));
    }

    async function advance(seconds: number) {
      await ethers.provider.send("evm_increaseTime", [seconds]);
      await ethers.provider.send("evm_mine", []);
    }

    async function expectSolvent() {
      expect(await vault.solvencyInvariantHolds()).to.equal(true);
    }

    await vault.connect(marketMaker).depositLiquidity(1_000_000n * ONE);
    await setPrice(100n * ONE);

    return { admin, marketMaker, trader, other, keeper, vault, token, setPrice, advance, expectSolvent };
  }

  describe("rate", () => {
    it("is zero when the book is balanced", async () => {
      const { vault } = await deploy();
      expect(await vault.currentFundingRateBpsPerDay()).to.equal(0n);
    });

    it("scales with skew and is signed by which side is crowded", async () => {
      const { vault, trader } = await deploy();
      await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);

      const skew = await vault.getSmoothedSkewBps();
      expect(skew).to.be.greaterThan(0n);
      expect(await vault.currentFundingRateBpsPerDay()).to.equal(
        (skew * CONFIG.fundingCoefficientBps) / BPS
      );
    });

    it("clamps at the configured ceiling in both directions", async () => {
      const { vault, trader, other } = await deploy({ fundingCoefficientBps: 10_000n });

      await vault.connect(trader).openPosition(true, 200_000n * ONE, 50_000n);
      expect(await vault.currentFundingRateBpsPerDay()).to.equal(CONFIG.maxFundingRateBpsPerDay);

      await vault.connect(trader).closePosition(1n);
      await vault.connect(other).openPosition(false, 200_000n * ONE, 50_000n);
      expect(await vault.currentFundingRateBpsPerDay()).to.equal(-CONFIG.maxFundingRateBpsPerDay);
    });

    it("is inert when funding is disabled", async () => {
      const { vault, trader, advance } = await deploy({ fundingCoefficientBps: 0n, maxFundingRateBpsPerDay: 0n });
      await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);
      await advance(30 * DAY);

      expect(await vault.currentFundingRateBpsPerDay()).to.equal(0n);
      expect(await vault.fundingOwed(1n)).to.equal(0n);
    });

    it("rejects a config with a runaway rate ceiling", async () => {
      await expect(deploy({ maxFundingRateBpsPerDay: 10_000n })).to.be.reverted;
      await expect(deploy({ fundingCoefficientBps: 1_000n, maxFundingRateBpsPerDay: 0n })).to.be.reverted;
    });
  });

  describe("accrual", () => {
    it("charges the crowded side over time", async () => {
      const { vault, trader, advance } = await deploy();
      await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);

      expect(await vault.fundingOwed(1n)).to.equal(0n); // nothing yet at open

      await advance(DAY);
      const afterOneDay = await vault.fundingOwed(1n);
      expect(afterOneDay).to.be.greaterThan(0n);

      await advance(DAY);
      const afterTwoDays = await vault.fundingOwed(1n);
      // Linear in time at a constant rate.
      expect(afterTwoDays).to.be.closeTo(afterOneDay * 2n, afterOneDay / 100n);
    });

    it("matches the rate x notional x elapsed-days formula", async () => {
      const { vault, trader, advance } = await deploy();
      await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);
      const position = await vault.positions(1n);
      const rate = await vault.currentFundingRateBpsPerDay();

      await advance(DAY);
      const expected = (position.notional * rate) / BPS;
      expect(await vault.fundingOwed(1n)).to.be.closeTo(expected, expected / 1_000n);
    });

    it("pays the balancing side", async () => {
      const { vault, trader, other, advance } = await deploy();
      // Trader crowds the long side...
      await vault.connect(trader).openPosition(true, 200_000n * ONE, 50_000n);
      // ...and a smaller short leans against it.
      await vault.connect(other).openPosition(false, 20_000n * ONE, 50_000n);

      await advance(5 * DAY);

      expect(await vault.fundingOwed(1n)).to.be.greaterThan(0n); // long pays
      expect(await vault.fundingOwed(2n)).to.be.lessThan(0n); // short receives
    });

    it("charges a position only for funding after it opened", async () => {
      const { vault, trader, other, advance } = await deploy();
      await vault.connect(trader).openPosition(true, 100_000n * ONE, 50_000n);
      await advance(10 * DAY);

      // A second long opening now inherits none of the prior 10 days.
      await vault.connect(other).openPosition(true, 100_000n * ONE, 50_000n);
      expect(await vault.fundingOwed(2n)).to.equal(0n);
      expect(await vault.fundingOwed(1n)).to.be.greaterThan(0n);
    });

    it("advances without trading when poked", async () => {
      const { vault, trader, advance } = await deploy();
      await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);
      await advance(3 * DAY);

      const before = await vault.cumulativeFundingBps();
      await vault.poke();
      expect(await vault.cumulativeFundingBps()).to.be.greaterThan(before);
      expect(await vault.cumulativeFundingBps()).to.equal(await vault.cumulativeFundingBpsNow());
    });
  });

  describe("effect on the position", () => {
    it("erodes equity even with the price unchanged", async () => {
      const { vault, trader, advance } = await deploy();
      await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);

      const equityAtOpen = await vault.getPositionEquity(1n);
      await advance(10 * DAY);
      const equityLater = await vault.getPositionEquity(1n);

      // Price never moved; the entire difference is carry.
      expect(equityLater).to.be.lessThan(equityAtOpen);
      expect(equityAtOpen - equityLater).to.equal(await vault.fundingOwed(1n));
    });

    it("walks the liquidation price toward the mark as carry accrues", async () => {
      const { vault, trader, advance } = await deploy();
      await vault.connect(trader).openPosition(true, 50_000n * ONE, 100_000n);

      const atOpen = await vault.getLiquidationPrice(1n);
      await advance(20 * DAY);
      const later = await vault.getLiquidationPrice(1n);

      // A long's liquidation price rises: holding the crowded side is not free.
      expect(later).to.be.greaterThan(atOpen);
    });

    it("can push a position into liquidation on carry alone", async () => {
      const { vault, trader, keeper, advance } = await deploy({
        fundingCoefficientBps: 10_000n,
        maxFundingRateBpsPerDay: 500n, // 5%/day
      });
      await vault.connect(trader).openPosition(true, 100_000n * ONE, 100_000n);

      expect(await vault.isLiquidatable(1n)).to.equal(false);

      // Price never moves; the position simply becomes unaffordable to hold.
      await advance(60 * DAY);
      expect(await vault.isLiquidatable(1n)).to.equal(true);
      await expect(vault.connect(keeper).liquidate(1n)).to.emit(vault, "PositionLiquidated");
    });
  });

  describe("settlement", () => {
    it("deducts accrued funding from a closing trader's payout", async () => {
      const { vault, trader, token, advance, expectSolvent } = await deploy();
      await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);
      await advance(10 * DAY);

      const owed = await vault.fundingOwed(1n);
      expect(owed).to.be.greaterThan(0n);

      const before = await token.balanceOf(trader.address);
      await vault.connect(trader).closePosition(1n);
      const received = (await token.balanceOf(trader.address)) - before;
      const position = await vault.positions(1n);

      // Price unchanged, so the shortfall against margin is funding plus the
      // close fee -- nothing else.
      expect(received).to.be.lessThan(position.margin);
      await expectSolvent();
    });

    it("credits funding paid by the crowded side to market-maker capital", async () => {
      const { vault, trader, advance, expectSolvent } = await deploy();
      await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);
      await advance(10 * DAY);

      const owed = await vault.fundingOwed(1n);
      const liquidityBefore = await vault.totalLiquidity();
      await vault.connect(trader).closePosition(1n);
      const gained = (await vault.totalLiquidity()) - liquidityBefore;

      // With a single position there is no counterparty to pay, so the whole
      // amount accrues to the MM, who is carrying the net exposure.
      expect(gained).to.be.greaterThanOrEqual(owed);
      await expectSolvent();
    });

    it("conserves value across an unbalanced long/short pair", async () => {
      const { vault, trader, other, token, advance, expectSolvent } = await deploy();
      await vault.connect(trader).openPosition(true, 200_000n * ONE, 50_000n);
      await vault.connect(other).openPosition(false, 20_000n * ONE, 50_000n);
      await advance(10 * DAY);

      const longOwed = await vault.fundingOwed(1n);
      const shortOwed = await vault.fundingOwed(2n);
      expect(longOwed).to.be.greaterThan(0n);
      expect(shortOwed).to.be.lessThan(0n);
      // The long side is larger, so longs pay more than shorts receive; the
      // surplus is the MM's compensation for the net short exposure it holds.
      expect(longOwed).to.be.greaterThan(-shortOwed);

      const shortBefore = await token.balanceOf(other.address);
      await vault.connect(other).closePosition(2n);
      const shortReceived = (await token.balanceOf(other.address)) - shortBefore;
      const shortPosition = await vault.positions(2n);

      // The balancing side is paid to be there: it gets back more than its
      // margin despite no price move, net of its close fee.
      expect(shortReceived).to.be.greaterThan(
        shortPosition.margin - (shortPosition.notional * CONFIG.maxFeeBps) / BPS
      );

      await vault.connect(trader).closePosition(1n);
      await expectSolvent();
      expect(await vault.totalMargin()).to.equal(0n);
    });

    it("settles funding through liquidation as well as normal close", async () => {
      const { vault, trader, keeper, advance, expectSolvent } = await deploy({
        fundingCoefficientBps: 10_000n,
        maxFundingRateBpsPerDay: 500n,
      });
      await vault.connect(trader).openPosition(true, 100_000n * ONE, 100_000n);
      await advance(60 * DAY);

      const liquidityBefore = await vault.totalLiquidity();
      await vault.connect(keeper).liquidate(1n);

      // Everything the trader could not afford to carry ends up with the MM
      // and the keeper, not lost.
      expect(await vault.totalLiquidity()).to.be.greaterThan(liquidityBefore);
      await expectSolvent();
      expect(await vault.totalMargin()).to.equal(0n);
    });

    it("holds the solvency invariant across a mixed funded sequence", async () => {
      const { vault, trader, other, keeper, advance, expectSolvent, setPrice } = await deploy();

      await vault.connect(trader).openPosition(true, 150_000n * ONE, 40_000n);
      await expectSolvent();
      await advance(7 * DAY);

      await vault.connect(other).openPosition(false, 60_000n * ONE, 60_000n);
      await expectSolvent();
      await advance(14 * DAY);

      await setPrice(94n * ONE);
      await expectSolvent();

      if (await vault.isLiquidatable(1n)) {
        await vault.connect(keeper).liquidate(1n);
      } else {
        await vault.connect(trader).closePosition(1n);
      }
      await expectSolvent();

      await vault.connect(other).closePosition(2n);
      await expectSolvent();

      expect(await vault.totalMargin()).to.equal(0n);
      expect(await vault.reservedLiquidity()).to.equal(0n);
      expect(await vault.netNotional()).to.equal(0n);
    });
  });

  describe("interaction with smoothing", () => {
    it("ramps in gradually rather than charging a brand-new imbalance in full", async () => {
      const { vault, trader, advance } = await deploy({ skewSmoothingWindow: BigInt(7 * DAY) });
      await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);

      await advance(DAY);
      const firstDay = await vault.fundingOwed(1n);

      // By the second week the smoothed skew has caught up, so the same
      // elapsed time costs materially more.
      await advance(14 * DAY);
      await vault.poke();
      const beforeLastDay = await vault.fundingOwed(1n);
      await advance(DAY);
      const lastDay = (await vault.fundingOwed(1n)) - beforeLastDay;

      expect(lastDay).to.be.greaterThan(firstDay);
    });

    it("barely charges a position that is closed again quickly", async () => {
      const { vault, trader, advance } = await deploy({ skewSmoothingWindow: BigInt(7 * DAY) });
      await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);
      await advance(HOUR);

      const owed = await vault.fundingOwed(1n);
      const position = await vault.positions(1n);
      // Well under a basis point of notional: a brief visit costs almost nothing.
      expect(owed).to.be.lessThan(position.notional / 10_000n);
    });
  });
});
