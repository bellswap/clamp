// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {DemoSignerReference} from "../src/references/DemoSignerReference.sol";
import {PythReference} from "../src/references/PythReference.sol";
import {ChainlinkReference} from "../src/references/ChainlinkReference.sol";
import {OndoReference} from "../src/references/OndoReference.sol";
import {AggregatorReference} from "../src/references/AggregatorReference.sol";
import {PriceScale} from "../src/libraries/PriceScale.sol";
import {MockPyth} from "./mocks/MockPyth.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";

contract DemoSignerReferenceTest is Test {
    uint256 internal constant PK = 0xB0B;
    bytes32 internal constant SYM = bytes32("RTX");
    DemoSignerReference internal ref;

    function setUp() public {
        vm.warp(1_800_000_000);
        ref = new DemoSignerReference(vm.addr(PK));
    }

    function _sig(uint256 pk, bytes32 sym, uint256 p, uint64 ts) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(ref.digest(sym, p, ts)));
        return abi.encodePacked(r, s, v);
    }

    function _post(bytes32 sym, uint256 p, uint64 ts) internal {
        ref.post(sym, p, ts, _sig(PK, sym, p, ts));
    }

    function test_signerFixed() public {
        assertEq(ref.signer(), vm.addr(PK));
        vm.expectRevert(DemoSignerReference.ZeroSigner.selector);
        new DemoSignerReference(address(0));
    }

    function test_postAndLatest() public {
        uint64 t = uint64(block.timestamp);
        _post(SYM, 123e8, t - 10);
        _post(SYM, 124e8, t);
        (uint256 p, uint64 ts, uint8 tier) = ref.latest(SYM);
        assertEq(p, 124e8);
        assertEq(ts, t);
        assertEq(tier, 0);
        assertEq(ref.roundCount(SYM), 2);
        (p, ts) = ref.roundAt(SYM, 0);
        assertEq(p, 123e8);
    }

    function test_signatureChecks() public {
        uint64 t = uint64(block.timestamp);
        bytes memory good = _sig(PK, SYM, 100e8, t);
        bytes memory otherSigner = _sig(0xBAD, SYM, 100e8, t);
        uint256 chainBefore = block.chainid;
        vm.chainId(4663);
        bytes memory otherChain = _sig(PK, SYM, 100e8, t);
        vm.chainId(chainBefore);

        vm.expectRevert(DemoSignerReference.BadSignature.selector);
        ref.post(SYM, 101e8, t, good); // tampered price
        vm.expectRevert(DemoSignerReference.BadSignature.selector);
        ref.post(SYM, 100e8, t - 1, good); // tampered time
        vm.expectRevert(DemoSignerReference.BadSignature.selector);
        ref.post(bytes32("NOC"), 100e8, t, good); // other symbol
        vm.expectRevert(DemoSignerReference.BadSignature.selector);
        ref.post(SYM, 100e8, t, otherSigner);
        vm.expectRevert(DemoSignerReference.BadSignature.selector);
        ref.post(SYM, 100e8, t, hex"1234"); // malformed
        vm.expectRevert(DemoSignerReference.BadSignature.selector);
        ref.post(SYM, 100e8, t, otherChain); // signed for chain 4663
        ref.post(SYM, 100e8, t, good);
    }

    function test_ordering() public {
        uint64 t = uint64(block.timestamp);
        _post(SYM, 100e8, t - 100);
        bytes memory same = _sig(PK, SYM, 101e8, t - 100);
        bytes memory older = _sig(PK, SYM, 101e8, t - 200);
        bytes memory future = _sig(PK, SYM, 101e8, t + 1);
        bytes memory zero = _sig(PK, SYM, 0, t);
        vm.expectRevert(abi.encodeWithSelector(DemoSignerReference.OutOfOrder.selector, t - 100, t - 100));
        ref.post(SYM, 101e8, t - 100, same);
        vm.expectRevert(abi.encodeWithSelector(DemoSignerReference.OutOfOrder.selector, t - 100, t - 200));
        ref.post(SYM, 101e8, t - 200, older);
        vm.expectRevert(abi.encodeWithSelector(DemoSignerReference.FutureRound.selector, t + 1, uint256(t)));
        ref.post(SYM, 101e8, t + 1, future);
        vm.expectRevert(DemoSignerReference.ZeroPrice.selector);
        ref.post(SYM, 0, t, zero);
        // other symbols keep their own order
        _post(bytes32("NOC"), 50e8, t - 500);
    }

    function test_priceAtOrAfter() public {
        uint64 t = uint64(block.timestamp);
        for (uint64 i; i < 10; ++i) {
            _post(SYM, (100 + i) * 1e8, t - 1000 + i * 100); // rounds at t-1000, t-900, ..., t-100
        }
        (uint256 p, uint64 ts) = ref.priceAtOrAfter(SYM, t - 1000, "");
        assertEq(p, 100e8);
        assertEq(ts, t - 1000);
        (p, ts) = ref.priceAtOrAfter(SYM, t - 1050, "");
        assertEq(p, 100e8);
        (p, ts) = ref.priceAtOrAfter(SYM, t - 501, "");
        assertEq(p, 105e8);
        assertEq(ts, t - 500);
        (p,) = ref.priceAtOrAfter(SYM, t - 100, "");
        assertEq(p, 109e8);
        vm.expectRevert(abi.encodeWithSelector(DemoSignerReference.NoRoundAtOrAfter.selector, SYM, t - 99));
        ref.priceAtOrAfter(SYM, t - 99, "");
        vm.expectRevert(abi.encodeWithSelector(DemoSignerReference.NoRound.selector, bytes32("NOC")));
        ref.latest(bytes32("NOC"));
    }

    function test_postMany() public {
        uint64 t = uint64(block.timestamp);
        bytes32[] memory syms = new bytes32[](2);
        uint256[] memory ps = new uint256[](2);
        uint64[] memory ts = new uint64[](2);
        bytes[] memory sigs = new bytes[](2);
        syms[0] = SYM;
        syms[1] = bytes32("NOC");
        ps[0] = 10e8;
        ps[1] = 20e8;
        ts[0] = t;
        ts[1] = t;
        sigs[0] = _sig(PK, SYM, 10e8, t);
        sigs[1] = _sig(PK, bytes32("NOC"), 20e8, t);
        ref.postMany(syms, ps, ts, sigs);
        (uint256 p,,) = ref.latest(bytes32("NOC"));
        assertEq(p, 20e8);
        vm.expectRevert(DemoSignerReference.LengthMismatch.selector);
        ref.postMany(syms, new uint256[](1), ts, sigs);
    }
}

