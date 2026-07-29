import { TypedDataDomain, TypedDataField, Wallet, HDNodeWallet } from "ethers";

export enum MarketSession {
  OFF_HOURS = 0,
  LIVE = 1,
}

export interface PriceAttestation {
  assetId: string;
  price: bigint;
  timestamp: bigint;
  session: MarketSession;
  confidenceBps: bigint;
  nonce: bigint;
}

export const ATTESTATION_TYPES: Record<string, TypedDataField[]> = {
  PriceAttestation: [
    { name: "assetId", type: "bytes32" },
    { name: "price", type: "uint256" },
    { name: "timestamp", type: "uint256" },
    { name: "session", type: "uint8" },
    { name: "confidenceBps", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

export function domainFor(chainId: bigint, verifyingContract: string): TypedDataDomain {
  return {
    name: "PriceOracle",
    version: "1",
    chainId,
    verifyingContract,
  };
}

export async function signAttestation(
  signer: Wallet | HDNodeWallet,
  domain: TypedDataDomain,
  attestation: PriceAttestation
): Promise<string> {
  return signer.signTypedData(domain, ATTESTATION_TYPES, attestation);
}

export async function signAttestationByAll(
  signers: (Wallet | HDNodeWallet)[],
  domain: TypedDataDomain,
  attestation: PriceAttestation
): Promise<string[]> {
  return Promise.all(signers.map((s) => signAttestation(s, domain, attestation)));
}
