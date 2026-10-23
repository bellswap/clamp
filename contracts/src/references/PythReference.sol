// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IReference} from "../interfaces/IReference.sol";
import {IPyth} from "../vendor/pyth/IPyth.sol";
import {PythStructs} from "../vendor/pyth/PythStructs.sol";
import {PriceScale} from "../libraries/PriceScale.sol";

/// @title PythReference
/// @notice Tier 1 (session-fast) reference over a Pyth contract. One Pyth price id per symbol, set by the owner.
/// `priceAtOrAfter` takes `proof = abi.encode(bytes[] updateData)`, is callable only by the TicketBook (`book`), pays
/// the update fee from this contract's ETH balance (fund it through `receive`) and calls
/// `parsePriceFeedUpdatesUnique(updateData, [id], t, t + settleWindow)`. That parses the submitted historical update
/// independently of Pyth's stored latest price and only accepts an update whose previous publish time is below t, so
/// the result is the first observation at or after t, published no later than t + settleWindow. Not deployed on the
/// playground.
contract PythReference is IReference, Ownable {
    uint8 public constant TIER = 1;

    IPyth public immutable pyth;
    /// @notice The only caller of `priceAtOrAfter` (the TicketBook), so the fee balance funds settlements only.
    address public immutable book;
    /// @notice The latest publish time accepted for a price at or after t is t + settleWindow.
    uint64 public immutable settleWindow;

    mapping(bytes32 symbol => bytes32 priceId) public priceIdOf;

    event PriceIdSet(bytes32 indexed symbol, bytes32 priceId);

    error NoPriceId(bytes32 symbol);
    error FutureTime(uint64 t);
    error OutsideWindow(uint64 t, uint256 publishTime);
    error FeeTooHigh(uint256 fee, uint256 balance);
    error OnlyBook();

    constructor(address owner_, address pyth_, uint64 settleWindow_, address book_) Ownable(owner_) {
        pyth = IPyth(pyth_);
        settleWindow = settleWindow_;
        book = book_;
    }

    receive() external payable {}

    function setPriceId(bytes32 symbol, bytes32 priceId) external onlyOwner {
        priceIdOf[symbol] = priceId;
        emit PriceIdSet(symbol, priceId);
    }

    function _id(bytes32 symbol) internal view returns (bytes32 id) {
        id = priceIdOf[symbol];
        if (id == bytes32(0)) revert NoPriceId(symbol);
    }

    /// @inheritdoc IReference
    function latest(bytes32 symbol) external view returns (uint256 price8, uint64 timestamp, uint8 tier) {
        PythStructs.Price memory p = pyth.getPriceUnsafe(_id(symbol));
        return (PriceScale.pythTo8(p.price, p.expo), uint64(p.publishTime), TIER);
    }

    /// @inheritdoc IReference
    function priceAtOrAfter(bytes32 symbol, uint64 t, bytes calldata proof)
        external
        returns (uint256 price8, uint64 timestamp)
    {
        if (msg.sender != book) revert OnlyBook();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = _id(symbol);
        if (t > block.timestamp) revert FutureTime(t);
        bytes[] memory updateData = abi.decode(proof, (bytes[]));
        uint256 fee = pyth.getUpdateFee(updateData);
        if (fee > address(this).balance) revert FeeTooHigh(fee, address(this).balance);
        PythStructs.Price memory p =
            pyth.parsePriceFeedUpdatesUnique{value: fee}(updateData, ids, t, t + settleWindow)[0].price;
        if (p.publishTime < t || p.publishTime > uint256(t) + settleWindow) revert OutsideWindow(t, p.publishTime);
        return (PriceScale.pythTo8(p.price, p.expo), uint64(p.publishTime));
    }
}
