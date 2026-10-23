// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AggregatorReference} from "./AggregatorReference.sol";

/// @title ChainlinkReference
/// @notice Tier 1 (session-fast) reference over Chainlink AggregatorV3 feeds, one per symbol. Round walk in
/// AggregatorReference.
contract ChainlinkReference is AggregatorReference {
    constructor(address owner_) AggregatorReference(owner_) {}

    function tier() public pure override returns (uint8) {
        return 1;
    }
}
