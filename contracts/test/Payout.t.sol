// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BookFixture} from "./BookFixture.sol";

/// @notice Payout formula table: long and short, L in {1, 2, 5, 10, 20}, moves -30% to +30%, cap and floor.
/// Expected values come from exact integer arithmetic: payout = net * clamp(100 + side * L * pct, 0, 100 * L) / 100.
contract PayoutTest is BookFixture {
    uint8[5] internal LEVS = [1, 2, 5, 10, 20];
    int256[13] internal MOVES = [int256(-30), -20, -10, -5, -3, -1, 0, 1, 3, 5, 10, 20, 30];
    uint256 internal constant ENTRY = 100e8;
    uint256 internal constant NET = 1_000 * 1e6;

    function _expected(bool long, uint8 lev, int256 pct) internal pure returns (uint256) {
        int256 side = long ? int256(1) : int256(-1);
        int256 m = 100 + side * int256(uint256(lev)) * pct;
        int256 cap = 100 * int256(uint256(lev));
        if (m < 0) m = 0;
        if (m > cap) m = cap;
        return NET * uint256(m) / 100;
    }

    function _settle(int256 pct) internal pure returns (uint256) {
        return uint256(int256(ENTRY) * (100 + pct) / 100);
    }

    function _table(bool long) internal view returns (uint256 cases) {
        for (uint256 i; i < LEVS.length; ++i) {
            for (uint256 j; j < MOVES.length; ++j) {
                uint256 got = book.payoutFor(long, LEVS[i], NET, ENTRY, _settle(MOVES[j]));
                assertEq(got, _expected(long, LEVS[i], MOVES[j]), "payout table");
                ++cases;
            }
        }
    }

    function test_payoutTable_long() public view {
        assertEq(_table(true), 65);
    }

    function test_payoutTable_short() public view {
        assertEq(_table(false), 65);
    }

    function test_spotValues() public view {
        // 5x long, +10%: 1.5x
        assertEq(book.payoutFor(true, 5, NET, ENTRY, 110e8), 1_500e6);
        // 5x short, +10%: 0.5x
        assertEq(book.payoutFor(false, 5, NET, ENTRY, 110e8), 500e6);
        // 10x long, -10%: floor at 0
        assertEq(book.payoutFor(true, 10, NET, ENTRY, 90e8), 0);
        // 10x short, -10%: 2x
        assertEq(book.payoutFor(false, 10, NET, ENTRY, 90e8), 2_000e6);
        // 20x short, -30%: 1 + 6 = 7x
        assertEq(book.payoutFor(false, 20, NET, ENTRY, 70e8), 7_000e6);
        // 20x short, -95%: 1 + 19 = 20x, the cap
        assertEq(book.payoutFor(false, 20, NET, ENTRY, 5e8), 20_000e6);
        // 20x short, -99%: capped at 20x
        assertEq(book.payoutFor(false, 20, NET, ENTRY, 1e8), 20_000e6);
    }

    function test_cap() public view {
        // L=2 long needs +50% to hit the 2x cap; +80% stays at 2x
        assertEq(book.payoutFor(true, 2, NET, ENTRY, 150e8), 2 * NET);
        assertEq(book.payoutFor(true, 2, NET, ENTRY, 180e8), 2 * NET);
        // L=1 never pays above the net stake (cap equals 1)
        assertEq(book.payoutFor(true, 1, NET, ENTRY, 300e8), NET);
        assertEq(book.multiplierFor(true, 20, ENTRY, 1_000e8), 20e18);
        // short cap: price to near zero
        assertEq(book.payoutFor(false, 3, NET, ENTRY, 1), 3 * NET);
    }

    function test_floor() public view {
        // -99.99999999% at 1x: multiplier 1e8 wad, payout 0.1 base units, rounded down to 0
        assertEq(book.multiplierFor(true, 1, ENTRY, 1), 1e8);
        assertEq(book.payoutFor(true, 1, NET, ENTRY, 1), 0);
        assertEq(book.payoutFor(true, 2, NET, ENTRY, 50e8), 0);
        assertEq(book.payoutFor(true, 2, NET, ENTRY, 40e8), 0);
        assertEq(book.payoutFor(false, 2, NET, ENTRY, 150e8), 0);
        assertEq(book.payoutFor(false, 20, NET, ENTRY, 1_000e8), 0);
    }

    function test_roundsDown() public view {
        // entry 3e8, settle 4e8: move 1/3. 1x long: min(1 + 1/3, 1) = 1.
        // 2x short: 1 - 2/3 = 1/3 -> loss ceiled to 666666666666666667 -> multiplier 333333333333333333
        assertEq(book.multiplierFor(false, 2, 3e8, 4e8), 333_333_333_333_333_333);
        assertEq(book.payoutFor(false, 2, 1_000_000, 3e8, 4e8), 333_333);
        // 2x long, entry 3e8, settle 3.5e8: 1 + 2/6 = 1.333.. -> floored
        assertEq(book.multiplierFor(true, 2, 3e8, 35e7), 1_333_333_333_333_333_333);
        assertEq(book.payoutFor(true, 2, 1_000_000, 3e8, 35e7), 1_333_333);
    }
}
