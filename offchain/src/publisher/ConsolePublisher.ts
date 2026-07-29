import { SolidityPriceAttestation } from "../signer/attestation.js";
import { Publisher } from "./types.js";

/** Default publisher when no RPC/oracle address is configured -- logs what
 * would have been submitted instead of sending a transaction, so the
 * orchestrator loop runs safely with zero chain configuration. */
export class ConsolePublisher implements Publisher {
  async publish(attestation: SolidityPriceAttestation, signatures: string[]): Promise<void> {
    console.log("[dry-run] would call PriceOracle.updatePrice", {
      assetId: attestation.assetId,
      price: attestation.price.toString(),
      timestamp: attestation.timestamp.toString(),
      session: attestation.session,
      nonce: attestation.nonce.toString(),
      signatureCount: signatures.length,
    });
  }
}
