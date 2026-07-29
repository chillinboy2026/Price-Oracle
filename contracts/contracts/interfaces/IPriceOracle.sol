// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PriceAttestationLib} from "../libraries/PriceAttestationLib.sol";

/// @notice Minimal read interface consumed by anything pricing off the oracle
/// (a market-maker vault, a DEX, a lending market, etc). Kept deliberately small
/// so it is trivial to re-implement on any EVM chain, or wrap behind an adapter
/// on a non-EVM chain that speaks the same attestation format.
interface IPriceOracle {
    /// @return price Fair price for `assetId`, 1e18 fixed point.
    /// @return timestamp Off-chain computation time the price is valid as of.
    /// @return session Whether the price was produced while the reference market was live.
    function getPrice(
        bytes32 assetId
    ) external view returns (uint256 price, uint256 timestamp, PriceAttestationLib.MarketSession session);

    /// @notice Like getPrice, but reverts if the price is older than `maxStaleness`
    /// seconds. Consumers that cannot tolerate a stale mark (e.g. liquidation logic)
    /// should call this instead of `getPrice`.
    function getPriceNoOlderThan(
        bytes32 assetId,
        uint256 maxStaleness
    ) external view returns (uint256 price, uint256 timestamp, PriceAttestationLib.MarketSession session);
}
