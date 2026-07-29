// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Chain-agnostic price attestation format signed off-chain by independent
/// reporter nodes and verified on-chain via EIP-712. The same struct layout and
/// typehash are mirrored in the off-chain TypeScript signer so a signature produced
/// off-chain recovers to the same address here, regardless of which chain/VM the
/// verifying contract is deployed on.
library PriceAttestationLib {
    /// @dev MarketSession distinguishes whether the attestation was produced while
    /// the underlying reference market was actively trading ("LIVE") or while it was
    /// closed and the price was carried forward by the synthetic off-hours model
    /// ("OFF_HOURS"). The verifying contract applies a tighter deviation guardrail
    /// to OFF_HOURS updates since there is no independent live market to cross-check.
    enum MarketSession {
        OFF_HOURS,
        LIVE
    }

    struct PriceAttestation {
        // Identifier of the priced asset, e.g. keccak256("AAPL") or a pre-IPO deal id.
        bytes32 assetId;
        // Fair price, scaled to 1e18 fixed point, denominated in the oracle's quote unit.
        uint256 price;
        // Off-chain computation time (unix seconds) the price was valid as of.
        uint256 timestamp;
        // Whether the reference market was open when this price was computed.
        MarketSession session;
        // Reporter's self-reported confidence width, in bps of price. Informational;
        // consumers may use it to size spreads but the oracle does not enforce it.
        uint256 confidenceBps;
        // Strictly increasing per-asset counter, prevents replay of stale attestations
        // out of order even if timestamps collide.
        uint256 nonce;
    }

    bytes32 internal constant PRICE_ATTESTATION_TYPEHASH =
        keccak256(
            "PriceAttestation(bytes32 assetId,uint256 price,uint256 timestamp,uint8 session,uint256 confidenceBps,uint256 nonce)"
        );

    function hashStruct(PriceAttestation memory attestation) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    PRICE_ATTESTATION_TYPEHASH,
                    attestation.assetId,
                    attestation.price,
                    attestation.timestamp,
                    uint8(attestation.session),
                    attestation.confidenceBps,
                    attestation.nonce
                )
            );
    }
}
