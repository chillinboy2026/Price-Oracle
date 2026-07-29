import { Wallet, parseUnits, verifyTypedData } from "ethers";
import { describe, expect, it } from "vitest";
import { oracleDomain, signAttestation, toSolidityAttestation, ATTESTATION_TYPES } from "../src/signer/attestation.js";
import { MarketSession } from "../src/types.js";

describe("attestation signing", () => {
  it("converts an engine result into the 1e18 fixed-point on-chain struct", () => {
    const attestation = toSolidityAttestation("0x" + "11".repeat(32), {
      price: 190.5,
      timestamp: 1_700_000_000,
      session: MarketSession.LIVE,
      nonce: 3n,
      confidenceBps: 12.4,
    });

    expect(attestation.price).toBe(parseUnits("190.5", 18));
    expect(attestation.timestamp).toBe(1_700_000_000n);
    expect(attestation.session).toBe(MarketSession.LIVE);
    expect(attestation.nonce).toBe(3n);
    expect(attestation.confidenceBps).toBe(12n);
  });

  it("produces a signature that recovers to the signer's address", async () => {
    const wallet = Wallet.createRandom();
    const domain = oracleDomain(31337n, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const attestation = toSolidityAttestation("0x" + "22".repeat(32), {
      price: 100,
      timestamp: 1_700_000_000,
      session: MarketSession.OFF_HOURS,
      nonce: 1n,
      confidenceBps: 50,
    });

    const signature = await signAttestation(wallet, domain, attestation);
    const recovered = verifyTypedData(domain, ATTESTATION_TYPES, attestation, signature);

    expect(recovered).toBe(wallet.address);
  });

  it("produces a different digest (and thus signature) for a different nonce", async () => {
    const wallet = Wallet.createRandom();
    const domain = oracleDomain(31337n, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const base = { price: 100, timestamp: 1_700_000_000, session: MarketSession.OFF_HOURS, confidenceBps: 50 };

    const a = toSolidityAttestation("0x" + "33".repeat(32), { ...base, nonce: 1n });
    const b = toSolidityAttestation("0x" + "33".repeat(32), { ...base, nonce: 2n });

    const sigA = await signAttestation(wallet, domain, a);
    const sigB = await signAttestation(wallet, domain, b);

    expect(sigA).not.toBe(sigB);
    expect(verifyTypedData(domain, ATTESTATION_TYPES, a, sigA)).toBe(wallet.address);
    expect(verifyTypedData(domain, ATTESTATION_TYPES, b, sigB)).toBe(wallet.address);
  });
});
