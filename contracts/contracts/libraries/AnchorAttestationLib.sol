// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Attestation format for a discrete real-world repricing event on an
/// asset with no continuous market. Mirrored byte-for-byte in the off-chain
/// TypeScript signer, exactly like PriceAttestationLib.
library AnchorAttestationLib {
    /// @dev How the valuation was established. This is not cosmetic: the kind
    /// drives how much the off-chain model trusts the anchor and how fast that
    /// trust decays, because these events are genuinely not equivalent evidence.
    enum AnchorKind {
        /// A priced primary financing. Strongest evidence: real money, arm's
        /// length, negotiated. Note it prices *preferred*, not common.
        PRICED_ROUND,
        /// A secondary sale of existing shares (usually common). Prices the
        /// class most tokenholders actually care about, but often small,
        /// illiquid and information-poor.
        SECONDARY,
        /// A company-run tender offer. Broader and more structured than a
        /// one-off secondary, and normally prices common.
        TENDER_OFFER,
        /// An IRS-409A independent valuation of common. Formal and defensible
        /// but deliberately conservative and backward-looking.
        VALUATION_409A,
        /// A mutual-fund holder's published mark. Frequent (often monthly) and
        /// independent, but a modelled estimate rather than a transaction.
        FUND_MARK,
        /// A recapitalization or down round that resets the preference stack.
        RECAP
    }

    struct AnchorAttestation {
        bytes32 assetId;
        AnchorKind kind;
        /// Price per share of `shareClass`, 1e18. For a PRICED_ROUND this is
        /// the *derived* price of the referenced class, not necessarily the
        /// headline price of the new preferred series -- see the off-chain
        /// cap-table waterfall.
        uint256 pricePerShare;
        /// Which class this prices, e.g. keccak256("COMMON"). Recorded because
        /// a valuation is meaningless without it: common and preferred in the
        /// same company trade at materially different prices.
        bytes32 shareClass;
        /// When the event actually occurred, which can lag reporting by weeks.
        /// Decay is measured from here, not from submission.
        uint256 effectiveAt;
        /// Headline post-money valuation implied, 1e18. Informational.
        uint256 impliedValuation;
        /// Half-width of the acceptable band around this anchor at t=0, in bps.
        uint256 bandBps;
        /// Hash of the source document (term sheet, 409A report, tender notice)
        /// so the attestation is auditable against evidence rather than being
        /// a bare number someone asserted.
        bytes32 documentHash;
        uint256 nonce;
    }

    bytes32 internal constant ANCHOR_ATTESTATION_TYPEHASH =
        keccak256(
            "AnchorAttestation(bytes32 assetId,uint8 kind,uint256 pricePerShare,bytes32 shareClass,uint256 effectiveAt,uint256 impliedValuation,uint256 bandBps,bytes32 documentHash,uint256 nonce)"
        );

    function hashStruct(AnchorAttestation memory attestation) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    ANCHOR_ATTESTATION_TYPEHASH,
                    attestation.assetId,
                    uint8(attestation.kind),
                    attestation.pricePerShare,
                    attestation.shareClass,
                    attestation.effectiveAt,
                    attestation.impliedValuation,
                    attestation.bandBps,
                    attestation.documentHash,
                    attestation.nonce
                )
            );
    }
}
