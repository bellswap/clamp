// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IReference
/// @notice A reference price source the TicketBook reads. Symbols are bytes32 of the catalog ticker (ASCII, right
/// padded). Prices carry 8 decimals. Tier: 1 session-fast (Chainlink, Pyth), 2 daily (Ondo), 0 demo signer.
/// See docs/INTERFACES.md.
interface IReference {
    /// @notice The latest stored price of `symbol`.
    function latest(bytes32 symbol) external view returns (uint256 price8, uint64 timestamp, uint8 tier);

    /// @notice The first price of `symbol` at or after time `t`; `proof` carries adapter-specific data (ignored by the
    /// demo signer adapter, a Pyth update for the Pyth adapter).
    function priceAtOrAfter(bytes32 symbol, uint64 t, bytes calldata proof)
        external
        returns (uint256 price8, uint64 timestamp);
}
