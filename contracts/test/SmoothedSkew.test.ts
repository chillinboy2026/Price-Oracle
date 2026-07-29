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
const HOUR = 3_600;

const CONFIG = {
  baseFeeBps: 100n,
  maxFeeBps: 1000n,
  skewSensitivityBps: 10_000n,
  maxPayoutMultipleBps: 30_000n,
  maxLeverageBps: 100_000n,
  maintenanceMarginBps: 500n,
  liquidationPenaltyBps: 200n,
  liquidatorShareBps: 5_000n,
  skewSmoothingWindow: 24n * 3_600n, // 24h
};

describe("smoothed inventory skew", function () {
  async function deploy(overrides: Partial<typeof CONFIG> = {}) {
    const [admin, marketMaker, trader, other] = await ethers.getSigners();
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
      maxStaleness: 86_400 * 30,
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

    for (const account of [marketMaker, trader, other]) {
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

    await vault.connect(marketMaker).depositLiquidity(1_000_000n * ONE);
    await setPrice(100n * ONE);

    return { admin, marketMaker, trader, other, vault, setPrice, advance };
  }

  it("starts at the instantaneous skew when nothing has accrued", async () => {
    const { vault } = await deploy();
    expect(await vault.getSmoothedSkewBps()).to.equal(await vault.getInventorySkewBps());
  });

  it("converges toward sustained positioning over the smoothing window", async () => {
    const { vault, trader, advance } = await deploy();
    await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);

    const instant = await vault.getInventorySkewBps();
    expect(instant).to.be.greaterThan(0n);

    // Immediately after the trade the smoothed value has barely moved.
    const atOpen = await vault.getSmoothedSkewBps();
    expect(atOpen).to.be.lessThan(instant / 2n);

    // A quarter of the way through the window it is partway there.
    await advance(6 * HOUR);
    const quarter = await vault.getSmoothedSkewBps();
    expect(quarter).to.be.greaterThan(atOpen);
    expect(quarter).to.be.lessThan(instant);

    // Past the full window it has caught up.
    await advance(24 * HOUR);
    expect(await vault.getSmoothedSkewBps()).to.equal(instant);
  });

  it("largely ignores a position opened and closed quickly", async () => {
    const { vault, trader, advance } = await deploy();

    await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);
    await advance(HOUR); // held for 1h of a 24h window
    await vault.connect(trader).closePosition(1n);

    // The spike barely registers: this is what stops a single large,
    // short-lived position from being read as genuine sustained demand.
    const smoothed = await vault.getSmoothedSkewBps();
    expect(smoothed).to.be.lessThan(300n);
    expect(await vault.getInventorySkewBps()).to.equal(0n);
  });

  it("registers the same position held for a long time", async () => {
    const { vault, trader, advance } = await deploy();

    await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);
    const instant = await vault.getInventorySkewBps();
    await advance(30 * 24 * HOUR); // held a month
    await vault.connect(trader).closePosition(1n);

    // Closing banks the long-held skew rather than erasing it.
    const smoothed = await vault.getSmoothedSkewBps();
    expect(smoothed).to.be.greaterThan((instant * 9n) / 10n);
  });

  it("decays back toward neutral once positioning unwinds", async () => {
    const { vault, trader, advance } = await deploy();
    await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);
    await advance(30 * 24 * HOUR);
    await vault.connect(trader).closePosition(1n);

    const justAfterClose = await vault.getSmoothedSkewBps();
    expect(justAfterClose).to.be.greaterThan(0n);

    await advance(30 * 24 * HOUR);
    expect(await vault.getSmoothedSkewBps()).to.equal(0n);
  });

  it("tracks net positioning, so offsetting flow reads as near-zero demand", async () => {
    const { vault, trader, other, advance } = await deploy();

    await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);
    const oneSided = await vault.getInventorySkewBps();

    await vault.connect(other).openPosition(false, 50_000n * ONE, 50_000n);
    await advance(30 * 24 * HOUR);

    // Heavy two-way volume with no net lean is not demand. It does not land at
    // exactly zero, because the second trade is on the balancing side and so
    // pays a discounted fee -- leaving it marginally more notional than the
    // first. That asymmetry is the fee mechanism working as intended.
    const smoothed = await vault.getSmoothedSkewBps();
    expect(smoothed).to.be.lessThan(0n); // slightly net short, from the discount
    expect(smoothed > 0n ? smoothed : -smoothed).to.be.lessThan(oneSided / 5n);
  });

  it("reads identically for every caller at the same block", async () => {
    const { vault, trader, advance } = await deploy();
    await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);
    await advance(5 * HOUR);

    // Determinism is what lets independent reporters threshold-sign one price:
    // a per-node local moving average could never converge.
    const a = await vault.getSmoothedSkewBps();
    const b = await vault.getSmoothedSkewBps();
    expect(a).to.equal(b);
  });

  it("advances without trading when poked", async () => {
    const { vault, trader, advance } = await deploy();
    await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);
    await advance(12 * HOUR);

    const before = await vault.smoothedSkewBps();
    await vault.pokeSkew();
    const after = await vault.smoothedSkewBps();

    expect(after).to.be.greaterThan(before);
    // The stored value now matches what the view was already reporting.
    expect(after).to.equal(await vault.getSmoothedSkewBps());
  });

  it("is inert when smoothing is disabled", async () => {
    const { vault, trader } = await deploy({ skewSmoothingWindow: 0n });
    await vault.connect(trader).openPosition(true, 50_000n * ONE, 50_000n);

    expect(await vault.getSmoothedSkewBps()).to.equal(await vault.getInventorySkewBps());
  });
});
