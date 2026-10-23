// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice AggregatorV3 stand-in. Round ids carry the phase in the top 16 bits as on Chainlink proxies.
contract MockAggregator {
    struct R {
        int256 answer;
        uint256 updatedAt;
    }

    uint8 public immutable decimals;
    uint80 public latestId;
    mapping(uint80 => R) internal _r;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function description() external pure returns (string memory) {
        return "mock";
    }

    function version() external pure returns (uint256) {
        return 4;
    }

    function roundId(uint16 phase, uint64 aggregatorRound) public pure returns (uint80) {
        return (uint80(phase) << 64) | aggregatorRound;
    }

    function push(uint80 id, int256 answer, uint256 updatedAt) external {
        _r[id] = R(answer, updatedAt);
        latestId = id;
    }

    function getRoundData(uint80 id) public view returns (uint80, int256, uint256, uint256, uint80) {
        R memory r = _r[id];
        require(r.updatedAt != 0, "No data present");
        return (id, r.answer, r.updatedAt, r.updatedAt, id);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latestId);
    }
}
