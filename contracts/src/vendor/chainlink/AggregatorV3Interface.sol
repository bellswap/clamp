// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice The Chainlink AggregatorV3 read face (same signatures as
/// smartcontractkit/chainlink AggregatorV3Interface). The Ondo ReferenceFeed views expose the same face.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function description() external view returns (string memory);

    function version() external view returns (uint256);

    function getRoundData(uint80 _roundId)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
