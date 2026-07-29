// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IAnchorBand} from "./interfaces/IAnchorBand.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {PriceAttestationLib} from "./libraries/PriceAttestationLib.sol";

/// @title PriceOracle
/// @notice Verifiable, chain-agnostic fair-price oracle for real world assets and
/// pre-IPO markets.
///
/// Design summary:
///  - An off-chain network of independent reporter nodes each runs the same fair
///    price algorithm (blending a live reference market during trading hours with
///    a bounded synthetic drift + market-maker inventory skew off-hours) and signs
///    the result as an EIP-712 `PriceAttestation`.
///  - This contract only trusts the *aggregate*: a price update is accepted only
///    once at least `threshold` distinct addresses holding REPORTER_ROLE have
///    signed the exact same attestation. No single reporter, and no single
///    off-chain process, can move the price alone.
///  - Guardrails are enforced on-chain, not just off-chain: every accepted update
///    is bounded to a maximum move (in bps) from the last accepted price, with a
///    tighter bound while the reference market is closed (OFF_HOURS) than while
///    it is open (LIVE), since off-hours moves cannot be cross-checked against an
///    independent live market. A move that exceeds the guardrail simply reverts —
///    the price freezes rather than jumping — which is the safe failure mode
///    under a manipulation attempt or a feed outage.
///  - Legitimate large repricing events (e.g. an earnings gap at market open, or a
///    priced funding round for a pre-IPO asset) are handled by
///    `guardianOverridePrice`, which still requires the full reporter signature
///    threshold but is restricted to GUARDIAN_ROLE and emits a distinct event so
///    every override is transparent and attributable on-chain.
///  - Everything here is plain Solidity with no chain-specific dependencies, so
///    the identical contract deploys unmodified to any EVM chain. The attestation
///    struct and signing scheme are simple enough to re-implement behind a thin
///    adapter on a non-EVM chain later without changing the off-chain engine.
contract PriceOracle is IPriceOracle, AccessControl, Pausable, EIP712 {
    using ECDSA for bytes32;
    using PriceAttestationLib for PriceAttestationLib.PriceAttestation;

    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @dev An attestation timestamped further into the future than this (relative
    /// to block.timestamp) is rejected outright — it cannot possibly be a real
    /// off-chain observation yet.
    uint256 public constant MAX_FUTURE_TOLERANCE = 30;

    struct AssetConfig {
        bool registered;
        uint8 threshold; // minimum distinct reporter signatures required
        uint16 maxDeviationBpsLive; // max move per update while session == LIVE
        uint16 maxDeviationBpsOffHours; // max move per update while session == OFF_HOURS
        uint32 maxStaleness; // seconds; attestation.timestamp vs block.timestamp
        uint256 minPrice; // absolute sanity floor, 1e18 fixed point (0 = disabled)
        uint256 maxPrice; // absolute sanity ceiling, 1e18 fixed point (0 = disabled)
        // Optional external bound consulted on every accepted price. Used for
        // assets with no continuous market (pre-IPO), where an AnchorRegistry
        // constrains the price to a band around the last real-world valuation
        // event. address(0) disables the check, which is the normal case for a
        // public-market asset that already has a live feed to cross-check.
        address anchorBand;
    }

    struct AssetState {
        uint256 price;
        uint256 timestamp;
        uint256 lastNonce;
        PriceAttestationLib.MarketSession session;
    }

    mapping(bytes32 => AssetConfig) public assetConfigs;
    mapping(bytes32 => AssetState) public assetStates;

    event AssetRegistered(bytes32 indexed assetId, AssetConfig config);
    event AssetConfigUpdated(bytes32 indexed assetId, AssetConfig config);
    event PriceUpdated(
        bytes32 indexed assetId,
        uint256 price,
        uint256 timestamp,
        PriceAttestationLib.MarketSession session,
        uint8 signerCount
    );
    event PriceOverridden(
        bytes32 indexed assetId,
        uint256 previousPrice,
        uint256 newPrice,
        uint256 timestamp,
        address indexed guardian
    );

    error AssetNotRegistered(bytes32 assetId);
    error StaleAttestation(uint256 timestamp, uint256 nowTs, uint256 maxStaleness);
    error FutureAttestation(uint256 timestamp, uint256 nowTs);
    error NonceNotIncreasing(uint256 nonce, uint256 lastNonce);
    error InsufficientSignatures(uint8 valid, uint8 required);
    error PriceOutOfBounds(uint256 price, uint256 minPrice, uint256 maxPrice);
    error DeviationExceeded(uint256 deviationBps, uint256 maxDeviationBps);
    error PriceStale(uint256 timestamp, uint256 nowTs, uint256 maxStaleness);
    error OutsideAnchorBand(uint256 price, uint256 lower, uint256 upper);

    constructor(address admin) EIP712("PriceOracle", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function registerAsset(bytes32 assetId, AssetConfig calldata config) external onlyRole(DEFAULT_ADMIN_ROLE) {
        assetConfigs[assetId] = config;
        assetConfigs[assetId].registered = true;
        emit AssetRegistered(assetId, assetConfigs[assetId]);
    }

    function updateAssetConfig(bytes32 assetId, AssetConfig calldata config) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!assetConfigs[assetId].registered) revert AssetNotRegistered(assetId);
        assetConfigs[assetId] = config;
        assetConfigs[assetId].registered = true;
        emit AssetConfigUpdated(assetId, assetConfigs[assetId]);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Price updates
    // ---------------------------------------------------------------------

    /// @notice Submit a new price for `attestation.assetId`, authorized by a
    /// threshold of independent reporter signatures over the same EIP-712 struct.
    function updatePrice(
        PriceAttestationLib.PriceAttestation calldata attestation,
        bytes[] calldata signatures
    ) external whenNotPaused {
        AssetConfig memory config = assetConfigs[attestation.assetId];
        if (!config.registered) revert AssetNotRegistered(attestation.assetId);

        _validateFreshness(attestation.timestamp, config.maxStaleness);

        AssetState storage state = assetStates[attestation.assetId];
        if (attestation.nonce <= state.lastNonce && state.timestamp != 0) {
            revert NonceNotIncreasing(attestation.nonce, state.lastNonce);
        }

        uint8 validSigners = _countValidReporterSignatures(attestation, signatures);
        if (validSigners < config.threshold) revert InsufficientSignatures(validSigners, config.threshold);

        _checkAbsoluteBounds(attestation.price, config.minPrice, config.maxPrice);
        _checkAnchorBand(config.anchorBand, attestation.assetId, attestation.price);

        if (state.timestamp != 0) {
            uint16 maxDeviationBps = attestation.session == PriceAttestationLib.MarketSession.LIVE
                ? config.maxDeviationBpsLive
                : config.maxDeviationBpsOffHours;
            _checkDeviation(state.price, attestation.price, maxDeviationBps);
        }

        state.price = attestation.price;
        state.timestamp = attestation.timestamp;
        state.lastNonce = attestation.nonce;
        state.session = attestation.session;

        emit PriceUpdated(attestation.assetId, attestation.price, attestation.timestamp, attestation.session, validSigners);
    }

    /// @notice Guardian-gated escape hatch for legitimate moves that exceed the
    /// normal deviation guardrail (e.g. an overnight earnings gap, or a new priced
    /// round for a pre-IPO asset). Still requires the full reporter signature
    /// threshold and absolute bounds — only the deviation cap is bypassed — and
    /// every use is emitted as a distinct, attributable event.
    function guardianOverridePrice(
        PriceAttestationLib.PriceAttestation calldata attestation,
        bytes[] calldata signatures
    ) external onlyRole(GUARDIAN_ROLE) whenNotPaused {
        AssetConfig memory config = assetConfigs[attestation.assetId];
        if (!config.registered) revert AssetNotRegistered(attestation.assetId);

        _validateFreshness(attestation.timestamp, config.maxStaleness);

        AssetState storage state = assetStates[attestation.assetId];
        if (attestation.nonce <= state.lastNonce && state.timestamp != 0) {
            revert NonceNotIncreasing(attestation.nonce, state.lastNonce);
        }

        uint8 validSigners = _countValidReporterSignatures(attestation, signatures);
        if (validSigners < config.threshold) revert InsufficientSignatures(validSigners, config.threshold);

        _checkAbsoluteBounds(attestation.price, config.minPrice, config.maxPrice);
        // The guardian override bypasses the *deviation* cap, not the anchor
        // band. A pre-IPO repricing is supposed to arrive as a new anchor with
        // its own provenance; letting a guardian jump the price outside the
        // band without one would reintroduce exactly the unilateral authority
        // the registry exists to remove.
        _checkAnchorBand(config.anchorBand, attestation.assetId, attestation.price);

        uint256 previousPrice = state.price;
        state.price = attestation.price;
        state.timestamp = attestation.timestamp;
        state.lastNonce = attestation.nonce;
        state.session = attestation.session;

        emit PriceOverridden(attestation.assetId, previousPrice, attestation.price, attestation.timestamp, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getPrice(
        bytes32 assetId
    ) external view override returns (uint256 price, uint256 timestamp, PriceAttestationLib.MarketSession session) {
        AssetState memory state = assetStates[assetId];
        return (state.price, state.timestamp, state.session);
    }

    function getPriceNoOlderThan(
        bytes32 assetId,
        uint256 maxStaleness
    ) external view override returns (uint256 price, uint256 timestamp, PriceAttestationLib.MarketSession session) {
        AssetState memory state = assetStates[assetId];
        if (block.timestamp > state.timestamp + maxStaleness) {
            revert PriceStale(state.timestamp, block.timestamp, maxStaleness);
        }
        return (state.price, state.timestamp, state.session);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function hashAttestation(
        PriceAttestationLib.PriceAttestation calldata attestation
    ) external view returns (bytes32) {
        return _hashTypedDataV4(PriceAttestationLib.hashStruct(attestation));
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _validateFreshness(uint256 timestamp, uint32 maxStaleness) internal view {
        if (timestamp > block.timestamp + MAX_FUTURE_TOLERANCE) {
            revert FutureAttestation(timestamp, block.timestamp);
        }
        if (block.timestamp > timestamp + maxStaleness) {
            revert StaleAttestation(timestamp, block.timestamp, maxStaleness);
        }
    }

    function _checkAbsoluteBounds(uint256 price, uint256 minPrice, uint256 maxPrice) internal pure {
        if (minPrice != 0 && price < minPrice) revert PriceOutOfBounds(price, minPrice, maxPrice);
        if (maxPrice != 0 && price > maxPrice) revert PriceOutOfBounds(price, minPrice, maxPrice);
    }

    function _checkAnchorBand(address anchorBand, bytes32 assetId, uint256 price) internal view {
        if (anchorBand == address(0)) return;
        (bool ok, uint256 lower, uint256 upper) = IAnchorBand(anchorBand).checkBand(assetId, price);
        if (!ok) revert OutsideAnchorBand(price, lower, upper);
    }

    function _checkDeviation(uint256 oldPrice, uint256 newPrice, uint16 maxDeviationBps) internal pure {
        if (oldPrice == 0) return;
        uint256 diff = newPrice > oldPrice ? newPrice - oldPrice : oldPrice - newPrice;
        uint256 deviationBps = (diff * BPS_DENOMINATOR) / oldPrice;
        if (deviationBps > maxDeviationBps) revert DeviationExceeded(deviationBps, maxDeviationBps);
    }

    /// @dev Recovers the signer of each signature over the attestation's EIP-712
    /// digest, requiring each to hold REPORTER_ROLE and be distinct from every
    /// other signer counted so far. Reporter sets are small (single/low-digit
    /// digits of nodes) by design, so the O(n^2) dedupe is cheap and avoids
    /// needing storage for a transient signer set.
    function _countValidReporterSignatures(
        PriceAttestationLib.PriceAttestation calldata attestation,
        bytes[] calldata signatures
    ) internal view returns (uint8) {
        bytes32 digest = _hashTypedDataV4(PriceAttestationLib.hashStruct(attestation));

        uint256 len = signatures.length;
        address[] memory seen = new address[](len);
        uint8 validCount = 0;

        for (uint256 i = 0; i < len; i++) {
            address signer = digest.recover(signatures[i]);
            if (!hasRole(REPORTER_ROLE, signer)) continue;

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
