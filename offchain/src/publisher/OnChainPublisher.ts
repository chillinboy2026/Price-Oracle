import { Contract, Signer } from "ethers";
import { SolidityPriceAttestation } from "../signer/attestation.js";
import { Publisher } from "./types.js";

const PRICE_ORACLE_ABI = [
  "function updatePrice((bytes32 assetId,uint256 price,uint256 timestamp,uint8 session,uint256 confidenceBps,uint256 nonce) attestation, bytes[] signatures) external",
];

/** Submits the aggregated, threshold-signed attestation to a live
 * PriceOracle deployment. Works unmodified against any EVM chain the
 * contract is deployed to -- only RPC_URL/ORACLE_ADDRESS change. */
export class OnChainPublisher implements Publisher {
  private readonly contract: Contract;

  constructor(oracleAddress: string, signer: Signer) {
    this.contract = new Contract(oracleAddress, PRICE_ORACLE_ABI, signer);
  }

  async publish(attestation: SolidityPriceAttestation, signatures: string[]): Promise<void> {
    const tx = await this.contract.updatePrice(attestation, signatures);
    await tx.wait();
  }
}
