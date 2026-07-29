// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A veto interface a PriceOracle asset can optionally be bound to.
///
/// Deliberately minimal and free of any pre-IPO vocabulary: the oracle only
/// needs to ask "is this price acceptable for this asset right now?", so any
/// contract implementing a bound of any kind can be plugged in without the
/// oracle learning about valuations, cap tables or share classes.
interface IAnchorBand {
    /// @return ok Whether `price` (1e18) is acceptable for `assetId` right now.
    /// @return lower Inclusive lower bound of the acceptable range, for events/UX.
    /// @return upper Inclusive upper bound of the acceptable range, for events/UX.
    function checkBand(
        bytes32 assetId,
        uint256 price
    ) external view returns (bool ok, uint256 lower, uint256 upper);
}
