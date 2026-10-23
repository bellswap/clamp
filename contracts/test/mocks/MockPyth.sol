// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PythStructs} from "../../src/vendor/pyth/PythStructs.sol";

/// @notice Minimal Pyth stand-in with the calls PythReference uses. An update is
/// abi.encode(bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime, uint64 prevPublishTime); fee per
/// update is `feePerUpdate`. Like Pyth, an older update never overwrites a newer stored price, getPriceNoOlderThan
/// reverts StalePrice, and parsePriceFeedUpdatesUnique ignores the stored state and returns, per id, the first update
/// with minPublishTime <= publishTime <= maxPublishTime and prevPublishTime < minPublishTime.
contract MockPyth {
    uint256 public immutable feePerUpdate;
    mapping(bytes32 id => PythStructs.Price) internal _prices;

    error InsufficientFee();
    error PriceFeedNotFound();
    error StalePrice();
    error PriceFeedNotFoundWithinRange();

    constructor(uint256 feePerUpdate_) {
        feePerUpdate = feePerUpdate_;
    }

    function encodeUpdate(bytes32 id, int64 price, int32 expo, uint64 publishTime, uint64 prevPublishTime)
        external
        pure
        returns (bytes memory)
    {
        return abi.encode(id, price, uint64(0), expo, publishTime, prevPublishTime);
    }

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256) {
        return feePerUpdate * updateData.length;
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        if (msg.value < feePerUpdate * updateData.length) revert InsufficientFee();
        for (uint256 i; i < updateData.length; ++i) {
            (bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime,) =
                abi.decode(updateData[i], (bytes32, int64, uint64, int32, uint64, uint64));
            if (publishTime > _prices[id].publishTime) {
                _prices[id] = PythStructs.Price({price: price, conf: conf, expo: expo, publishTime: publishTime});
            }
        }
    }

    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory feeds) {
        if (msg.value < feePerUpdate * updateData.length) revert InsufficientFee();
        feeds = new PythStructs.PriceFeed[](priceIds.length);
        for (uint256 k; k < priceIds.length; ++k) {
            bool found;
            for (uint256 i; i < updateData.length && !found; ++i) {
                (bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime, uint64 prev) =
                    abi.decode(updateData[i], (bytes32, int64, uint64, int32, uint64, uint64));
                if (id != priceIds[k] || publishTime < minPublishTime || publishTime > maxPublishTime) continue;
                if (prev >= minPublishTime) continue;
                PythStructs.Price memory p = PythStructs.Price({price: price, conf: conf, expo: expo, publishTime: publishTime});
                feeds[k] = PythStructs.PriceFeed({id: id, price: p, emaPrice: p});
                found = true;
            }
            if (!found) revert PriceFeedNotFoundWithinRange();
        }
    }

    function getPriceUnsafe(bytes32 id) public view returns (PythStructs.Price memory p) {
        p = _prices[id];
        if (p.publishTime == 0) revert PriceFeedNotFound();
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (PythStructs.Price memory p) {
        p = getPriceUnsafe(id);
        uint256 diff = block.timestamp > p.publishTime ? block.timestamp - p.publishTime : p.publishTime - block.timestamp;
        if (diff > age) revert StalePrice();
    }
}
