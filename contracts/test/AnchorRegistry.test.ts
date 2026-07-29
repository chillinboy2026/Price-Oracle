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
const COMMON = ethers.keccak256(ethers.toUtf8Bytes("COMMON"));
const PREFERRED = ethers.keccak256(ethers.toUtf8Bytes("PREFERRED"));
const ONE = 10n ** 18n;
const DAY = 86_400;

describe("AnchorRegistry", function () {
  async function deploy(configOverrides: Record<string, unknown> = {}) {
    const [admin, other] = await ethers.getSigners();
    const attestors = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];

    const Oracle = await ethers.getContractFactory("PriceOracle", admin);
    const oracle = await Oracle.deploy(admin.address);
    await oracle.waitForDeployment();

    const Registry = await ethers.getContractFactory("AnchorRegistry", admin);
    const registry = await Registry.deploy(admin.address, await oracle.getAddress());
    await registry.waitForDeployment();

    const ATTESTOR_ROLE = await registry.ATTESTOR_ROLE();
    for (const a of attestors) await registry.grantRole(ATTESTOR_ROLE, a.address);

    await registry.registerAsset(ASSET_ID, {
      registered: true,
      threshold: 2,
      bandWideningBpsPerDay: 10,
      maxBandBps: 5_000, // 50%
      shareClass: COMMON,
      compIndexAssetId: ethers.ZeroHash,
      betaBps: 0,
      maxCompAdjustmentBps: 0,
      ...configOverrides,
    });

    const network = await ethers.provider.getNetwork();
    const domain = anchorDomainFor(network.chainId, await registry.getAddress());

    return { admin, other, attestors, registry, domain };
  }

  async function now(): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp);
  }

  function anchor(overrides: Partial<AnchorAttestation>, effectiveAt: bigint): AnchorAttestation {
    return {
      assetId: ASSET_ID,
      kind: AnchorKind.PRICED_ROUND,
      pricePerShare: 20n * ONE,
      shareClass: COMMON,
      effectiveAt,
      impliedValuation: 10_000_000_000n * ONE,
      bandBps: 1_500n,
      compIndexAtEffective: 0n,
      documentHash: ethers.keccak256(ethers.toUtf8Bytes("series-f-term-sheet.pdf")),
      nonce: 1n,
      ...overrides,
    };
  }

  it("records an anchor attested by the threshold, with full provenance", async () => {
    const { registry, attestors, domain } = await deploy();
    const effectiveAt = (await now()) - BigInt(30 * DAY);
    const attestation = anchor({}, effectiveAt);
    const sigs = await signAnchorByAll(attestors.slice(0, 2), domain, attestation);

    await expect(registry.recordAnchor(attestation, sigs))
      .to.emit(registry, "AnchorRecorded")
      .withArgs(
        ASSET_ID,
        AnchorKind.PRICED_ROUND,
        20n * ONE,
        effectiveAt,
        10_000_000_000n * ONE,
        1_500n,
        0n,
        attestation.documentHash,
        2
      );

    const stored = await registry.getAnchor(ASSET_ID);
    expect(stored.exists).to.equal(true);
    expect(stored.pricePerShare).to.equal(20n * ONE);
    expect(stored.effectiveAt).to.equal(effectiveAt);
    expect(stored.documentHash).to.equal(attestation.documentHash);
  });

  it("rejects an anchor below the attestor threshold", async () => {
    const { registry, attestors, domain } = await deploy();
    const attestation = anchor({}, await now());
    const sigs = await signAnchorByAll(attestors.slice(0, 1), domain, attestation);

    await expect(registry.recordAnchor(attestation, sigs)).to.be.revertedWithCustomError(
      registry,
      "InsufficientAttestations"
    );
  });

  it("does not count non-attestor or duplicate signatures", async () => {
    const { registry, attestors, domain } = await deploy();
    const attestation = anchor({}, await now());

    const impostor = Wallet.createRandom();
    await expect(
      registry.recordAnchor(attestation, await signAnchorByAll([attestors[0], impostor], domain, attestation))
    ).to.be.revertedWithCustomError(registry, "InsufficientAttestations");

    const [sig] = await signAnchorByAll([attestors[0]], domain, attestation);
    await expect(registry.recordAnchor(attestation, [sig, sig])).to.be.revertedWithCustomError(
      registry,
      "InsufficientAttestations"
    );
  });

  it("rejects an anchor priced in a different share class than the asset", async () => {
    const { registry, attestors, domain } = await deploy();
    // A preferred round price must not be silently applied as a common price.
    const attestation = anchor({ shareClass: PREFERRED }, await now());
    const sigs = await signAnchorByAll(attestors.slice(0, 2), domain, attestation);

    await expect(registry.recordAnchor(attestation, sigs)).to.be.revertedWithCustomError(
      registry,
      "ShareClassMismatch"
    );
  });

  it("rejects an anchor with a future effective date", async () => {
    const { registry, attestors, domain } = await deploy();
    const attestation = anchor({}, (await now()) + 10_000n);
    const sigs = await signAnchorByAll(attestors.slice(0, 2), domain, attestation);

    await expect(registry.recordAnchor(attestation, sigs)).to.be.revertedWithCustomError(
      registry,
      "EffectiveDateInFuture"
    );
  });

  it("refuses to let a newly-surfaced older event overwrite more recent evidence", async () => {
    const { registry, attestors, domain } = await deploy();
    const recent = (await now()) - BigInt(10 * DAY);
    const first = anchor({ nonce: 1n }, recent);
    await registry.recordAnchor(first, await signAnchorByAll(attestors.slice(0, 2), domain, first));

    const older = anchor({ nonce: 2n, pricePerShare: 5n * ONE }, (await now()) - BigInt(400 * DAY));
    await expect(
      registry.recordAnchor(older, await signAnchorByAll(attestors.slice(0, 2), domain, older))
    ).to.be.revertedWithCustomError(registry, "AnchorOlderThanCurrent");
  });

  it("rejects a replayed nonce", async () => {
    const { registry, attestors, domain } = await deploy();
    const effectiveAt = (await now()) - BigInt(DAY);
    const first = anchor({ nonce: 1n }, effectiveAt);
    await registry.recordAnchor(first, await signAnchorByAll(attestors.slice(0, 2), domain, first));

    const replay = anchor({ nonce: 1n, pricePerShare: 30n * ONE }, effectiveAt);
    await expect(
      registry.recordAnchor(replay, await signAnchorByAll(attestors.slice(0, 2), domain, replay))
    ).to.be.revertedWithCustomError(registry, "NonceNotIncreasing");
  });

  it("treats an asset with no anchor as unconstrained rather than frozen", async () => {
    const { registry } = await deploy();
    const [ok] = await registry.checkBand(ASSET_ID, 12345n * ONE);
    expect(ok).to.equal(true);
  });

  it("bounds prices to the band around the anchor", async () => {
    const { registry, attestors, domain } = await deploy();
    const attestation = anchor({ bandBps: 1_500n }, await now());
    await registry.recordAnchor(attestation, await signAnchorByAll(attestors.slice(0, 2), domain, attestation));

    // 15% band around $20 -> [17, 23]
    const [okInside, lower, upper] = await registry.checkBand(ASSET_ID, 21n * ONE);
    expect(okInside).to.equal(true);
    expect(lower).to.equal(17n * ONE);
    expect(upper).to.equal(23n * ONE);

    const [okAbove] = await registry.checkBand(ASSET_ID, 24n * ONE);
    expect(okAbove).to.equal(false);
    const [okBelow] = await registry.checkBand(ASSET_ID, 16n * ONE);
    expect(okBelow).to.equal(false);
  });

  it("widens the band as the anchor ages, capped at maxBandBps", async () => {
    const { registry, attestors, domain } = await deploy();
    const attestation = anchor({ bandBps: 1_500n }, await now());
    await registry.recordAnchor(attestation, await signAnchorByAll(attestors.slice(0, 2), domain, attestation));

    expect(await registry.currentBandBps(ASSET_ID)).to.equal(1_500n);

    // 100 days at 10bps/day of widening -> 1500 + 1000 = 2500
    await ethers.provider.send("evm_increaseTime", [100 * DAY]);
    await ethers.provider.send("evm_mine", []);
    expect(await registry.currentBandBps(ASSET_ID)).to.equal(2_500n);

    // A price that was outside the band when fresh is now inside it: stale
    // evidence constrains loosely rather than pinning the price.
    const [okNow] = await registry.checkBand(ASSET_ID, 24n * ONE);
    expect(okNow).to.equal(true);

    // Widening is capped, so the band never opens indefinitely.
    await ethers.provider.send("evm_increaseTime", [10_000 * DAY]);
    await ethers.provider.send("evm_mine", []);
    expect(await registry.currentBandBps(ASSET_ID)).to.equal(5_000n);
  });

  it("rejects invalid configuration", async () => {
    await expect(deploy({ threshold: 0 })).to.be.reverted;
    await expect(deploy({ maxBandBps: 0 })).to.be.reverted;
    await expect(deploy({ shareClass: ethers.ZeroHash })).to.be.reverted;
  });
});

