// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IAnchorBand} from "./interfaces/IAnchorBand.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {AnchorAttestationLib} from "./libraries/AnchorAttestationLib.sol";

/// @title AnchorRegistry
/// @notice On-chain record of the discrete real-world repricing events that
/// price an asset with no continuous market -- pre-IPO equity above all.
///
/// The problem this solves: a public stock has a live market to track, so the
/// oracle's job is mostly to follow it safely. A pre-IPO company has no such
/// market. Its price is established at sparse, discrete moments -- a priced
/// round, a tender offer, a 409A, a secondary -- and between those moments it
/// is genuinely unobservable. So the model inverts: instead of the synthetic
/// drift being a fallback for when the live market is closed, the drift *is*
/// the pricing engine, and these anchors are what keep it tethered to reality.
///
/// What this contract adds over simply letting a guardian set a price:
///  - Every anchor carries provenance: what kind of event it was, when it
///    actually took effect (not when it was reported), which share class it
///    prices, the implied valuation, and a hash of the source document. An
///    anchor is auditable against evidence rather than being a bare number.
///  - Anchors are threshold-attested by ATTESTOR_ROLE holders, so no single
///    party can invent a valuation, exactly as with price attestations.
///  - It implements IAnchorBand, so a PriceOracle asset can be *bound* to it:
///    the contract itself then refuses any published price outside the band
///    around the most recent anchor. The band is enforced on-chain, not merely
///    respected off-chain.
///
/// Band widening: an anchor's authority decays. A priced round from last month
/// is strong evidence about today's value; the same round three years ago is
/// weak. `bandWideningBpsPerDay` widens the acceptable range as the anchor
/// ages, so a stale anchor constrains the price loosely rather than pinning it
/// to a number nobody believes any more -- while still bounding it, since
/// `maxBandBps` caps how far the band can ever open.
///
/// Comparables tracking: widening alone treats the intervening time as pure
/// ignorance, which overstates the case. What is unobservable between anchors
/// is *this company's* execution; what is very observable is the valuation
/// multiple the public market pays for companies like it, and sector rerating
/// is a large part of what moves private marks between rounds. So the band does
/// not merely widen around a fixed point -- it *travels*, recentered by how far
/// a public comparables index has moved since the anchor's effective date,
/// scaled by the asset's beta to that index.
///
/// The comparables index is read from a PriceOracle as an ordinary asset. That
/// is the point: the index is itself computed by the same reporter network and
/// published under the same threshold-signature and guardrail rules as any
/// other price, so the recentering is verifiable on-chain end to end rather
/// than being an off-chain claim about where comps went.
contract AnchorRegistry is IAnchorBand, AccessControl, EIP712 {
    using ECDSA for bytes32;

    bytes32 public constant ATTESTOR_ROLE = keccak256("ATTESTOR_ROLE");
    bytes32 public constant ADMIN_ROLE = DEFAULT_ADMIN_ROLE;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_FUTURE_TOLERANCE = 30;

    struct AnchorConfig {
        bool registered;
        uint8 threshold;
        /// Extra band half-width added per day of anchor age, in bps.
        uint32 bandWideningBpsPerDay;
        /// Hard ceiling on the band half-width, however stale the anchor.
        uint32 maxBandBps;
        /// Share class this asset is priced in, e.g. keccak256("COMMON").
        /// An anchor attesting a different class is rejected, so a preferred
        /// round price can never be silently applied as a common price.
        bytes32 shareClass;
        /// Asset id of the public comparables index in `priceOracle`.
        /// bytes32(0) disables comps tracking, leaving a static band.
        bytes32 compIndexAssetId;
        /// Sensitivity to the comps index, in bps: 10000 = moves 1:1 with the
        /// basket, 15000 = 1.5x. Signed, though a negative beta to one's own
        /// sector would be unusual enough to warrant scrutiny.
        int32 betaBps;
        /// Hard cap on how far comps alone may move the band's center, in bps.
        /// Bounds both the linearization error and the blast radius of a bad
        /// index print.
        uint32 maxCompAdjustmentBps;
    }

    struct StoredAnchor {
        bool exists;
        AnchorAttestationLib.AnchorKind kind;
        uint256 pricePerShare;
        uint256 effectiveAt;
        uint256 recordedAt;
        uint256 impliedValuation;
        uint256 bandBps;
        uint256 compIndexAtEffective;
        bytes32 documentHash;
        uint256 lastNonce;
    }

    mapping(bytes32 => AnchorConfig) public anchorConfigs;
    mapping(bytes32 => StoredAnchor) public anchors;

    event AssetRegistered(bytes32 indexed assetId, AnchorConfig config);
    event AssetConfigUpdated(bytes32 indexed assetId, AnchorConfig config);
    event AnchorRecorded(
        bytes32 indexed assetId,
        AnchorAttestationLib.AnchorKind indexed kind,
        uint256 pricePerShare,
        uint256 effectiveAt,
        uint256 impliedValuation,
        uint256 bandBps,
        uint256 compIndexAtEffective,
        bytes32 documentHash,
        uint8 attestorCount
    );

    error AssetNotRegistered(bytes32 assetId);
    error InsufficientAttestations(uint8 valid, uint8 required);
    error EffectiveDateInFuture(uint256 effectiveAt, uint256 nowTs);
    error AnchorOlderThanCurrent(uint256 effectiveAt, uint256 currentEffectiveAt);
    error NonceNotIncreasing(uint256 nonce, uint256 lastNonce);
    error ShareClassMismatch(bytes32 expected, bytes32 provided);
    error ZeroPrice();
    error InvalidConfig();

    /// @notice Source of comparables index prices. Immutable so an asset's
    /// recentering can never be redirected to a different, friendlier oracle
    /// after the fact.
    IPriceOracle public immutable priceOracle;

    constructor(address admin, IPriceOracle _priceOracle) EIP712("AnchorRegistry", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        priceOracle = _priceOracle;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function registerAsset(bytes32 assetId, AnchorConfig calldata config) external onlyRole(ADMIN_ROLE) {
        _validateConfig(config);
        anchorConfigs[assetId] = config;
        anchorConfigs[assetId].registered = true;
        emit AssetRegistered(assetId, anchorConfigs[assetId]);
    }

    function updateAssetConfig(bytes32 assetId, AnchorConfig calldata config) external onlyRole(ADMIN_ROLE) {
        if (!anchorConfigs[assetId].registered) revert AssetNotRegistered(assetId);
        _validateConfig(config);
        anchorConfigs[assetId] = config;
        anchorConfigs[assetId].registered = true;
        emit AssetConfigUpdated(assetId, anchorConfigs[assetId]);
    }

    function _validateConfig(AnchorConfig calldata config) internal pure {
        if (config.threshold == 0) revert InvalidConfig();
        if (config.maxBandBps == 0 || config.maxBandBps > BPS_DENOMINATOR) revert InvalidConfig();
        if (config.shareClass == bytes32(0)) revert InvalidConfig();
        // A comp adjustment able to reach or exceed 100% could drive the band
        // center to zero or negative.
        if (config.maxCompAdjustmentBps >= BPS_DENOMINATOR) revert InvalidConfig();
        if (config.compIndexAssetId != bytes32(0) && config.maxCompAdjustmentBps == 0) revert InvalidConfig();
    }

    // ---------------------------------------------------------------------
    // Recording anchors
    // ---------------------------------------------------------------------

    /// @notice Records a new anchor for `attestation.assetId`, authorized by a
    /// threshold of independent attestor signatures over the same EIP-712 struct.
    function recordAnchor(
        AnchorAttestationLib.AnchorAttestation calldata attestation,
        bytes[] calldata signatures
    ) external {
        AnchorConfig memory config = anchorConfigs[attestation.assetId];
        if (!config.registered) revert AssetNotRegistered(attestation.assetId);
        if (attestation.pricePerShare == 0) revert ZeroPrice();
        if (attestation.shareClass != config.shareClass) {
            revert ShareClassMismatch(config.shareClass, attestation.shareClass);
        }
        if (attestation.effectiveAt > block.timestamp + MAX_FUTURE_TOLERANCE) {
            revert EffectiveDateInFuture(attestation.effectiveAt, block.timestamp);
        }

        StoredAnchor storage current = anchors[attestation.assetId];
        if (current.exists) {
            if (attestation.nonce <= current.lastNonce) {
                revert NonceNotIncreasing(attestation.nonce, current.lastNonce);
            }
            // Anchors are ordered by when the event took effect, not by when
            // someone got around to reporting it. A newly-surfaced older event
            // must not overwrite more recent evidence.
            if (attestation.effectiveAt < current.effectiveAt) {
                revert AnchorOlderThanCurrent(attestation.effectiveAt, current.effectiveAt);
            }
        }

        uint8 validAttestors = _countValidAttestorSignatures(attestation, signatures);
        if (validAttestors < config.threshold) {
            revert InsufficientAttestations(validAttestors, config.threshold);
        }

        anchors[attestation.assetId] = StoredAnchor({
            exists: true,
            kind: attestation.kind,
            pricePerShare: attestation.pricePerShare,
            effectiveAt: attestation.effectiveAt,
            recordedAt: block.timestamp,
            impliedValuation: attestation.impliedValuation,
            bandBps: attestation.bandBps,
            compIndexAtEffective: attestation.compIndexAtEffective,
            documentHash: attestation.documentHash,
            lastNonce: attestation.nonce
        });

        emit AnchorRecorded(
            attestation.assetId,
            attestation.kind,
            attestation.pricePerShare,
            attestation.effectiveAt,
            attestation.impliedValuation,
            attestation.bandBps,
            attestation.compIndexAtEffective,
            attestation.documentHash,
            validAttestors
        );
    }

    // ---------------------------------------------------------------------
    // Band
    // ---------------------------------------------------------------------

    /// @notice Current band half-width in bps: the anchor's own width plus
    /// accumulated widening for its age, capped at `maxBandBps`.
    function currentBandBps(bytes32 assetId) public view returns (uint256) {
        AnchorConfig memory config = anchorConfigs[assetId];
        StoredAnchor memory anchor = anchors[assetId];
        if (!anchor.exists) return 0;

        uint256 ageDays = block.timestamp > anchor.effectiveAt
            ? (block.timestamp - anchor.effectiveAt) / 1 days
            : 0;
        uint256 band = anchor.bandBps + ageDays * config.bandWideningBpsPerDay;
        return band > config.maxBandBps ? config.maxBandBps : band;
    }

    /// @notice Multiplier applied to the anchor price to reflect how far public
    /// comparables have moved since the anchor took effect, in bps
    /// (BPS_DENOMINATOR = no adjustment).
    ///
    /// Applied linearly rather than by exponentiation:
    ///
    ///   adjustment = 1 + beta * (indexNow / indexAtAnchor - 1)
    ///
    /// which is both what beta means under linear-return estimation and the
    /// only form practical in integer arithmetic. The off-chain
    /// `compsAdjustmentFactor` reproduces this exactly, including the clamp, so
    /// the pricing engine never proposes a center the contract disagrees with.
    ///
    /// Falls back to no adjustment when comps tracking is disabled, when the
    /// anchor predates comps tracking, or when the index has never been
    /// published. That last case is deliberately a soft failure: `checkBand` is
    /// called inside `updatePrice`, so reverting here would freeze the asset's
    /// price entirely rather than merely un-tracking comps.
    function currentCompAdjustmentBps(bytes32 assetId) public view returns (uint256) {
        AnchorConfig memory config = anchorConfigs[assetId];
        StoredAnchor memory anchor = anchors[assetId];

        if (config.compIndexAssetId == bytes32(0)) return BPS_DENOMINATOR;
        if (!anchor.exists || anchor.compIndexAtEffective == 0) return BPS_DENOMINATOR;

        (uint256 indexNow, , ) = priceOracle.getPrice(config.compIndexAssetId);
        if (indexNow == 0) return BPS_DENOMINATOR;

        int256 ratioBps = int256((indexNow * BPS_DENOMINATOR) / anchor.compIndexAtEffective);
        int256 deltaBps = ratioBps - int256(BPS_DENOMINATOR);
        int256 adjustmentBps = int256(BPS_DENOMINATOR) + (int256(config.betaBps) * deltaBps) / int256(BPS_DENOMINATOR);

        int256 lowerBound = int256(BPS_DENOMINATOR) - int256(uint256(config.maxCompAdjustmentBps));
        int256 upperBound = int256(BPS_DENOMINATOR) + int256(uint256(config.maxCompAdjustmentBps));
        if (adjustmentBps < lowerBound) adjustmentBps = lowerBound;
        if (adjustmentBps > upperBound) adjustmentBps = upperBound;
        // maxCompAdjustmentBps is validated below BPS_DENOMINATOR, so the
        // clamped result is always strictly positive.
        return uint256(adjustmentBps);
    }

    /// @notice The band's center: the anchor price carried forward by comps.
    function currentCenter(bytes32 assetId) public view returns (uint256) {
        StoredAnchor memory anchor = anchors[assetId];
        if (!anchor.exists) return 0;
        return (anchor.pricePerShare * currentCompAdjustmentBps(assetId)) / BPS_DENOMINATOR;
    }

    /// @inheritdoc IAnchorBand
    /// @dev An asset with no anchor yet is unconstrained rather than frozen:
    /// returning `false` here would deadlock a newly-registered asset, since no
    /// price could be published until an anchor existed and nothing else would
    /// bootstrap one.
    function checkBand(
        bytes32 assetId,
        uint256 price
    ) external view override returns (bool ok, uint256 lower, uint256 upper) {
        StoredAnchor memory anchor = anchors[assetId];
        if (!anchor.exists) return (true, 0, type(uint256).max);

        uint256 center = currentCenter(assetId);
        uint256 band = currentBandBps(assetId);
        lower = (center * (BPS_DENOMINATOR - band)) / BPS_DENOMINATOR;
        upper = (center * (BPS_DENOMINATOR + band)) / BPS_DENOMINATOR;
        ok = price >= lower && price <= upper;
    }

    function getAnchor(bytes32 assetId) external view returns (StoredAnchor memory) {
        return anchors[assetId];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function hashAttestation(
        AnchorAttestationLib.AnchorAttestation calldata attestation
    ) external view returns (bytes32) {
        return _hashTypedDataV4(AnchorAttestationLib.hashStruct(attestation));
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _countValidAttestorSignatures(
        AnchorAttestationLib.AnchorAttestation calldata attestation,
        bytes[] calldata signatures
    ) internal view returns (uint8) {
        bytes32 digest = _hashTypedDataV4(AnchorAttestationLib.hashStruct(attestation));

        uint256 len = signatures.length;
        address[] memory seen = new address[](len);
        uint8 validCount = 0;

        for (uint256 i = 0; i < len; i++) {
            address signer = digest.recover(signatures[i]);
            if (!hasRole(ATTESTOR_ROLE, signer)) continue;

            bool duplicate = false;
            for (uint256 j = 0; j < validCount; j++) {
                if (seen[j] == signer) {
                    duplicate = true;
                    break;
                }
            }
            if (duplicate) continue;

            seen[validCount] = signer;
            validCount++;
        }

        return validCount;
    }
}
