import { expect } from "chai";
import { ethers } from "hardhat";
import { Wallet } from "ethers";
import { AnchorAttestation, AnchorKind, anchorDomainFor, signAnchorByAll } from "./helpers/anchorAttestation";
import {
  MarketSession,
  PriceAttestation,
  domainFor,
  signAttestationByAll,
} from "./helpers/attestation";

const ASSET_ID = ethers.keccak256(ethers.toUtf8Bytes("ACME-PREIPO"));
const COMP_INDEX_ID = ethers.keccak256(ethers.toUtf8Bytes("COMPS:SAAS"));
const COMMON = ethers.keccak256(ethers.toUtf8Bytes("COMMON"));
const ONE = 10n ** 18n;
const BPS = 10_000n;

/** Mirrors AnchorRegistry.currentCompAdjustmentBps and the off-chain
 * compsAdjustmentFactor, so the test asserts against an independent
 * derivation of the same convention rather than reading the contract back. */
function expectedAdjustmentBps(
  indexNow: bigint,
  indexAtAnchor: bigint,
  betaBps: bigint,
  maxAdjBps: bigint
): bigint {
  const ratioBps = (indexNow * BPS) / indexAtAnchor;
  const deltaBps = ratioBps - BPS;
  let adj = BPS + (betaBps * deltaBps) / BPS;
  if (adj < BPS - maxAdjBps) adj = BPS - maxAdjBps;
  if (adj > BPS + maxAdjBps) adj = BPS + maxAdjBps;
  return adj;
}

