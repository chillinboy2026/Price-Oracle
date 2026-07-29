import { HDNodeWallet, TypedDataDomain, TypedDataField, Wallet, ZeroHash, parseUnits } from "ethers";
import { AnchorEvent, AnchorKind } from "../anchor/types.js";

/** On-chain struct shape, matching AnchorAttestationLib.AnchorAttestation. */
export interface SolidityAnchorAttestation {
  assetId: string;
  kind: AnchorKind;
  pricePerShare: bigint;
  shareClass: string;
  effectiveAt: bigint;
  impliedValuation: bigint;
  bandBps: bigint;
  compIndexAtEffective: bigint;
  documentHash: string;
  nonce: bigint;
}

/** Must stay byte-for-byte identical to AnchorAttestationLib's typehash field
 * list, or signatures produced here will not recover to the expected address. */
export const ANCHOR_ATTESTATION_TYPES: Record<string, TypedDataField[]> = {
  AnchorAttestation: [
    { name: "assetId", type: "bytes32" },
    { name: "kind", type: "uint8" },
    { name: "pricePerShare", type: "uint256" },
    { name: "shareClass", type: "bytes32" },
    { name: "effectiveAt", type: "uint256" },
    { name: "impliedValuation", type: "uint256" },
    { name: "bandBps", type: "uint256" },
    { name: "compIndexAtEffective", type: "uint256" },
    { name: "documentHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
};

export function anchorRegistryDomain(chainId: bigint, verifyingContract: string): TypedDataDomain {
  return { name: "AnchorRegistry", version: "1", chainId, verifyingContract };
}

export function toSolidityAnchorAttestation(
  assetId: string,
  shareClassHash: string,
  event: AnchorEvent,
  nonce: bigint
): SolidityAnchorAttestation {
  return {
    assetId,
    kind: event.kind,
    pricePerShare: parseUnits(event.pricePerShare.toFixed(18), 18),
    shareClass: shareClassHash,
    effectiveAt: BigInt(event.effectiveAt),
    impliedValuation: parseUnits((event.impliedValuation ?? 0).toFixed(18), 18),
    bandBps: BigInt(Math.round(event.bandBps)),
    compIndexAtEffective: parseUnits((event.compIndexAtEffective ?? 0).toFixed(18), 18),
    documentHash: event.documentHash ?? ZeroHash,
    nonce,
  };
}

export async function signAnchorAttestation(
  signer: Wallet | HDNodeWallet,
  domain: TypedDataDomain,
  attestation: SolidityAnchorAttestation
): Promise<string> {
  return signer.signTypedData(domain, ANCHOR_ATTESTATION_TYPES, attestation);
}
