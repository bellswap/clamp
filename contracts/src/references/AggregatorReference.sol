// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IReference} from "../interfaces/IReference.sol";
import {AggregatorV3Interface} from "../vendor/chainlink/AggregatorV3Interface.sol";
import {PriceScale} from "../libraries/PriceScale.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title AggregatorReference
/// @notice Shared base for references read through the AggregatorV3 face: one feed per symbol, set by the owner.
/// `priceAtOrAfter` returns the first round of the feed's current phase with updatedAt >= t. With a 32-byte proof
/// (abi.encode(uint80 roundId)) the hinted round is verified: it must be at or after t and its predecessor in the
/// same phase must be before t. With an empty proof the adapter walks back from the latest round, at most
/// MAX_WALK steps. Only the very first round of a feed (phase 0 or 1, aggregator round 1) is accepted without a
/// predecessor. A round that opens a later phase reverts PhaseBoundary (the last round of the previous phase cannot be
/// proven here), and a predecessor the feed does not return reverts UnknownHistory: a failed lookup is unknown history,
/// never a boundary. Settlement therefore needs a feed that serves confirmed rounds by id (see docs/INTERFACES.md).
abstract contract AggregatorReference is IReference, Ownable {
    uint256 public constant MAX_WALK = 64;

    mapping(bytes32 symbol => AggregatorV3Interface) public feedOf;

    event FeedSet(bytes32 indexed symbol, address feed);

    error NoFeed(bytes32 symbol);
    error NoRoundAtOrAfter(bytes32 symbol, uint64 t);
    error BadHint(uint80 roundId);
    error WalkTooLong(bytes32 symbol, uint64 t);
    error BadProof();
    error PhaseBoundary(uint80 roundId);
    error UnknownHistory(uint80 roundId);

    constructor(address owner_) Ownable(owner_) {}

    /// @notice The tier this adapter reports (1 Chainlink, 2 Ondo).
    function tier() public pure virtual returns (uint8);

    function setFeed(bytes32 symbol, address feed) external onlyOwner {
        feedOf[symbol] = AggregatorV3Interface(feed);
        emit FeedSet(symbol, feed);
    }

    function _feed(bytes32 symbol) internal view returns (AggregatorV3Interface f) {
        f = feedOf[symbol];
        if (address(f) == address(0)) revert NoFeed(symbol);
    }

    /// @inheritdoc IReference
    function latest(bytes32 symbol) external view returns (uint256 price8, uint64 timestamp, uint8 tier_) {
        AggregatorV3Interface f = _feed(symbol);
        (, int256 answer,, uint256 updatedAt,) = f.latestRoundData();
        return (PriceScale.to8(answer, f.decimals()), SafeCast.toUint64(updatedAt), tier());
    }

    /// @inheritdoc IReference
    function priceAtOrAfter(bytes32 symbol, uint64 t, bytes calldata proof)
        external
        view
        returns (uint256 price8, uint64 timestamp)
    {
        AggregatorV3Interface f = _feed(symbol);
        uint80 roundId;
        int256 answer;
        uint256 updatedAt;
        if (proof.length == 32) {
            roundId = abi.decode(proof, (uint80));
            bool ok;
            (ok, answer, updatedAt) = _round(f, roundId);
            if (!ok || updatedAt < t) revert BadHint(roundId);
            (bool okPrev,, uint256 prevAt) = _prev(f, roundId);
            if (okPrev && prevAt >= t) revert BadHint(roundId);
        } else if (proof.length == 0) {
            (roundId, answer,, updatedAt,) = f.latestRoundData();
            if (updatedAt < t) revert NoRoundAtOrAfter(symbol, t);
            for (uint256 i;; ++i) {
                if (i == MAX_WALK) revert WalkTooLong(symbol, t);
                (bool okPrev, int256 prevAnswer, uint256 prevAt) = _prev(f, roundId);
                if (!okPrev || prevAt < t) break;
                roundId -= 1;
                answer = prevAnswer;
                updatedAt = prevAt;
            }
        } else {
            revert BadProof();
        }
        return (PriceScale.to8(answer, f.decimals()), SafeCast.toUint64(updatedAt));
    }

    /// @dev The predecessor of `roundId` in the same phase, or ok = false when `roundId` is the feed's first round
    /// (phase 0 or 1, aggregator round 1). Reverts PhaseBoundary when `roundId` opens a later phase and
    /// UnknownHistory when the predecessor lookup fails.
    function _prev(AggregatorV3Interface f, uint80 roundId)
        internal
        view
        returns (bool ok, int256 answer, uint256 updatedAt)
    {
        // the low 64 bits of a proxy round id are the aggregator round within the phase, the top 16 bits the phase
        // forge-lint: disable-next-line(unsafe-typecast)
        if (uint64(roundId) <= 1) {
            if (roundId >> 64 > 1) revert PhaseBoundary(roundId);
            return (false, 0, 0);
        }
        (ok, answer, updatedAt) = _round(f, roundId - 1);
        if (!ok) revert UnknownHistory(roundId - 1);
    }

    function _round(AggregatorV3Interface f, uint80 roundId)
        internal
        view
        returns (bool ok, int256 answer, uint256 updatedAt)
    {
        try f.getRoundData(roundId) returns (uint80, int256 a, uint256, uint256 u, uint80) {
            if (u == 0) return (false, 0, 0);
            return (true, a, u);
        } catch {
            return (false, 0, 0);
        }
    }
}
