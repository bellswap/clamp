// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BookFixture} from "./BookFixture.sol";
import {TicketBook} from "../src/TicketBook.sol";
import {IReference} from "../src/interfaces/IReference.sol";
import {PriceScale} from "../src/libraries/PriceScale.sol";
import {ChainlinkReference} from "../src/references/ChainlinkReference.sol";
import {PythReference} from "../src/references/PythReference.sol";
import {DemoSignerReference} from "../src/references/DemoSignerReference.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockPyth} from "./mocks/MockPyth.sol";

/// @dev A reference whose latest price is 0 (an adapter without the zero guard).
contract ZeroLatestReference is IReference {
    function latest(bytes32) external view returns (uint256, uint64, uint8) {
        return (0, uint64(block.timestamp), 0);
    }

    function priceAtOrAfter(bytes32, uint64, bytes calldata) external view returns (uint256, uint64) {
        return (0, uint64(block.timestamp));
    }
}

/// Regression tests for the Codex audit of 2026-10-23 (F1 documented, F2 to F6 fixed).
contract ClampAuditTest is BookFixture {
    bytes32 internal constant TINY = bytes32("TINY");
    bytes32 internal constant PID = bytes32("pid");
    uint256 internal constant HI = type(uint192).max;

    // ------------------------------------------------------------ F2: zero normalised entry price

    function test_F2_aggregatorZeroScaledLatestReverts() public {
        MockAggregator agg = new MockAggregator(18);
        ChainlinkReference cl = new ChainlinkReference(house);
        vm.startPrank(house);
        cl.setFeed(TINY, address(agg));
        book.listMarket(TINY, address(cl), 20, 1_000 * USD, 50_000 * USD, 1 days);
        vm.stopPrank();
        agg.push(agg.roundId(1, 1), 1, block.timestamp); // 1 wei at 18 decimals scales to 0

        vm.expectRevert(PriceScale.ZeroScaledPrice.selector);
        cl.latest(TINY);
        uint256 res0 = vault.reserved();
        vm.prank(alice);
        vm.expectRevert(PriceScale.ZeroScaledPrice.selector);
        book.open(TINY, true, 20, 100 * USD, 1);
        assertEq(vault.reserved(), res0, "nothing reserved");
    }

    function test_F2_pythZeroScaledLatestReverts() public {
        MockPyth pyth = new MockPyth(1 wei);
        PythReference pr = new PythReference(house, address(pyth), 60, address(book));
        vm.startPrank(house);
        pr.setPriceId(TINY, PID);
        book.listMarket(TINY, address(pr), 20, 1_000 * USD, 50_000 * USD, 1 days);
        vm.stopPrank();
        bytes[] memory u = new bytes[](1);
        u[0] = pyth.encodeUpdate(PID, 1, -9, uint64(block.timestamp), uint64(block.timestamp - 1));
        pyth.updatePriceFeeds{value: 1 wei}(u);

        vm.expectRevert(PriceScale.ZeroScaledPrice.selector);
        pr.latest(TINY);
        vm.prank(alice);
        vm.expectRevert(PriceScale.ZeroScaledPrice.selector);
        book.open(TINY, true, 20, 100 * USD, 1);
    }

    /// The book's own layer: a reference that returns 0 from `latest` cannot open a ticket.
    function test_F2_checkOpenRejectsZeroEntry() public {
        ZeroLatestReference z = new ZeroLatestReference();
        vm.prank(house);
        book.listMarket(TINY, address(z), 20, 1_000 * USD, 50_000 * USD, 1 days);
        uint256 res0 = vault.reserved();
        vm.prank(alice);
        vm.expectRevert(TicketBook.ZeroPrice.selector);
        book.open(TINY, true, 20, 100 * USD, 1);
        assertEq(vault.reserved(), res0, "nothing reserved");
        vm.expectRevert(TicketBook.ZeroPrice.selector);
        book.payoutFor(true, 20, 99e6, 0, 100e8);
    }

    /// A settlement price that scales to 0 stays a valid outcome (full loss for the long), so it does not lock.
    function test_F2_zeroScaledSettlePriceStillSettles() public {
        MockAggregator agg = new MockAggregator(18);
        ChainlinkReference cl = new ChainlinkReference(house);
        vm.startPrank(house);
        cl.setFeed(TINY, address(agg));
        book.listMarket(TINY, address(cl), 20, 1_000 * USD, 50_000 * USD, 1 days);
        vm.stopPrank();
        agg.push(agg.roundId(1, 1), 2000e18, block.timestamp);
        uint256 res0 = vault.reserved();
        uint256 id = _open(alice, TINY, true, 20, 100 * USD, 1);
        TicketBook.Ticket memory t = book.getTicket(id);
        assertEq(t.entryPrice8, 2000e8);

        vm.warp(t.expiry);
        agg.push(agg.roundId(1, 2), 1, t.expiry);
        uint256 payout = book.settle(id, abi.encode(agg.roundId(1, 2)));
        assertEq(payout, 0, "full loss");
        assertEq(book.getTicket(id).status, book.STATUS_SETTLED());
        assertEq(vault.reserved(), res0, "reservation released");
    }

    // ------------------------------------------------------------ F3: reference swap with open tickets

    function test_F3_referenceSwapWithOpenTicketsReverts() public {
        uint256 seed = _open(alice, NVDA, true, 1, 10 * USD, 0);
        DemoSignerReference refB = new DemoSignerReference(signerAddr);
        (,,,,,, uint256 oi) = book.markets(NVDA);
        assertEq(oi, 10 * USD);

        vm.prank(house);
        vm.expectRevert(abi.encodeWithSelector(TicketBook.ReferenceLocked.selector, NVDA, 10 * USD));
        book.listMarket(NVDA, address(refB), 20, 1_000 * USD, 50_000 * USD, 1 days);

        // a parameter update that keeps the reference still works with open tickets
        vm.prank(house);
        book.listMarket(NVDA, address(ref), 10, 1_000 * USD, 50_000 * USD, 1 days);

        // the ReproF3 scenario now settles flat at 99 USDG on the one reference
        uint256 id = _open(bob, NVDA, true, 2, 100 * USD, 0);
        assertEq(book.getTicket(id).expiry, book.getTicket(seed).expiry, "same bucket");
        assertEq(book.getTicket(id).entryPrice8, 100e8);
        _expireAt(id, 100e8);
        assertEq(book.settle(id, ""), 99 * USD);
    }

    function test_F3_referenceSwapAllowedWhenNothingOpen() public {
        uint256 id = _open(alice, NVDA, true, 2, 10 * USD, 0);
        _expireAt(id, 100e8);
        book.settle(id, "");

        DemoSignerReference refB = new DemoSignerReference(signerAddr);
        refB.post(NVDA, 50e8, uint64(block.timestamp), _sign(SIGNER_PK, refB, NVDA, 50e8, uint64(block.timestamp)));
        vm.prank(house);
        book.listMarket(NVDA, address(refB), 20, 1_000 * USD, 50_000 * USD, 1 days);
        (IReference r,,,,,,) = book.markets(NVDA);
        assertEq(address(r), address(refB));

        uint256 id2 = _open(bob, NVDA, true, 2, 100 * USD, 0);
        TicketBook.Ticket memory t2 = book.getTicket(id2);
        assertEq(t2.entryPrice8, 50e8, "entry from B");
        assertGt(t2.expiry, book.getTicket(id).expiry, "a new bucket");
        (IReference br,,,,,,,,,) = book.buckets(book.bucketKey(NVDA, t2.expiry));
        assertEq(address(br), address(refB), "bucket on B");
    }

    // ------------------------------------------------------------ F4: padded Pyth updates

    function test_F4_paddedUpdatesRejected() public {
        MockPyth pyth = new MockPyth(1 wei);
        PythReference pr = new PythReference(house, address(pyth), 60, address(book));
        bytes32 nid = keccak256("SPY/USD");
        vm.startPrank(house);
        book.listMarket(SPY, address(pr), 20, 1_000 * USD, 50_000 * USD, 1 days);
        pr.setPriceId(SPY, nid);
        vm.stopPrank();
        vm.deal(address(pr), 100 wei);
        bytes[] memory s = new bytes[](1);
        s[0] = pyth.encodeUpdate(nid, 500e8, -8, uint64(block.timestamp), uint64(block.timestamp - 1));
        pyth.updatePriceFeeds{value: 1}(s);

        uint256 id = _open(alice, SPY, true, 2, 10 * USD, 0);
        uint64 t = book.getTicket(id).expiry;
        vm.warp(t + 10);
        bytes memory upd = pyth.encodeUpdate(nid, 505e8, -8, t + 1, t - 1);
        bytes[] memory padded = new bytes[](100);
        for (uint256 i; i < 100; ++i) {
            padded[i] = upd;
        }

        vm.expectRevert(abi.encodeWithSelector(PythReference.BadUpdateCount.selector, 100));
        book.settle(id, abi.encode(padded));
        vm.expectRevert(abi.encodeWithSelector(PythReference.BadUpdateCount.selector, 0));
        book.settle(id, abi.encode(new bytes[](0)));
        assertEq(address(pr).balance, 100, "no fee paid");

        bytes[] memory one = new bytes[](1);
        one[0] = upd;
        book.settle(id, abi.encode(one));
        assertEq(address(pr).balance, 99, "one update costs 1 wei");
        assertEq(book.getTicket(id).settlePrice8, 505e8);
    }

    // ------------------------------------------------------------ F6: clamp before the division

    function test_F6_extremeRatiosClampInsteadOfRevert() public view {
        assertEq(book.multiplierFor(true, 20, 1, HI), 20 * WAD_);
        assertEq(book.multiplierFor(false, 20, 1, HI), 0);
        assertEq(book.multiplierFor(true, 1, 1, type(uint256).max), WAD_);
        assertEq(book.multiplierFor(false, 1, 1, type(uint256).max), 0);
    }

    function test_F6_settleEndToEndPaysCap() public {
        vm.warp(T0 + 1);
        _post(NVDA, 1, uint64(block.timestamp));
        uint256 idL = _open(alice, NVDA, true, 20, 100 * USD, 0);
        uint256 idS = _open(bob, NVDA, false, 20, 100 * USD, 0);
        uint256 res0 = vault.reserved();
        _expireAt(idL, HI);
        assertEq(book.settle(idL, ""), _net(100 * USD) * 20, "long capped at 20x");
        assertEq(book.settle(idS, ""), 0, "short floored at 0");
        assertEq(vault.reserved(), res0 - 2 * _net(100 * USD) * 20, "both reservations released");
    }

    /// The pre-fix formula (division first, then clamp), for the ranges where it does not overflow.
    function _oldMultiplier(bool long, uint8 leverage, uint256 entry8, uint256 settle8)
        internal
        pure
        returns (uint256)
    {
        uint256 cap = uint256(leverage) * WAD_;
        bool up = settle8 >= entry8;
        uint256 diff = up ? settle8 - entry8 : entry8 - settle8;
        bool gain = (up == long) || diff == 0;
        if (gain) {
            uint256 m = WAD_ + Math.mulDiv(diff, cap, entry8, Math.Rounding.Floor);
            return m > cap ? cap : m;
        }
        uint256 loss = Math.mulDiv(diff, cap, entry8, Math.Rounding.Ceil);
        return loss >= WAD_ ? 0 : WAD_ - loss;
    }

    function testFuzz_F6_matchesOldFormulaBitForBit(bool long, uint8 lev, uint256 entry8, uint256 settle8) public view {
        lev = uint8(bound(lev, 0, 20));
        entry8 = bound(entry8, 1, type(uint128).max);
        settle8 = bound(settle8, 0, type(uint128).max);
        assertEq(book.multiplierFor(long, lev, entry8, settle8), _oldMultiplier(long, lev, entry8, settle8));
    }

    uint256 internal constant WAD_ = 1e18;

    // ------------------------------------------------------------ F1: documented, not changed

    /// DemoSignerReference stores rounds of a symbol in strictly increasing order. With two signed rounds of one symbol
    /// outstanding, a relayer that posts the later one first makes the earlier one unstorable, and settlement uses the
    /// later round. Documented in the README limitations; the contract is unchanged.
    function test_F1_documented_strictOrderSkipsEarlierRound() public {
        uint256 id = _open(alice, NVDA, true, 2, 100 * USD, 1);
        uint64 e = book.getTicket(id).expiry;
        vm.warp(e + 2);
        bytes memory sig1 = _sign(SIGNER_PK, ref, NVDA, 100e8, e + 1);
        bytes memory sig2 = _sign(SIGNER_PK, ref, NVDA, 150e8, e + 2);

        vm.prank(makeAddr("relayer"));
        ref.post(NVDA, 150e8, e + 2, sig2);
        vm.expectRevert(abi.encodeWithSelector(DemoSignerReference.OutOfOrder.selector, e + 2, e + 1));
        ref.post(NVDA, 100e8, e + 1, sig1);

        assertEq(book.settle(id, ""), 198 * USD, "settled on the later round, 150");
        assertEq(book.getTicket(id).settlePrice8, 150e8);
    }
}