describe("comparables-tracked anchor band", function () {
  async function deploy(configOverrides: Record<string, unknown> = {}) {
    const [admin] = await ethers.getSigners();
    const reporters = [Wallet.createRandom(), Wallet.createRandom()];
    const attestors = [Wallet.createRandom(), Wallet.createRandom()];

    const Oracle = await ethers.getContractFactory("PriceOracle", admin);
    const oracle = await Oracle.deploy(admin.address);
    await oracle.waitForDeployment();
    const REPORTER_ROLE = await oracle.REPORTER_ROLE();
    for (const r of reporters) await oracle.grantRole(REPORTER_ROLE, r.address);

    const Registry = await ethers.getContractFactory("AnchorRegistry", admin);
    const registry = await Registry.deploy(admin.address, await oracle.getAddress());
    await registry.waitForDeployment();
    const ATTESTOR_ROLE = await registry.ATTESTOR_ROLE();
    for (const a of attestors) await registry.grantRole(ATTESTOR_ROLE, a.address);

    await registry.registerAsset(ASSET_ID, {
      registered: true,
      threshold: 2,
      bandWideningBpsPerDay: 10,
      maxBandBps: 5_000,
      shareClass: COMMON,
      compIndexAssetId: COMP_INDEX_ID,
      betaBps: 12_000, // 1.2x the basket
      maxCompAdjustmentBps: 5_000, // comps alone may move the center +/-50%
      ...configOverrides,
    });

    // The comps index is published as an ordinary oracle asset. It has no
    // anchorBand of its own -- binding an index to a band would be circular.
    await oracle.registerAsset(COMP_INDEX_ID, {
      registered: true,
      threshold: 2,
      maxDeviationBpsLive: 9_000,
      maxDeviationBpsOffHours: 9_000,
      maxStaleness: 86_400,
      minPrice: 0,
      maxPrice: 0,
      anchorBand: ethers.ZeroAddress,
    });

    // The pre-IPO asset is bound to the registry.
    await oracle.registerAsset(ASSET_ID, {
      registered: true,
      threshold: 2,
      maxDeviationBpsLive: 9_000,
      maxDeviationBpsOffHours: 9_000,
      maxStaleness: 86_400,
      minPrice: 0,
      maxPrice: 0,
      anchorBand: await registry.getAddress(),
    });

    const network = await ethers.provider.getNetwork();
    const oracleDomain = domainFor(network.chainId, await oracle.getAddress());
    const registryDomain = anchorDomainFor(network.chainId, await registry.getAddress());

    let indexNonce = 0n;
    async function setCompIndex(value: bigint) {
      indexNonce += 1n;
      const block = await ethers.provider.getBlock("latest");
      const attestation: PriceAttestation = {
        assetId: COMP_INDEX_ID,
        price: value,
        timestamp: BigInt(block!.timestamp),
        session: MarketSession.LIVE,
        confidenceBps: 10n,
        nonce: indexNonce,
      };
      await oracle.updatePrice(attestation, await signAttestationByAll(reporters, oracleDomain, attestation));
    }

    /** The comps index is an ordinary oracle asset, so it inherits the
     * per-update deviation guardrail: it cannot be teleported in one print
     * any more than any other price can. Steps are multiplicative rather than
     * linear because the guardrail is a *relative* bound -- linear steps toward
     * a much lower target blow through it as the price gets small. */
    async function walkCompIndexTo(target: bigint, maxStepBps = 2_000n) {
      let [current] = await oracle.getPrice(COMP_INDEX_ID);
      while (current !== target) {
        let next: bigint;
        if (target > current) {
          const ceiling = current + (current * maxStepBps) / BPS;
          next = target < ceiling ? target : ceiling;
        } else {
          const floor = current - (current * maxStepBps) / BPS;
          next = target > floor ? target : floor;
        }
        await setCompIndex(next);
        current = next;
      }
    }

    let anchorNonce = 0n;
    async function recordAnchor(pricePerShare: bigint, compIndexAtEffective: bigint) {
      anchorNonce += 1n;
      const block = await ethers.provider.getBlock("latest");
      const attestation: AnchorAttestation = {
        assetId: ASSET_ID,
        kind: AnchorKind.PRICED_ROUND,
        pricePerShare,
        shareClass: COMMON,
        effectiveAt: BigInt(block!.timestamp),
        impliedValuation: 0n,
        bandBps: 1_500n,
        compIndexAtEffective,
        documentHash: ethers.ZeroHash,
        nonce: anchorNonce,
      };
      await registry.recordAnchor(attestation, await signAnchorByAll(attestors, registryDomain, attestation));
    }

    let priceNonce = 0n;
    async function publishPrice(price: bigint) {
      priceNonce += 1n;
      const block = await ethers.provider.getBlock("latest");
      const attestation: PriceAttestation = {
        assetId: ASSET_ID,
        price,
        timestamp: BigInt(block!.timestamp),
        session: MarketSession.OFF_HOURS,
        confidenceBps: 900n,
        nonce: priceNonce,
      };
      return oracle.updatePrice(attestation, await signAttestationByAll(reporters, oracleDomain, attestation));
    }

    return { admin, oracle, registry, setCompIndex, walkCompIndexTo, recordAnchor, publishPrice };
  }

  it("leaves the center unadjusted before the comps index has ever been published", async () => {
    const { registry, recordAnchor } = await deploy();
    await recordAnchor(20n * ONE, ONE);

    // Soft failure by design: reverting here would freeze the asset's price
    // entirely rather than merely un-tracking comps.
    expect(await registry.currentCompAdjustmentBps(ASSET_ID)).to.equal(BPS);
    expect(await registry.currentCenter(ASSET_ID)).to.equal(20n * ONE);
  });

  it("leaves the center unadjusted when the anchor predates comps tracking", async () => {
    const { registry, setCompIndex, recordAnchor } = await deploy();
    await setCompIndex(ONE);
    await recordAnchor(20n * ONE, 0n); // no index level recorded
    await setCompIndex(15n * ONE / 10n);

    expect(await registry.currentCompAdjustmentBps(ASSET_ID)).to.equal(BPS);
    expect(await registry.currentCenter(ASSET_ID)).to.equal(20n * ONE);
  });

  it("carries the anchor forward when comps rally, scaled by beta", async () => {
    const { registry, setCompIndex, recordAnchor } = await deploy();
    await setCompIndex(ONE);
    await recordAnchor(20n * ONE, ONE);

    // Comps +25%; beta 1.2 -> center moves +30%.
    await setCompIndex((125n * ONE) / 100n);

    const expected = expectedAdjustmentBps((125n * ONE) / 100n, ONE, 12_000n, 5_000n);
    expect(expected).to.equal(13_000n);
    expect(await registry.currentCompAdjustmentBps(ASSET_ID)).to.equal(expected);
    expect(await registry.currentCenter(ASSET_ID)).to.equal((20n * ONE * expected) / BPS);
  });

  it("carries the anchor down when comps sell off", async () => {
    const { registry, setCompIndex, recordAnchor } = await deploy();
    await setCompIndex(ONE);
    await recordAnchor(20n * ONE, ONE);

    // Comps -30%; beta 1.2 -> center moves -36%.
    await setCompIndex((70n * ONE) / 100n);

    const expected = expectedAdjustmentBps((70n * ONE) / 100n, ONE, 12_000n, 5_000n);
    expect(expected).to.equal(6_400n);
    expect(await registry.currentCenter(ASSET_ID)).to.equal((20n * ONE * 6_400n) / BPS);
  });

  it("moves the whole band, not just the center", async () => {
    const { registry, setCompIndex, recordAnchor } = await deploy();
    await setCompIndex(ONE);
    await recordAnchor(20n * ONE, ONE);

    const [, lowerBefore, upperBefore] = await registry.checkBand(ASSET_ID, 20n * ONE);

    await setCompIndex((125n * ONE) / 100n);
    const [, lowerAfter, upperAfter] = await registry.checkBand(ASSET_ID, 20n * ONE);

    expect(lowerAfter).to.be.greaterThan(lowerBefore);
    expect(upperAfter).to.be.greaterThan(upperBefore);
    // Center 20 * 1.30 = 26, band +/-15% -> [22.1, 29.9]
    expect(lowerAfter).to.equal((26n * ONE * 8_500n) / BPS);
    expect(upperAfter).to.equal((26n * ONE * 11_500n) / BPS);
  });

  it("caps how far comps alone may move the center", async () => {
    const { registry, setCompIndex, walkCompIndexTo, recordAnchor } = await deploy();
    await setCompIndex(ONE);
    await recordAnchor(20n * ONE, ONE);

    // Comps double. Beta 1.2 implies +120%, but the cap holds it to +50%.
    await walkCompIndexTo(2n * ONE);
    expect(await registry.currentCompAdjustmentBps(ASSET_ID)).to.equal(15_000n);
    expect(await registry.currentCenter(ASSET_ID)).to.equal(30n * ONE);

    // And symmetrically on the downside: a 60% sector drawdown implies -72%,
    // capped at -50%.
    await walkCompIndexTo((40n * ONE) / 100n);
    expect(await registry.currentCompAdjustmentBps(ASSET_ID)).to.equal(5_000n);
    expect(await registry.currentCenter(ASSET_ID)).to.equal(10n * ONE);
  });

  it("guardrails the comps index itself, so no single print can lurch the band", async () => {
    const { setCompIndex, recordAnchor } = await deploy();
    await setCompIndex(ONE);
    await recordAnchor(20n * ONE, ONE);

    // The index is published under the same threshold-signature and deviation
    // rules as any other asset, so a 10x print is rejected outright rather
    // than being smuggled through as "just an index update".
    await expect(setCompIndex(10n * ONE)).to.be.reverted;
  });

  it("honours a beta of zero as pure comps-insensitivity", async () => {
    const { registry, setCompIndex, walkCompIndexTo, recordAnchor } = await deploy({
      betaBps: 0,
      maxCompAdjustmentBps: 5_000,
    });
    await setCompIndex(ONE);
    await recordAnchor(20n * ONE, ONE);
    await walkCompIndexTo(2n * ONE);

    expect(await registry.currentCompAdjustmentBps(ASSET_ID)).to.equal(BPS);
    expect(await registry.currentCenter(ASSET_ID)).to.equal(20n * ONE);
  });

  it("lets a comps rally unlock a price the original band forbade", async () => {
    const { oracle, registry, setCompIndex, recordAnchor, publishPrice } = await deploy();
    await setCompIndex(ONE);
    await recordAnchor(20n * ONE, ONE);

    // $26 is outside the initial [17, 23] band.
    const [okBefore] = await registry.checkBand(ASSET_ID, 26n * ONE);
    expect(okBefore).to.equal(false);
    await expect(publishPrice(26n * ONE)).to.be.revertedWithCustomError(oracle, "OutsideAnchorBand");

    // Public comps rally 25%. The same $26 is now squarely inside the band --
    // no new anchor, no guardian action, just the sector rerating carrying the
    // whole band with it. This is the behavior that keeps a pre-IPO mark
    // tracking reality between financing events.
    await setCompIndex((125n * ONE) / 100n);
    const [okAfter] = await registry.checkBand(ASSET_ID, 26n * ONE);
    expect(okAfter).to.equal(true);
    await expect(publishPrice(26n * ONE)).to.emit(oracle, "PriceUpdated");
  });

  it("rejects a config enabling comps tracking with no adjustment headroom", async () => {
    await expect(deploy({ compIndexAssetId: COMP_INDEX_ID, maxCompAdjustmentBps: 0 })).to.be.reverted;
  });

  it("rejects a comp adjustment cap that could drive the center to zero", async () => {
    await expect(deploy({ maxCompAdjustmentBps: 10_000 })).to.be.reverted;
  });
});