contract PythReferenceTest is Test {
    bytes32 internal constant SYM = bytes32("BTC");
    bytes32 internal constant ID = keccak256("BTC/USD");
    MockPyth internal pyth;
    PythReference internal ref;
    address internal owner = makeAddr("owner");

    function setUp() public {
        vm.warp(1_800_000_000);
        pyth = new MockPyth(1 wei);
        // this test contract plays the book
        ref = new PythReference(owner, address(pyth), 60, address(this));
        vm.prank(owner);
        ref.setPriceId(SYM, ID);
        vm.deal(address(ref), 1 ether);
    }

    function _update(int64 price, int32 expo, uint64 publishTime, uint64 prev) internal view returns (bytes memory) {
        return pyth.encodeUpdate(ID, price, expo, publishTime, prev);
    }

    function _proof(int64 price, int32 expo, uint64 publishTime, uint64 prev) internal view returns (bytes memory) {
        bytes[] memory u = new bytes[](1);
        u[0] = _update(price, expo, publishTime, prev);
        return abi.encode(u);
    }

    function test_priceAtOrAfter_parsesFirstObservation() public {
        uint64 t = uint64(block.timestamp - 100);
        uint256 balBefore = address(ref).balance;
        (uint256 p, uint64 ts) = ref.priceAtOrAfter(SYM, t, _proof(65_000_12345678, -8, t + 2, t - 3));
        assertEq(p, 65_000_12345678);
        assertEq(ts, t + 2);
        assertEq(address(ref).balance, balBefore - 1, "update fee paid");
    }

    function test_latestReadsStoredPrice() public {
        uint64 t = uint64(block.timestamp - 100);
        bytes[] memory u = new bytes[](1);
        u[0] = _update(70_000e8, -8, t, t - 1);
        pyth.updatePriceFeeds{value: 1}(u);
        (uint256 lp, uint64 lts, uint8 tier) = ref.latest(SYM);
        assertEq(lp, 70_000e8);
        assertEq(lts, t);
        assertEq(tier, 1);
    }

    /// A later update inside the window is not the first observation and is rejected.
    function test_priceAtOrAfter_rejectsLaterThanFirst() public {
        uint64 t = uint64(block.timestamp - 100);
        // authentic updates at t + 1 (prev t - 5) and t + 30 (prev t + 1): only the first one qualifies
        bytes memory second = _proof(110e8, -8, t + 30, t + 1);
        vm.expectRevert(MockPyth.PriceFeedNotFoundWithinRange.selector);
        ref.priceAtOrAfter(SYM, t, second);
        (uint256 p, uint64 ts) = ref.priceAtOrAfter(SYM, t, _proof(100e8, -8, t + 1, t - 5));
        assertEq(p, 100e8);
        assertEq(ts, t + 1);
    }

    /// A newer stored price (published after the window) does not block a historical settlement.
    function test_priceAtOrAfter_ignoresNewerStoredPrice() public {
        uint64 t = uint64(block.timestamp - 100);
        bytes[] memory u = new bytes[](1);
        u[0] = _update(120e8, -8, t + 61, t + 60);
        pyth.updatePriceFeeds{value: 1}(u);
        (uint256 p, uint64 ts) = ref.priceAtOrAfter(SYM, t, _proof(100e8, -8, t + 1, t - 5));
        assertEq(p, 100e8);
        assertEq(ts, t + 1);
    }

    function test_priceAtOrAfter_rejectsEarlyAndLate() public {
        uint64 t = uint64(block.timestamp - 100);
        bytes memory early = _proof(1e8, -8, t - 1, t - 2);
        bytes memory late = _proof(1e8, -8, t + 61, t - 1);
        bytes memory ok = _proof(1e8, -8, t, t - 1);
        vm.expectRevert(MockPyth.PriceFeedNotFoundWithinRange.selector);
        ref.priceAtOrAfter(SYM, t, early);
        vm.expectRevert(MockPyth.PriceFeedNotFoundWithinRange.selector);
        ref.priceAtOrAfter(SYM, t, late);
        vm.expectRevert(abi.encodeWithSelector(PythReference.FutureTime.selector, uint64(block.timestamp + 1)));
        ref.priceAtOrAfter(SYM, uint64(block.timestamp + 1), ok);
        vm.expectRevert(abi.encodeWithSelector(PythReference.NoPriceId.selector, bytes32("ETH")));
        ref.priceAtOrAfter(bytes32("ETH"), t, ok);
    }

    /// Only the book spends the fee balance.
    function test_priceAtOrAfter_onlyBook() public {
        uint64 t = uint64(block.timestamp - 100);
        bytes memory ok = _proof(1e8, -8, t, t - 1);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(PythReference.OnlyBook.selector);
        ref.priceAtOrAfter(SYM, t, ok);
        assertEq(address(ref).balance, 1 ether, "no fee spent");
    }

    function test_priceAtOrAfter_feeTooHigh() public {
        PythReference poor = new PythReference(owner, address(pyth), 60, address(this));
        vm.prank(owner);
        poor.setPriceId(SYM, ID);
        uint64 t = uint64(block.timestamp - 10);
        bytes memory proof = _proof(1e8, -8, t, t - 1);
        vm.expectRevert(abi.encodeWithSelector(PythReference.FeeTooHigh.selector, 1, 0));
        poor.priceAtOrAfter(SYM, t, proof);
    }

    function test_exponentScaling() public {
        uint64 t = uint64(block.timestamp - 100);
        (uint256 p,) = ref.priceAtOrAfter(SYM, t, _proof(123_456, -5, t, t - 1)); // 1.23456
        assertEq(p, 123_456_000);
        (p,) = ref.priceAtOrAfter(SYM, t, _proof(12_345_678_912, -10, t + 1, t - 1)); // 1.2345678912
        assertEq(p, 123_456_789);
        (p,) = ref.priceAtOrAfter(SYM, t, _proof(7, 2, t + 2, t - 1)); // 700
        assertEq(p, 700e8);
        bytes memory negative = _proof(-1, -8, t + 3, t - 1);
        vm.expectRevert(PriceScale.NonPositivePrice.selector);
        ref.priceAtOrAfter(SYM, t, negative);
    }

    function test_onlyOwnerSetsIds() public {
        vm.expectRevert();
        ref.setPriceId(SYM, bytes32(0));
    }
}

