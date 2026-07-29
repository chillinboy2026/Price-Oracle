import { TypedDataDomain, TypedDataField, Wallet, HDNodeWallet } from "ethers";

export enum AnchorKind {
  PRICED_ROUND = 0,
  SECONDARY = 1,
  TENDER_OFFER = 2,
  VALUATION_409A = 3,
  FUND_MARK = 4,
  RECAP = 5,
}

export interface AnchorAttestation {
  assetId: string;
  kind: AnchorKind;
  pricePerShare: bigint;
  shareClass: string;
  effectiveAt: bigint;
  impliedValuation: bigint;
  bandBps: bigint;
  documentHash: string;
  nonce: bigint;
}

export const ANCHOR_TYPES: Record<string, TypedDataField[]> = {
  AnchorAttestation: [
    { name: "assetId", type: "bytes32" },
    { name: "kind", type: "uint8" },
    { name: "pricePerShare", type: "uint256" },
    { name: "shareClass", type: "bytes32" },
    { name: "effectiveAt", type: "uint256" },
    { name: "impliedValuation", type: "uint256" },
    { name: "bandBps", type: "uint256" },
    { name: "documentHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
};

export function anchorDomainFor(chainId: bigint, verifyingContract: string): TypedDataDomain {
  return { name: "AnchorRegistry", version: "1", chainId, verifyingContract };
}

export async function signAnchorByAll(
  signers: (Wallet | HDNodeWallet)[],
  domain: TypedDataDomain,
  attestation: AnchorAttestation
): Promise<string[]> {
  return Promise.all(signers.map((s) => s.signTypedData(domain, ANCHOR_TYPES, attestation)));
}
