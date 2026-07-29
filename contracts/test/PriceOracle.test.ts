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

describe("PriceOracle", function () {
  async function deploy() {
    const [admin, other] = await ethers.getSigners();
    const reporters = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];

    const Oracle = await ethers.getContractFactory("PriceOracle", admin);
    const oracle = await Oracle.deploy(admin.address);
    await oracle.waitForDeployment();

    const REPORTER_ROLE = await oracle.REPORTER_ROLE();
    for (const r of reporters) {
      await oracle.grantRole(REPORTER_ROLE, r.address);
    }

    await oracle.registerAsset(ASSET_ID, {
      registered: true,
      threshold: 2,
      maxDeviationBpsLive: 200, // 2%
      maxDeviationBpsOffHours: 50, // 0.5%
      maxStaleness: 300,
      minPrice: 0,
      maxPrice: 0,
      anchorBand: ethers.ZeroAddress,
    });

    const network = await ethers.provider.getNetwork();
    const domain = domainFor(network.chainId, await oracle.getAddress());

    return { admin, other, reporters, oracle, domain };
  }

  async function now(): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp);
  }

  function baseAttestation(overrides: Partial<PriceAttestation>, ts: bigint): PriceAttestation {
    return {
      assetId: ASSET_ID,
      price: 190n * ONE,
      timestamp: ts,
      session: MarketSession.LIVE,
      confidenceBps: 10n,
      nonce: 1n,
      ...overrides,
    };
  }

  it("accepts a price update signed by threshold reporters", async () => {
    const { oracle, reporters, domain } = await deploy();
    const ts = await now();
    const attestation = baseAttestation({}, ts);
    const sigs = await signAttestationByAll(reporters.slice(0, 2), domain, attestation);

    await expect(oracle.updatePrice(attestation, sigs))
      .to.emit(oracle, "PriceUpdated")
      .withArgs(ASSET_ID, attestation.price, ts, MarketSession.LIVE, 2);

    const [price, timestamp, session] = await oracle.getPrice(ASSET_ID);
    expect(price).to.equal(attestation.price);
    expect(timestamp).to.equal(ts);
    expect(session).to.equal(MarketSession.LIVE);
  });

  it("rejects updates below the reporter signature threshold", async () => {
    const { oracle, reporters, domain } = await deploy();
    const ts = await now();
    const attestation = baseAttestation({}, ts);
    const sigs = await signAttestationByAll(reporters.slice(0, 1), domain, attestation);

    await expect(oracle.updatePrice(attestation, sigs)).to.be.revertedWithCustomError(
      oracle,
      "InsufficientSignatures"
    );
  });

  it("does not count signatures from non-reporters toward the threshold", async () => {
    const { oracle, reporters, domain } = await deploy();
    const ts = await now();
    const attestation = baseAttestation({}, ts);
    const impostor = Wallet.createRandom();
    const sigs = await signAttestationByAll([reporters[0], impostor], domain, attestation);

    await expect(oracle.updatePrice(attestation, sigs)).to.be.revertedWithCustomError(
      oracle,
      "InsufficientSignatures"
    );
  });

  it("does not double-count a duplicate signature from the same reporter", async () => {
    const { oracle, reporters, domain } = await deploy();
    const ts = await now();
    const attestation = baseAttestation({}, ts);
    const sig = (await signAttestationByAll([reporters[0]], domain, attestation))[0];

    await expect(oracle.updatePrice(attestation, [sig, sig])).to.be.revertedWithCustomError(
      oracle,
      "InsufficientSignatures"
    );
  });

  it("rejects a stale attestation", async () => {
    const { oracle, reporters, domain } = await deploy();
    const ts = (await now()) - 1000n;
    const attestation = baseAttestation({}, ts);
    const sigs = await signAttestationByAll(reporters.slice(0, 2), domain, attestation);

    await expect(oracle.updatePrice(attestation, sigs)).to.be.revertedWithCustomError(
      oracle,
      "StaleAttestation"
    );
  });

  it("rejects an attestation timestamped too far in the future", async () => {
    const { oracle, reporters, domain } = await deploy();
    const ts = (await now()) + 1000n;
    const attestation = baseAttestation({}, ts);
    const sigs = await signAttestationByAll(reporters.slice(0, 2), domain, attestation);

    await expect(oracle.updatePrice(attestation, sigs)).to.be.revertedWithCustomError(
      oracle,
      "FutureAttestation"
    );
  });

  it("rejects a non-increasing nonce", async () => {
    const { oracle, reporters, domain } = await deploy();
    const ts = await now();
    const attestation = baseAttestation({ nonce: 1n }, ts);
    const sigs = await signAttestationByAll(reporters.slice(0, 2), domain, attestation);
    await oracle.updatePrice(attestation, sigs);

    const ts2 = await now();
    const replay = baseAttestation({ nonce: 1n, price: 191n * ONE }, ts2);
    const sigs2 = await signAttestationByAll(reporters.slice(0, 2), domain, replay);

    await expect(oracle.updatePrice(replay, sigs2)).to.be.revertedWithCustomError(
      oracle,
      "NonceNotIncreasing"
    );
  });

  it("enforces the tighter off-hours deviation guardrail", async () => {
    const { oracle, reporters, domain } = await deploy();
    const ts = await now();
    const first = baseAttestation({ nonce: 1n, price: 100n * ONE }, ts);
    await oracle.updatePrice(first, await signAttestationByAll(reporters.slice(0, 2), domain, first));

    // 1% move while OFF_HOURS exceeds the 0.5% off-hours cap.
    const ts2 = await now();
    const bigMove = baseAttestation(
      { nonce: 2n, price: 101n * ONE, session: MarketSession.OFF_HOURS },
      ts2
    );
    await expect(
      oracle.updatePrice(bigMove, await signAttestationByAll(reporters.slice(0, 2), domain, bigMove))
    ).to.be.revertedWithCustomError(oracle, "DeviationExceeded");

    // The same 1% move is within the 2% LIVE cap.
    const liveMove = baseAttestation({ nonce: 2n, price: 101n * ONE, session: MarketSession.LIVE }, ts2);
    await expect(
      oracle.updatePrice(liveMove, await signAttestationByAll(reporters.slice(0, 2), domain, liveMove))
    ).to.emit(oracle, "PriceUpdated");
  });

  it("lets a guardian override the deviation guardrail for a legitimate gap", async () => {
    const { oracle, admin, reporters, domain } = await deploy();
    const ts = await now();
    const first = baseAttestation({ nonce: 1n, price: 100n * ONE }, ts);
    await oracle.updatePrice(first, await signAttestationByAll(reporters.slice(0, 2), domain, first));

    const ts2 = await now();
    const gap = baseAttestation({ nonce: 2n, price: 150n * ONE }, ts2); // 50% gap
    const sigs = await signAttestationByAll(reporters.slice(0, 2), domain, gap);

    await expect(oracle.updatePrice(gap, sigs)).to.be.revertedWithCustomError(oracle, "DeviationExceeded");

    await expect(oracle.connect(admin).guardianOverridePrice(gap, sigs))
      .to.emit(oracle, "PriceOverridden")
      .withArgs(ASSET_ID, 100n * ONE, 150n * ONE, ts2, admin.address);

    const [price] = await oracle.getPrice(ASSET_ID);
    expect(price).to.equal(150n * ONE);
  });

  it("rejects a non-guardian calling guardianOverridePrice", async () => {
    const { oracle, other, reporters, domain } = await deploy();
    const ts = await now();
    const attestation = baseAttestation({}, ts);
    const sigs = await signAttestationByAll(reporters.slice(0, 2), domain, attestation);

    await expect(oracle.connect(other).guardianOverridePrice(attestation, sigs)).to.be.reverted;
  });

  it("blocks updates while paused", async () => {
    const { oracle, admin, reporters, domain } = await deploy();
    await oracle.connect(admin).pause();

    const ts = await now();
    const attestation = baseAttestation({}, ts);
    const sigs = await signAttestationByAll(reporters.slice(0, 2), domain, attestation);

    await expect(oracle.updatePrice(attestation, sigs)).to.be.revertedWithCustomError(
      oracle,
      "EnforcedPause"
    );
  });

  it("getPriceNoOlderThan reverts once the price is older than the max staleness", async () => {
    const { oracle, reporters, domain } = await deploy();
    const ts = await now();
    const attestation = baseAttestation({}, ts);
    await oracle.updatePrice(attestation, await signAttestationByAll(reporters.slice(0, 2), domain, attestation));

    await expect(oracle.getPriceNoOlderThan(ASSET_ID, 10_000)).to.not.be.reverted;

    await ethers.provider.send("evm_increaseTime", [3600]);
    await ethers.provider.send("evm_mine", []);

    await expect(oracle.getPriceNoOlderThan(ASSET_ID, 10)).to.be.revertedWithCustomError(
      oracle,
      "PriceStale"
    );
  });
});
