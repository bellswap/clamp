// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {BookFixture} from "./BookFixture.sol";
import {TicketBook} from "../src/TicketBook.sol";
import {HouseVault} from "../src/HouseVault.sol";

contract TicketBookTest is BookFixture {
    function test_open_pullsStakeIntoVaultAndReserves() public {
        uint256 stake = 100 * USD;
        uint256 vaultBefore = usdg.balanceOf(address(vault));
        vm.expectEmit(true, true, true, true, address(book));
        emit TicketBook.TicketOpened(1, alice, NVDA, true, 5, stake, 100e8, uint64(T0 + 9 hours));
        uint256 id = _open(alice, NVDA, true, 5, stake, 0);
        assertEq(id, 1);
        TicketBook.Ticket memory t = book.getTicket(id);
        assertEq(t.owner, alice);
        assertEq(t.stake, stake);
        assertEq(t.reserved, _net(stake) * 5);
        assertEq(t.status, book.STATUS_OPEN());
        assertEq(t.expiry, T0 + 9 hours); // next 21:00 UTC
        assertEq(usdg.balanceOf(address(vault)), vaultBefore + stake, "whole stake (fee included) in the vault");
        assertEq(usdg.balanceOf(address(book)), 0, "book keeps nothing");
        assertEq(vault.reserved(), _net(stake) * 5);
        assertEq(book.netStake(id), 99 * USD);
        (,,,,,, uint256 oi) = book.markets(NVDA);
        assertEq(oi, stake);
    }

    function test_open_reverts() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(TicketBook.NotListed.selector, bytes32("ZZZ")));
        book.open(bytes32("ZZZ"), true, 2, 10 * USD, 0);
        vm.expectRevert(abi.encodeWithSelector(TicketBook.BadLeverage.selector, uint8(0), uint8(20)));
        book.open(NVDA, true, 0, 10 * USD, 0);
        vm.expectRevert(abi.encodeWithSelector(TicketBook.BadLeverage.selector, uint8(21), uint8(20)));
        book.open(NVDA, true, 21, 10 * USD, 0);
        vm.expectRevert(abi.encodeWithSelector(TicketBook.BadStake.selector, 0, 1_000 * USD));
        book.open(NVDA, true, 2, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(TicketBook.BadStake.selector, 1_001 * USD, 1_000 * USD));
        book.open(NVDA, true, 2, 1_001 * USD, 0);
        vm.expectRevert(abi.encodeWithSelector(TicketBook.BadHorizon.selector, uint8(3)));
        book.open(NVDA, true, 2, 10 * USD, 3);
        vm.stopPrank();
    }

    function test_open_staleReverts() public {
        vm.warp(T0 + 1 days); // exactly maxStaleness old: still fresh
        _open(alice, NVDA, true, 2, 10 * USD, 1);
        vm.warp(T0 + 1 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TicketBook.Stale.selector, uint64(T0), uint64(1 days)));
        _open(alice, NVDA, true, 2, 10 * USD, 1);
    }

    function test_open_oiCapReverts() public {
        vm.prank(house);
        book.listMarket(NVDA, address(ref), 20, 1_000 * USD, 2_500 * USD, 1 days);
        _open(alice, NVDA, true, 2, 1_000 * USD, 0);
        _open(bob, NVDA, false, 2, 1_000 * USD, 0);
        vm.expectRevert(abi.encodeWithSelector(TicketBook.OiCap.selector, 3_000 * USD, 2_500 * USD));
        _open(alice, NVDA, true, 2, 1_000 * USD, 0);
        _open(alice, NVDA, true, 2, 500 * USD, 0); // exactly at the cap
    }

    function test_open_insufficientVaultLiquidityReverts() public {
        // a fresh book and vault with 5,000 USDG of LP money
        HouseVault v = new HouseVault(usdg, house);
        TicketBook b = new TicketBook(usdg, v, house, FEE_BPS);
        vm.startPrank(house);
        v.setBook(address(b));
        b.listMarket(NVDA, address(ref), 20, 1_000 * USD, 50_000 * USD, 1 days);
        vm.stopPrank();
        usdg.mint(address(this), 5_000 * USD);
        usdg.approve(address(v), type(uint256).max);
        v.deposit(5_000 * USD, address(this));
        vm.startPrank(alice);
        usdg.approve(address(b), type(uint256).max);
        // 1,000 stake at 20x: worst case 19,800 > 5,000 + 1,000
        vm.expectRevert(abi.encodeWithSelector(HouseVault.InsufficientFree.selector, 19_800 * USD, 6_000 * USD));
        b.open(NVDA, true, 20, 1_000 * USD, 0);
        // 1,000 stake at 6x: worst case 5,940 <= 6,000
        b.open(NVDA, true, 6, 1_000 * USD, 0);
        vm.stopPrank();
        assertEq(v.free(), 60 * USD);
    }

    function test_settle_beforeExpiryReverts() public {
        uint256 id = _open(alice, NVDA, true, 5, 100 * USD, 0);
        TicketBook.Ticket memory t = book.getTicket(id);
        vm.warp(t.expiry - 1);
        vm.expectRevert(abi.encodeWithSelector(TicketBook.NotExpired.selector, id, t.expiry));
        book.settle(id, "");
    }

    function test_settle_twiceReverts() public {
        uint256 id = _open(alice, NVDA, true, 5, 100 * USD, 0);
        _expireAt(id, 110e8);
        book.settle(id, "");
        vm.expectRevert(abi.encodeWithSelector(TicketBook.NotOpen.selector, id));
        book.settle(id, "");
        vm.expectRevert(abi.encodeWithSelector(TicketBook.NotOpen.selector, 99));
        book.settle(99, "");
    }

    function test_settle_noRoundYetReverts() public {
        uint256 id = _open(alice, NVDA, true, 5, 100 * USD, 0);
        TicketBook.Ticket memory t = book.getTicket(id);
        vm.warp(t.expiry);
        vm.expectRevert();
        book.settle(id, "");
        vm.warp(t.expiry + 30);
        _post(NVDA, 101e8, t.expiry + 30);
        book.settle(id, "");
        assertEq(book.getTicket(id).settlePrice8, 101e8);
    }

    function test_settle_paysOwnerAndReleases() public {
        uint256 stake = 100 * USD;
        uint256 id = _open(alice, NVDA, true, 5, stake, 0);
        uint256 aliceBefore = usdg.balanceOf(alice);
        _expireAt(id, 110e8);
        vm.expectEmit(true, false, false, true, address(book));
        emit TicketBook.TicketSettled(id, 110e8, 148_500_000);
        vm.prank(bob); // permissionless
        uint256 payout = book.settle(id, "");
        assertEq(payout, _net(stake) * 15 / 10); // 99 * 1.5
        assertEq(usdg.balanceOf(alice), aliceBefore + payout);
        assertEq(vault.reserved(), 0);
        TicketBook.Ticket memory t = book.getTicket(id);
        assertEq(t.status, book.STATUS_SETTLED());
        assertEq(t.payout, payout);
        (,,,,,, uint256 oi) = book.markets(NVDA);
        assertEq(oi, 0);
        // vault keeps stake minus payout: 1,000,000 + 100 - 148.5
        assertEq(usdg.balanceOf(address(vault)), 1_000_000 * USD + stake - payout);
    }

    function test_settle_losingTicketPaysNothing() public {
        uint256 id = _open(alice, NVDA, true, 10, 100 * USD, 0);
        _expireAt(id, 85e8);
        assertEq(book.settle(id, ""), 0);
        assertEq(vault.reserved(), 0);
        assertEq(usdg.balanceOf(address(vault)), 1_000_100 * USD);
    }

    function test_settle_usesFirstRoundAtOrAfterExpiry() public {
        uint256 id = _open(alice, NVDA, true, 2, 100 * USD, 0);
        TicketBook.Ticket memory t = book.getTicket(id);
        vm.warp(t.expiry - 10);
        _post(NVDA, 90e8, t.expiry - 10); // before expiry: ignored
        vm.warp(t.expiry + 100);
        _post(NVDA, 120e8, t.expiry + 5);
        _post(NVDA, 50e8, t.expiry + 50);
        book.settle(id, "");
        assertEq(book.getTicket(id).settlePrice8, 120e8);
    }

    // ------------------------------------------------------------------ netting

    function test_reservation_oppositeSidesReserveFullCaps() public {
        uint256 s = 1_000 * USD;
        uint256 n = _net(s);
        _open(alice, NVDA, true, 10, s, 0);
        assertEq(vault.reserved(), n * 10);
        _open(bob, NVDA, false, 10, s, 0);
        // every ticket's cap, M_l + M_s = 20 n (no opposite-side netting)
        assertEq(vault.reserved(), n * 20);
        _open(bob, NVDA, false, 4, s, 0);
        assertEq(vault.reserved(), n * 24);
    }

    /// A long at 100 and a short at 200 in one bucket, settled at 150, owe 200 + 150 net units; the old
    /// netting bound reserved 300 and the second settlement reverted ReserveInvariant.
    function test_reservation_differentEntriesSettle() public {
        uint256 s = 1_000 * USD;
        uint256 n = _net(s);
        uint256 a = _open(alice, NVDA, true, 2, s, 0); // entry 100
        vm.warp(block.timestamp + 60);
        _post(NVDA, 200e8, uint64(block.timestamp));
        uint256 b = _open(bob, NVDA, false, 2, s, 0); // entry 200
        assertEq(vault.reserved(), n * 4);
        _expireAt(a, 150e8);
        uint256 pa = book.settle(a, "");
        uint256 pb = book.settle(b, "");
        assertEq(pa, n * 2);
        assertEq(pb, n * 3 / 2);
        assertEq(vault.reserved(), 0);
        assertEq(vault.openNet(), 0);
    }

    function test_netting_differentBucketsDoNotNet() public {
        uint256 s = 1_000 * USD;
        uint256 n = _net(s);
        _open(alice, NVDA, true, 10, s, 0); // session
        _open(bob, NVDA, false, 10, s, 1); // day
        assertEq(vault.reserved(), n * 20);
        _open(bob, SPY, false, 10, s, 0); // other symbol, same expiry
        assertEq(vault.reserved(), n * 30);
    }

    function test_netting_settleOrderKeepsVaultSolvent() public {
        uint256 s = 1_000 * USD;
        uint256 n = _net(s);
        uint256 a = _open(alice, NVDA, true, 10, s, 0);
        uint256 b = _open(bob, NVDA, false, 10, s, 0);
        assertEq(vault.reserved(), n * 20);
        _expireAt(a, 200e8); // +100%: long hits the 10x cap, short floors
        uint256 pa = book.settle(a, "");
        assertEq(pa, n * 10);
        // left = 20n - 10n = 10n; bound of the short alone = 10n
        assertEq(vault.reserved(), n * 10);
        assertGe(usdg.balanceOf(address(vault)), vault.reserved());
        uint256 pb = book.settle(b, "");
        assertEq(pb, 0);
        assertEq(vault.reserved(), 0);
    }

    function test_netting_bucketPriceIsFixedAtFirstSettlement() public {
        uint256 a = _open(alice, NVDA, true, 5, 100 * USD, 0);
        uint256 b = _open(bob, NVDA, false, 5, 100 * USD, 0);
        _expireAt(a, 104e8);
        book.settle(a, "");
        // a new round arrives; b still settles at the bucket price
        vm.warp(block.timestamp + 1 hours);
        _post(NVDA, 80e8, uint64(block.timestamp));
        book.settle(b, "");
        assertEq(book.getTicket(b).settlePrice8, 104e8);
        assertEq(vault.reserved(), 0);
    }

    // ------------------------------------------------------------------ horizons

    function test_expiry_horizons() public view {
        // 12:00 UTC -> 21:00 same day
        assertEq(book.expiryFor(0, uint64(T0)), T0 + 9 hours);
        // exactly 21:00 -> next day 21:00
        assertEq(book.expiryFor(0, uint64(T0 + 9 hours)), T0 + 9 hours + 1 days);
        // 21:30 -> next day 21:00
        assertEq(book.expiryFor(0, uint64(T0 + 9 hours + 30 minutes)), T0 + 9 hours + 1 days);
        // day: +24 h on the hour stays, off the hour rounds up
        assertEq(book.expiryFor(1, uint64(T0)), T0 + 1 days);
        assertEq(book.expiryFor(1, uint64(T0 + 1)), T0 + 1 days + 1 hours);
        assertEq(book.expiryFor(2, uint64(T0 + 59 minutes)), T0 + 7 days + 1 hours);
    }

    // ------------------------------------------------------------------ owner

    function test_pause_blocksOpenNotSettle() public {
        uint256 id = _open(alice, NVDA, true, 5, 100 * USD, 0);
        vm.prank(house);
        book.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _open(alice, NVDA, true, 5, 100 * USD, 0);
        _expireAt(id, 101e8);
        book.settle(id, "");
        vm.prank(house);
        book.unpause();
        _open(alice, NVDA, true, 5, 100 * USD, 1);
    }

    function test_onlyOwner() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        book.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        book.listMarket(bytes32("X"), address(ref), 5, 1, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        book.setFee(0);
        vm.stopPrank();
    }

    function test_listMarket_validation() public {
        vm.startPrank(house);
        vm.expectRevert(abi.encodeWithSelector(TicketBook.BadMaxLeverage.selector, uint8(21)));
        book.listMarket(bytes32("X"), address(ref), 21, 1, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(TicketBook.BadMaxLeverage.selector, uint8(0)));
        book.listMarket(bytes32("X"), address(ref), 0, 1, 1, 1);
        vm.expectRevert(TicketBook.ZeroAddress.selector);
        book.listMarket(bytes32("X"), address(0), 5, 1, 1, 1);
        vm.expectRevert(TicketBook.ZeroSymbol.selector);
        book.listMarket(bytes32(0), address(ref), 5, 1, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(TicketBook.FeeTooHigh.selector, uint16(1001)));
        book.setFee(1001);
        book.listMarket(NVDA, address(ref), 3, 1, 1, 1); // relist updates, no duplicate symbol
        vm.stopPrank();
        assertEq(book.listedSymbols().length, 2);
        (, uint8 maxLev,,,,,) = book.markets(NVDA);
        assertEq(maxLev, 3);
    }

    function test_feeStaysInVault() public {
        vm.prank(house);
        book.setFee(1000); // 10%
        uint256 houseBefore = usdg.balanceOf(house);
        uint256 id = _open(alice, NVDA, true, 2, 1_000 * USD, 0);
        assertEq(book.netStake(id), 900 * USD);
        assertEq(usdg.balanceOf(house), houseBefore);
        assertEq(usdg.balanceOf(address(book)), 0);
        _expireAt(id, 100e8); // flat: payout = net
        assertEq(book.settle(id, ""), 900 * USD);
        assertEq(usdg.balanceOf(address(vault)), 1_000_100 * USD);
    }

    function test_currentPayoutAndQuote() public {
        uint256 id = _open(alice, NVDA, false, 4, 100 * USD, 0);
        vm.warp(block.timestamp + 1 hours);
        _post(NVDA, 95e8, uint64(block.timestamp));
        (uint256 p, uint256 price,) = book.currentPayout(id);
        assertEq(price, 95e8);
        assertEq(p, 99 * USD * 12 / 10);
        (uint256 fee, uint256 net, uint256 maxPayout, uint64 expiry) = book.quote(4, 100 * USD, 0);
        assertEq(fee, 1 * USD);
        assertEq(net, 99 * USD);
        assertEq(maxPayout, 396 * USD);
        assertEq(expiry, T0 + 9 hours);
    }
}
