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

const BASE_FEE_BPS = 100n; // 1%
const MAX_FEE_BPS = 1000n; // 10%
const SKEW_SENSITIVITY_BPS = 10_000n;
const MAX_PAYOUT_MULTIPLE_BPS = 20_000n; // 2x

function clampBps(v: bigint, cap: bigint): bigint {
  if (v > cap) return cap;
  if (v < -cap) return -cap;
  return v;
}

function expectedSkewBps(netNotional: bigint, totalLiquidity: bigint): bigint {
  if (totalLiquidity === 0n) return 0n;
  return clampBps((netNotional * SKEW_SENSITIVITY_BPS) / totalLiquidity, MAX_FEE_BPS);
}

function expectedFeeBps(isLong: boolean, netNotional: bigint, totalLiquidity: bigint): bigint {
  const skew = expectedSkewBps(netNotional, totalLiquidity);
  const penalty = isLong ? skew : -skew;
  let fee = BASE_FEE_BPS + penalty;
  if (fee < 0n) fee = 0n;
  if (fee > MAX_FEE_BPS) fee = MAX_FEE_BPS;
  return fee;
}

describe("MarketMakerVault", function () {
  async function deploy() {
    const [admin, marketMaker, trader, other] = await ethers.getSigners();
    const reporter = Wallet.createRandom();

    const Oracle = await ethers.getContractFactory("PriceOracle", admin);
    const oracle = await Oracle.deploy(admin.address);
    await oracle.waitForDeployment();
    const REPORTER_ROLE = await oracle.REPORTER_ROLE();
    await oracle.grantRole(REPORTER_ROLE, reporter.address);
    await oracle.registerAsset(ASSET_ID, {
      registered: true,
      threshold: 1,
      maxDeviationBpsLive: 5000,
      maxDeviationBpsOffHours: 5000,
      maxStaleness: 86_400,
      minPrice: 0,
      maxPrice: 0,
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
      BASE_FEE_BPS,
      MAX_FEE_BPS,
      SKEW_SENSITIVITY_BPS,
      MAX_PAYOUT_MULTIPLE_BPS
    );
    await vault.waitForDeployment();

    await token.mint(marketMaker.address, 1_000_000n * ONE);
    await token.mint(trader.address, 100_000n * ONE);
    await token.connect(marketMaker).approve(await vault.getAddress(), ethers.MaxUint256);
    await token.connect(trader).approve(await vault.getAddress(), ethers.MaxUint256);

    async function setPrice(price: bigint, nonce: bigint, session = MarketSession.LIVE) {
      const block = await ethers.provider.getBlock("latest");
      const attestation: PriceAttestation = {
        assetId: ASSET_ID,
        price,
        timestamp: BigInt(block!.timestamp),
        session,
        confidenceBps: 10n,
        nonce,
      };
      const sigs = await signAttestationByAll([reporter], domain, attestation);
      await oracle.updatePrice(attestation, sigs);
    }

    return { admin, marketMaker, trader, other, oracle, token, vault, setPrice };
  }

  it("lets the market maker deposit and withdraw liquidity", async () => {
    const { marketMaker, vault } = await deploy();
    await expect(vault.connect(marketMaker).depositLiquidity(100_000n * ONE))
      .to.emit(vault, "LiquidityDeposited")
      .withArgs(marketMaker.address, 100_000n * ONE);
    expect(await vault.totalLiquidity()).to.equal(100_000n * ONE);

    await vault.connect(marketMaker).withdrawLiquidity(40_000n * ONE);
    expect(await vault.totalLiquidity()).to.equal(60_000n * ONE);
  });

  it("rejects deposits/withdrawals from a non-market-maker", async () => {
    const { other, vault } = await deploy();
    await expect(vault.connect(other).depositLiquidity(1n * ONE)).to.be.reverted;
  });

  it("opens a long position at the base fee when the book is balanced", async () => {
    const { marketMaker, trader, vault, setPrice } = await deploy();
    await vault.connect(marketMaker).depositLiquidity(100_000n * ONE);
    await setPrice(100n * ONE, 1n);

    const margin = 1_000n * ONE;
    const expectedFee = expectedFeeBps(true, 0n, 100_000n * ONE);
    expect(expectedFee).to.equal(BASE_FEE_BPS);

    const feeAmount = (margin * expectedFee) / BPS;
    const notional = margin - feeAmount;

    await expect(vault.connect(trader).openPosition(true, margin))
      .to.emit(vault, "PositionOpened")
      .withArgs(1n, trader.address, true, notional, 100n * ONE, expectedFee);

    expect(await vault.netNotional()).to.equal(notional);
    expect(await vault.feesAccrued()).to.equal(feeAmount);
  });

  it("skews the taker fee away from the side that worsens inventory imbalance", async () => {
    const { marketMaker, trader, vault, setPrice } = await deploy();
    await vault.connect(marketMaker).depositLiquidity(100_000n * ONE);
    await setPrice(100n * ONE, 1n);

    await vault.connect(trader).openPosition(true, 10_000n * ONE);

    const netNotional = await vault.netNotional();
    const totalLiquidity = await vault.totalLiquidity();

    const longFee = expectedFeeBps(true, netNotional, totalLiquidity);
    const shortFee = expectedFeeBps(false, netNotional, totalLiquidity);

    expect(await vault.quoteFeeBps(true)).to.equal(longFee);
    expect(await vault.quoteFeeBps(false)).to.equal(shortFee);
    expect(longFee).to.be.greaterThan(BASE_FEE_BPS);
    expect(shortFee).to.be.lessThan(BASE_FEE_BPS);
  });

  it("settles a profitable long close out of pooled liquidity", async () => {
    const { marketMaker, trader, vault, token, setPrice } = await deploy();
    await vault.connect(marketMaker).depositLiquidity(100_000n * ONE);
    await setPrice(100n * ONE, 1n);

    const margin = 1_000n * ONE;
    await vault.connect(trader).openPosition(true, margin);
    const position = await vault.positions(1n);

    await setPrice(110n * ONE, 2n); // +10%

    const netNotionalBeforeClose = await vault.netNotional();
    const totalLiquidityBeforeClose = await vault.totalLiquidity();
    const closeFeeBps = expectedFeeBps(false, netNotionalBeforeClose, totalLiquidityBeforeClose);

    const notional = position.notional;
    const entryPrice = position.entryPrice;
    const exitPrice = 110n * ONE;
    const pnl = (notional * (exitPrice - entryPrice)) / entryPrice;
    const closeFee = (notional * closeFeeBps) / BPS;
    let payout = notional + pnl - closeFee;
    const cap = (notional * MAX_PAYOUT_MULTIPLE_BPS) / BPS;
    if (payout > cap) payout = cap;

    const balanceBefore = await token.balanceOf(trader.address);
    await expect(vault.connect(trader).closePosition(1n))
      .to.emit(vault, "PositionClosed")
      .withArgs(1n, trader.address, exitPrice, pnl, payout, closeFeeBps);
    const balanceAfter = await token.balanceOf(trader.address);

    expect(balanceAfter - balanceBefore).to.equal(payout);
    expect((await vault.positions(1n)).open).to.equal(false);
  });

  it("reverts opening a position that would exceed available liquidity", async () => {
    const { marketMaker, trader, vault, setPrice } = await deploy();
    await vault.connect(marketMaker).depositLiquidity(1_000n * ONE);
    await setPrice(100n * ONE, 1n);

    // notional*2x reserve for a 10,000 margin position vastly exceeds 1,000 liquidity.
    await expect(vault.connect(trader).openPosition(true, 10_000n * ONE)).to.be.revertedWithCustomError(
      vault,
      "InsufficientAvailableLiquidity"
    );
  });

  it("blocks withdrawing liquidity that is reserved against open positions", async () => {
    const { marketMaker, trader, vault, setPrice } = await deploy();
    await vault.connect(marketMaker).depositLiquidity(10_000n * ONE);
    await setPrice(100n * ONE, 1n);
    await vault.connect(trader).openPosition(true, 1_000n * ONE);

    const available = await vault.availableLiquidity();
    await expect(vault.connect(marketMaker).withdrawLiquidity(available + 1n)).to.be.revertedWithCustomError(
      vault,
      "InsufficientAvailableLiquidity"
    );
    await expect(vault.connect(marketMaker).withdrawLiquidity(available)).to.not.be.reverted;
  });

  it("reverts closing a position you do not own", async () => {
    const { marketMaker, trader, other, vault, setPrice } = await deploy();
    await vault.connect(marketMaker).depositLiquidity(10_000n * ONE);
    await setPrice(100n * ONE, 1n);
    await vault.connect(trader).openPosition(true, 1_000n * ONE);

    await expect(vault.connect(other).closePosition(1n)).to.be.revertedWithCustomError(
      vault,
      "NotPositionOwner"
    );
  });

  it("reverts closing an already-closed position", async () => {
    const { marketMaker, trader, vault, setPrice } = await deploy();
    await vault.connect(marketMaker).depositLiquidity(10_000n * ONE);
    await setPrice(100n * ONE, 1n);
    await vault.connect(trader).openPosition(true, 1_000n * ONE);
    await vault.connect(trader).closePosition(1n);

    await expect(vault.connect(trader).closePosition(1n)).to.be.revertedWithCustomError(
      vault,
      "PositionNotOpen"
    );
  });

  it("lets the market maker withdraw accrued fees independent of principal", async () => {
    const { marketMaker, trader, vault, token, setPrice } = await deploy();
    await vault.connect(marketMaker).depositLiquidity(10_000n * ONE);
    await setPrice(100n * ONE, 1n);
    await vault.connect(trader).openPosition(true, 1_000n * ONE);

    const fees = await vault.feesAccrued();
    expect(fees).to.be.greaterThan(0n);

    const balanceBefore = await token.balanceOf(marketMaker.address);
    await vault.connect(marketMaker).withdrawFees(fees);
    const balanceAfter = await token.balanceOf(marketMaker.address);
    expect(balanceAfter - balanceBefore).to.equal(fees);
    expect(await vault.feesAccrued()).to.equal(0n);
  });
});
