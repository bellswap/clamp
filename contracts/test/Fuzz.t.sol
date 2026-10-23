// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BookFixture} from "./BookFixture.sol";
import {TicketBook} from "../src/TicketBook.sol";

contract FuzzTest is BookFixture {
    /// Payout never above net * L, never negative (unsigned, no revert), never above the exact rational value.
    function testFuzz_payoutBounds(bool long, uint8 lev, uint256 net, uint256 entry, uint256 settle) public view {
        lev = uint8(bound(lev, 1, 20));
        net = bound(net, 0, 1e15);
        entry = bound(entry, 1, 1e20);
        settle = bound(settle, 1, 1e20);
        uint256 m = book.multiplierFor(long, lev, entry, settle);
        uint256 p = book.payoutFor(long, lev, net, entry, settle);
        assertLe(m, uint256(lev) * 1e18, "multiplier above L");
        assertLe(p, net * lev, "payout above net * L");
        // exact: net * clamp(entry + side * L * (settle - entry), 0, L * entry) / entry
        int256 side = long ? int256(1) : int256(-1);
        int256 num = int256(entry) + side * int256(uint256(lev)) * (int256(settle) - int256(entry));
        if (num < 0) num = 0;
        if (num > int256(uint256(lev) * entry)) num = int256(uint256(lev) * entry);
        assertLe(p * entry, net * uint256(num), "payout above the exact value");
        // and within two base units of it (two floor steps)
        assertLe(net * uint256(num), (p + 2) * entry, "payout far below the exact value");
    }

    struct Run {
        uint256 stakes;
        uint256 payouts;
        uint256 peakReserved;
    }

    /// Up to 8 tickets over two symbols and two horizons, any sides and multiples, settled in a shuffled order at
    /// arbitrary moves: the vault never holds less than it reserves, payouts never exceed the reservation, every
    /// reservation is released, and USDG is conserved.
    function testFuzz_bucketAccounting(uint256 seed) public {
        uint256 n = bound(seed, 1, 8);
        uint256 vaultStart = usdg.balanceOf(address(vault));
        uint256[] memory ids = new uint256[](n);
        Run memory run;
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            bytes32 sym = r & 1 == 0 ? NVDA : SPY;
            bool long = (r >> 1) & 1 == 0;
            uint8 lev = uint8(1 + (r >> 8) % 20);
            uint256 stake = 1 + (r >> 16) % (1_000 * USD);
            uint8 horizon = uint8((r >> 64) % 2);
            ids[i] = _open(i % 2 == 0 ? alice : bob, sym, long, lev, stake, horizon);
            run.stakes += stake;
            assertGe(usdg.balanceOf(address(vault)), vault.reserved(), "vault below reservation after open");
        }
        run.peakReserved = vault.reserved();

        // post the prices at both expiries, in time order
        uint64 sessionExp = book.expiryFor(0, uint64(T0));
        uint64 dayExp = book.expiryFor(1, uint64(T0));
        vm.warp(sessionExp);
        _post(NVDA, _move(seed, 1, 100e8), sessionExp);
        _post(SPY, _move(seed, 2, 500e8), sessionExp);
        vm.warp(dayExp);
        _post(NVDA, _move(seed, 3, 100e8), dayExp);
        _post(SPY, _move(seed, 4, 500e8), dayExp);

        // settle in a shuffled order
        for (uint256 i = n; i > 1; --i) {
            uint256 j = uint256(keccak256(abi.encode(seed, "shuffle", i))) % i;
            (ids[i - 1], ids[j]) = (ids[j], ids[i - 1]);
        }
        for (uint256 i; i < n; ++i) {
            TicketBook.Ticket memory t = book.getTicket(ids[i]);
            uint256 p = book.settle(ids[i], "");
            assertLe(p, t.reserved, "payout above the ticket's worst case");
            run.payouts += p;
            assertGe(usdg.balanceOf(address(vault)), vault.reserved(), "vault below reservation after settle");
        }
        assertLe(run.payouts, run.peakReserved, "payouts above the reservation");
        assertEq(vault.reserved(), 0, "reservation left after all settled");
        assertEq(vault.openNet(), 0, "open net stake left after all settled");
        assertEq(usdg.balanceOf(address(vault)), vaultStart + run.stakes - run.payouts, "USDG not conserved");
        assertEq(usdg.balanceOf(address(book)), 0, "book holds USDG");
    }

    /// Up to 8 tickets in one bucket (NVDA, session), any sides and multiples, each opened at a new
    /// entry price, settled at an arbitrary price: every settlement succeeds within the reservation and all of it is
    /// released.
    function testFuzz_differentEntriesSettle(uint256 seed) public {
        uint256 n = bound(seed, 2, 8);
        uint256 vaultStart = usdg.balanceOf(address(vault));
        uint256[] memory ids = new uint256[](n);
        uint256 stakes;
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, "entries", i)));
            vm.warp(block.timestamp + 60);
            _post(NVDA, _move(seed, 10 + i, 100e8), uint64(block.timestamp));
            uint8 lev = uint8(1 + (r >> 8) % 20);
            uint256 stake = 1 + (r >> 16) % (1_000 * USD);
            ids[i] = _open(i % 2 == 0 ? alice : bob, NVDA, (r & 1) == 0, lev, stake, 0);
            stakes += stake;
        }
        uint256 peak = vault.reserved();
        uint64 exp = book.expiryFor(0, uint64(T0));
        vm.warp(exp);
        _post(NVDA, _move(seed, 99, 100e8), exp);
        uint256 payouts;
        for (uint256 i; i < n; ++i) {
            payouts += book.settle(ids[i], "");
            assertGe(usdg.balanceOf(address(vault)), vault.reserved(), "vault below reservation after settle");
        }
        assertLe(payouts, peak, "payouts above the reservation");
        assertEq(vault.reserved(), 0, "reservation left after all settled");
        assertEq(vault.openNet(), 0, "open net stake left after all settled");
        assertEq(usdg.balanceOf(address(vault)), vaultStart + stakes - payouts, "USDG not conserved");
    }

    /// A move of -99% to +400% on `base`, from the seed.
    function _move(uint256 seed, uint256 k, uint256 base) internal pure returns (uint256) {
        uint256 bp = uint256(keccak256(abi.encode(seed, "move", k))) % 50_000; // 0 .. 49,999 bp
        if (bp < 9_900) return base * (10_000 - bp) / 10_000; // down to -99%
        return base * (10_000 + (bp - 9_900) * 4 / 4) / 10_000; // up to about +401%
    }
}
