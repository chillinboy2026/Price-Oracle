import { SolidityPriceAttestation } from "../signer/attestation.js";

export interface Publisher {
  publish(attestation: SolidityPriceAttestation, signatures: string[]): Promise<void>;
}
