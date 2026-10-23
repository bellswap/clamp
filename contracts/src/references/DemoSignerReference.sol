// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IReference} from "../interfaces/IReference.sol";

/// @title DemoSignerReference
/// @notice The playground reference (tier 0). One signer, fixed at deployment, posts rounds per symbol; anyone may
/// relay a signed round. Rounds of a symbol are stored in strictly increasing timestamp order and may not be dated
/// after the block that stores them, so `priceAtOrAfter` is deterministic once a round at or after `t` exists.
///
/// Signed message: the EIP-191 personal-sign of the 32-byte digest
///   keccak256(abi.encode(DOMAIN_TAG, block.chainid, address(this), symbol, price8, timestamp))
/// where DOMAIN_TAG = keccak256("bellswap.v2.DemoSignerReference.post"). With viem:
///   signMessage({ message: { raw: digest } }), digest from encodeAbiParameters over
///   [bytes32, uint256, address, bytes32, uint256, uint64].
contract DemoSignerReference is IReference {
    struct Round {
        uint192 price8;
        uint64 timestamp;
    }

    bytes32 public constant DOMAIN_TAG = keccak256("bellswap.v2.DemoSignerReference.post");
    uint8 public constant TIER = 0;

    address public immutable signer;

    mapping(bytes32 symbol => Round[]) internal _rounds;

    event RoundPosted(bytes32 indexed symbol, uint256 indexed index, uint256 price8, uint64 timestamp);

    error ZeroSigner();
    error BadSignature();
    error ZeroPrice();
    error PriceTooLarge();
    error OutOfOrder(uint64 lastTimestamp, uint64 timestamp);
    error FutureRound(uint64 timestamp, uint256 blockTimestamp);
    error NoRound(bytes32 symbol);
    error NoRoundAtOrAfter(bytes32 symbol, uint64 t);
    error LengthMismatch();

    constructor(address signer_) {
        if (signer_ == address(0)) revert ZeroSigner();
        signer = signer_;
    }

    /// @notice The digest the signer signs (before the EIP-191 prefix) for one round.
    function digest(bytes32 symbol, uint256 price8, uint64 timestamp) public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TAG, block.chainid, address(this), symbol, price8, timestamp));
    }

    /// @notice Stores one signed round of `symbol`.
    function post(bytes32 symbol, uint256 price8, uint64 timestamp, bytes calldata signature) public {
        if (price8 == 0) revert ZeroPrice();
        if (price8 > type(uint192).max) revert PriceTooLarge();
        if (timestamp > block.timestamp) revert FutureRound(timestamp, block.timestamp);
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(digest(symbol, price8, timestamp));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(h, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) revert BadSignature();
        Round[] storage rs = _rounds[symbol];
        uint256 n = rs.length;
        if (n > 0) {
            uint64 last = rs[n - 1].timestamp;
            if (timestamp <= last) revert OutOfOrder(last, timestamp);
        }
        // price8 <= type(uint192).max is checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        rs.push(Round({price8: uint192(price8), timestamp: timestamp}));
        emit RoundPosted(symbol, n, price8, timestamp);
    }

    /// @notice Stores several signed rounds in one call (one per entry, same checks as `post`).
    function postMany(
        bytes32[] calldata symbols,
        uint256[] calldata prices8,
        uint64[] calldata timestamps,
        bytes[] calldata signatures
    ) external {
        uint256 n = symbols.length;
        if (prices8.length != n || timestamps.length != n || signatures.length != n) revert LengthMismatch();
        for (uint256 i; i < n; ++i) {
            post(symbols[i], prices8[i], timestamps[i], signatures[i]);
        }
    }

    /// @inheritdoc IReference
    function latest(bytes32 symbol) external view returns (uint256 price8, uint64 timestamp, uint8 tier) {
        Round[] storage rs = _rounds[symbol];
        uint256 n = rs.length;
        if (n == 0) revert NoRound(symbol);
        Round storage r = rs[n - 1];
        return (r.price8, r.timestamp, TIER);
    }

    /// @inheritdoc IReference
    /// @dev The proof is ignored. Binary search for the first round with timestamp >= t.
    function priceAtOrAfter(bytes32 symbol, uint64 t, bytes calldata)
        external
        view
        returns (uint256 price8, uint64 timestamp)
    {
        Round[] storage rs = _rounds[symbol];
        uint256 lo;
        uint256 hi = rs.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (rs[mid].timestamp < t) lo = mid + 1;
            else hi = mid;
        }
        if (lo == rs.length) revert NoRoundAtOrAfter(symbol, t);
        Round storage r = rs[lo];
        return (r.price8, r.timestamp);
    }

    function roundCount(bytes32 symbol) external view returns (uint256) {
        return _rounds[symbol].length;
    }

    function roundAt(bytes32 symbol, uint256 index) external view returns (uint256 price8, uint64 timestamp) {
        Round storage r = _rounds[symbol][index];
        return (r.price8, r.timestamp);
    }
}