contract AggregatorReferenceTest is Test {
    bytes32 internal constant SYM = bytes32("NVDA");
    address internal owner = makeAddr("owner");
    MockAggregator internal agg;
    ChainlinkReference internal cl;
    uint64 internal T;

    function setUp() public {
        vm.warp(1_800_000_000);
        T = uint64(block.timestamp);
        agg = new MockAggregator(8);
        cl = new ChainlinkReference(owner);
        vm.prank(owner);
        cl.setFeed(SYM, address(agg));
        // phase 1, rounds 1..10 every 60 s, ending at T - 60
        for (uint64 i = 1; i <= 10; ++i) {
            agg.push(agg.roundId(1, i), int256(uint256(100e8 + i * 1e8)), T - 660 + i * 60);
        }
    }

    function test_latestAndTier() public view {
        (uint256 p, uint64 ts, uint8 tier) = cl.latest(SYM);
        assertEq(p, 110e8);
        assertEq(ts, T - 60);
        assertEq(tier, 1);
    }

    function test_walkWithoutHint() public view {
        // round i at T - 660 + 60 i. First round at or after T - 300 is i = 6 (T - 300).
        (uint256 p, uint64 ts) = cl.priceAtOrAfter(SYM, T - 300, "");
        assertEq(p, 106e8);
        assertEq(ts, T - 300);
        // between rounds: T - 299 -> i = 7
        (p, ts) = cl.priceAtOrAfter(SYM, T - 299, "");
        assertEq(p, 107e8);
        // before the first round of the phase: the first round
        (p,) = cl.priceAtOrAfter(SYM, T - 10_000, "");
        assertEq(p, 101e8);
    }

    function test_walkAfterLatestReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AggregatorReference.NoRoundAtOrAfter.selector, SYM, T - 59));
        cl.priceAtOrAfter(SYM, T - 59, "");
    }

    function test_hint() public {
        uint80 r6 = agg.roundId(1, 6);
        (uint256 p,) = cl.priceAtOrAfter(SYM, T - 300, abi.encode(r6));
        assertEq(p, 106e8);
        // hint too late: round 7 has a predecessor (6) also at or after t
        uint80 r7 = agg.roundId(1, 7);
        vm.expectRevert(abi.encodeWithSelector(AggregatorReference.BadHint.selector, r7));
        cl.priceAtOrAfter(SYM, T - 300, abi.encode(r7));
        // hint too early: round 5 is before t
        uint80 r5 = agg.roundId(1, 5);
        vm.expectRevert(abi.encodeWithSelector(AggregatorReference.BadHint.selector, r5));
        cl.priceAtOrAfter(SYM, T - 300, abi.encode(r5));
        // unknown round
        uint80 r99 = agg.roundId(1, 99);
        vm.expectRevert(abi.encodeWithSelector(AggregatorReference.BadHint.selector, r99));
        cl.priceAtOrAfter(SYM, T - 300, abi.encode(r99));
        vm.expectRevert(AggregatorReference.BadProof.selector);
        cl.priceAtOrAfter(SYM, T - 300, hex"01");
    }

    function test_walkTooLong() public {
        MockAggregator a = new MockAggregator(8);
        for (uint64 i = 1; i <= 80; ++i) {
            a.push(a.roundId(1, i), 1e8, T - 1000 + i);
        }
        vm.prank(owner);
        cl.setFeed(bytes32("X"), address(a));
        vm.expectRevert(abi.encodeWithSelector(AggregatorReference.WalkTooLong.selector, bytes32("X"), T - 999));
        cl.priceAtOrAfter(bytes32("X"), T - 999, "");
        (uint256 p,) = cl.priceAtOrAfter(bytes32("X"), T - 999, abi.encode(a.roundId(1, 1)));
        assertEq(p, 1e8);
    }

    function test_decimalsScalingAndNoFeed() public {
        MockAggregator a18 = new MockAggregator(18);
        a18.push(a18.roundId(1, 1), 2_500_123456789012345678, T);
        vm.prank(owner);
        cl.setFeed(bytes32("ETH"), address(a18));
        (uint256 p,,) = cl.latest(bytes32("ETH"));
        assertEq(p, 2_500_12345678);
        vm.expectRevert(abi.encodeWithSelector(AggregatorReference.NoFeed.selector, bytes32("Q")));
        cl.latest(bytes32("Q"));
    }

    /// A predecessor the feed does not return is unknown history, not a phase boundary.
    function test_missingPredecessorReverts() public {
        // a view that serves only the current confirmed round: round 11 exists, round 10 does not
        MockAggregator g = new MockAggregator(8);
        g.push(11, 120e8, T - 10);
        vm.prank(owner);
        cl.setFeed(bytes32("G"), address(g));
        vm.expectRevert(abi.encodeWithSelector(AggregatorReference.UnknownHistory.selector, uint80(10)));
        cl.priceAtOrAfter(bytes32("G"), T - 100, "");
        vm.expectRevert(abi.encodeWithSelector(AggregatorReference.UnknownHistory.selector, uint80(10)));
        cl.priceAtOrAfter(bytes32("G"), T - 100, abi.encode(uint80(11)));
        // the feed's very first round needs no predecessor
        MockAggregator g1 = new MockAggregator(8);
        g1.push(1, 99e8, T - 10);
        vm.prank(owner);
        cl.setFeed(bytes32("G1"), address(g1));
        (uint256 p,) = cl.priceAtOrAfter(bytes32("G1"), T - 100, "");
        assertEq(p, 99e8);
    }

    /// The first round of a later phase cannot be proven first, by hint or by walk.
    function test_phaseBoundaryReverts() public {
        // phase 1 ends at T - 60 (round 10); phase 2 starts at T + 3600
        vm.warp(T + 4000);
        uint80 p2r1 = agg.roundId(2, 1);
        agg.push(p2r1, 150e8, T + 3600);
        agg.push(agg.roundId(2, 2), 151e8, T + 3700);
        vm.expectRevert(abi.encodeWithSelector(AggregatorReference.PhaseBoundary.selector, p2r1));
        cl.priceAtOrAfter(SYM, T - 30, abi.encode(p2r1));
        vm.expectRevert(abi.encodeWithSelector(AggregatorReference.PhaseBoundary.selector, p2r1));
        cl.priceAtOrAfter(SYM, T - 30, "");
        // inside phase 2 the walk and the hint still work
        (uint256 p,) = cl.priceAtOrAfter(SYM, T + 3650, "");
        assertEq(p, 151e8);
        // a phase 1 round at or after t is still found by hint
        (p,) = cl.priceAtOrAfter(SYM, T - 61, abi.encode(agg.roundId(1, 10)));
        assertEq(p, 110e8);
    }

    function test_ondoTier2() public {
        OndoReference ondo = new OndoReference(owner);
        vm.prank(owner);
        ondo.setFeed(SYM, address(agg));
        (uint256 p,, uint8 tier) = ondo.latest(SYM);
        assertEq(p, 110e8);
        assertEq(tier, 2);
        (p,) = ondo.priceAtOrAfter(SYM, T - 120, "");
        assertEq(p, 109e8);
    }
}