describe("PriceOracle bound to an AnchorRegistry", function () {
  async function deploy() {
    const [admin] = await ethers.getSigners();
    const reporters = [Wallet.createRandom(), Wallet.createRandom()];
    const attestors = [Wallet.createRandom(), Wallet.createRandom()];

    const Oracle = await ethers.getContractFactory("PriceOracle", admin);
    const oracle = await Oracle.deploy(admin.address);
    await oracle.waitForDeployment();

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
      compIndexAssetId: ethers.ZeroHash,
      betaBps: 0,
      maxCompAdjustmentBps: 0,
    });
    const REPORTER_ROLE = await oracle.REPORTER_ROLE();
    for (const r of reporters) await oracle.grantRole(REPORTER_ROLE, r.address);
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

    return { admin, reporters, attestors, oracle, registry, oracleDomain, registryDomain };
  }

  async function now(): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp);
  }

  async function recordAnchor(
    registry: any,
    attestors: Wallet[],
    registryDomain: any,
    pricePerShare: bigint,
    nonce: bigint
  ) {
    const attestation: AnchorAttestation = {
      assetId: ASSET_ID,
      kind: AnchorKind.PRICED_ROUND,
      pricePerShare,
      shareClass: COMMON,
      effectiveAt: await now(),
      impliedValuation: 0n,
      bandBps: 1_500n,
      compIndexAtEffective: 0n,
      documentHash: ethers.ZeroHash,
      nonce,
    };
    await registry.recordAnchor(attestation, await signAnchorByAll(attestors, registryDomain, attestation));
  }

  function priceAttestation(price: bigint, ts: bigint, nonce: bigint): PriceAttestation {
    return {
      assetId: ASSET_ID,
      price,
      timestamp: ts,
      session: MarketSession.OFF_HOURS,
      confidenceBps: 900n,
      nonce,
    };
  }

  it("accepts a price inside the anchor band", async () => {
    const { oracle, registry, reporters, attestors, oracleDomain, registryDomain } = await deploy();
    await recordAnchor(registry, attestors, registryDomain, 20n * ONE, 1n);

    const attestation = priceAttestation(21n * ONE, await now(), 1n);
    await expect(
      oracle.updatePrice(attestation, await signAttestationByAll(reporters, oracleDomain, attestation))
    ).to.emit(oracle, "PriceUpdated");
  });

  it("rejects a threshold-signed price outside the anchor band", async () => {
    const { oracle, registry, reporters, attestors, oracleDomain, registryDomain } = await deploy();
    await recordAnchor(registry, attestors, registryDomain, 20n * ONE, 1n);

    // Fully valid signatures, within the deviation guardrail -- rejected purely
    // because no real-world evidence supports this valuation.
    const attestation = priceAttestation(40n * ONE, await now(), 1n);
    await expect(
      oracle.updatePrice(attestation, await signAttestationByAll(reporters, oracleDomain, attestation))
    ).to.be.revertedWithCustomError(oracle, "OutsideAnchorBand");
  });

  it("does not let a guardian override the anchor band", async () => {
    const { oracle, admin, registry, reporters, attestors, oracleDomain, registryDomain } = await deploy();
    await recordAnchor(registry, attestors, registryDomain, 20n * ONE, 1n);

    const attestation = priceAttestation(40n * ONE, await now(), 1n);
    const sigs = await signAttestationByAll(reporters, oracleDomain, attestation);

    // The guardian escape hatch bypasses the deviation cap but not the band:
    // repricing a pre-IPO asset requires new attested evidence, not authority.
    await expect(
      oracle.connect(admin).guardianOverridePrice(attestation, sigs)
    ).to.be.revertedWithCustomError(oracle, "OutsideAnchorBand");
  });

  it("lets a new anchor unlock a price the old band forbade", async () => {
    const { oracle, registry, reporters, attestors, oracleDomain, registryDomain } = await deploy();
    await recordAnchor(registry, attestors, registryDomain, 20n * ONE, 1n);

    const tooHigh = priceAttestation(40n * ONE, await now(), 1n);
    await expect(
      oracle.updatePrice(tooHigh, await signAttestationByAll(reporters, oracleDomain, tooHigh))
    ).to.be.revertedWithCustomError(oracle, "OutsideAnchorBand");

    // A new priced round at $40 is recorded with its own provenance...
    await recordAnchor(registry, attestors, registryDomain, 40n * ONE, 2n);

    // ...and the same price now clears.
    const retry = priceAttestation(40n * ONE, await now(), 2n);
    await expect(
      oracle.updatePrice(retry, await signAttestationByAll(reporters, oracleDomain, retry))
    ).to.emit(oracle, "PriceUpdated");
  });

  it("leaves assets with no anchorBand configured entirely unaffected", async () => {
    const { oracle, admin, reporters, oracleDomain } = await deploy();
    const publicAsset = ethers.keccak256(ethers.toUtf8Bytes("AAPL"));
    await oracle.connect(admin).registerAsset(publicAsset, {
      registered: true,
      threshold: 2,
      maxDeviationBpsLive: 9_000,
      maxDeviationBpsOffHours: 9_000,
      maxStaleness: 86_400,
      minPrice: 0,
      maxPrice: 0,
      anchorBand: ethers.ZeroAddress,
    });

    const attestation: PriceAttestation = {
      assetId: publicAsset,
      price: 999n * ONE,
      timestamp: await now(),
      session: MarketSession.LIVE,
      confidenceBps: 10n,
      nonce: 1n,
    };
    await expect(
      oracle.updatePrice(attestation, await signAttestationByAll(reporters, oracleDomain, attestation))
    ).to.emit(oracle, "PriceUpdated");
  });
});