contract Token18 is ERC20 {
    constructor() ERC20("USDG18", "USDG") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// F5 and CONTRACTS-9: the deploy script refuses a non-6-decimal USDG and a FEE_BPS that would truncate.
/// One test function, because the environment is shared by the whole test process.
contract DeployGuardTest is Test {
    function test_F5_deployRejectsWrongDecimalsAndTruncatedFee() public {
        vm.chainId(31337);
        Token18 t = new Token18();
        t.mint(address(this), 10_000_000e18);
        vm.setEnv("DEMO_SIGNER", vm.toString(vm.addr(0xA11CE)));
        vm.setEnv("USDG", vm.toString(address(t)));

        // 65,636 = 65,536 + 100 was truncated to 100 by uint16 before the cap check
        vm.setEnv("FEE_BPS", "65636");
        Deploy d = new Deploy();
        vm.expectRevert(abi.encodeWithSelector(Deploy.FeeOutOfRange.selector, 65636));
        d.run();
        vm.setEnv("FEE_BPS", "1001");
        vm.expectRevert(abi.encodeWithSelector(Deploy.FeeOutOfRange.selector, 1001));
        d.run();

        vm.setEnv("FEE_BPS", "100");
        vm.expectRevert(abi.encodeWithSelector(Deploy.BadUsdgDecimals.selector, uint8(18)));
        d.run();

        vm.setEnv("USDG", vm.toString(address(0)));
    }
}
