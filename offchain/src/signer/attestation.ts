import { HDNodeWallet, TypedDataDomain, TypedDataField, Wallet, parseUnits } from "ethers";
import { FairPriceResult, MarketSession } from "../types.js";

/** On-chain struct shape, matching PriceAttestationLib.PriceAttestation. */
export interface SolidityPriceAttestation {
  assetId: string;
  price: bigint;
  timestamp: bigint;
  session: MarketSession;
  confidenceBps: bigint;
  nonce: bigint;
}

/** Must stay byte-for-byte identical to PriceAttestationLib's typehash
 * field list, or signatures produced here won't recover to the address the
 * contract expects. */
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

export function oracleDomain(chainId: bigint, verifyingContract: string): TypedDataDomain {
  return { name: "PriceOracle", version: "1", chainId, verifyingContract };
}

/** Converts an engine's human-readable result into the 1e18 fixed-point
 * struct the contract expects. */
export function toSolidityAttestation(assetId: string, result: FairPriceResult): SolidityPriceAttestation {
  return {
    assetId,
    price: parseUnits(result.price.toFixed(18), 18),
    timestamp: BigInt(result.timestamp),
    session: result.session,
    confidenceBps: BigInt(Math.round(result.confidenceBps)),
    nonce: result.nonce,
  };
}

export async function signAttestation(
  signer: Wallet | HDNodeWallet,
  domain: TypedDataDomain,
  attestation: SolidityPriceAttestation
): Promise<string> {
  return signer.signTypedData(domain, ATTESTATION_TYPES, attestation);
}
