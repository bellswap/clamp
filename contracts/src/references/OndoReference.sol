// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AggregatorReference} from "./AggregatorReference.sol";

/// @title OndoReference
/// @notice Tier 2 (daily) reference over the existing Bellswap ReferenceFeed through its AggregatorV3 face (the
/// GuardedFeedView, confirmed rounds only), one view per symbol. Same round walk as the Chainlink adapter.
contract OndoReference is AggregatorReference {
    constructor(address owner_) AggregatorReference(owner_) {}

    function tier() public pure override returns (uint8) {
        return 2;
    }
}
