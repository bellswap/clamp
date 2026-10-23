// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {TicketBook} from "../src/TicketBook.sol";
import {DemoSignerReference} from "../src/references/DemoSignerReference.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";

/// @notice Shared setup: MockUSDG, vault seeded with 1,000,000 USDG, book with a 1% fee, DemoSigner reference,
/// market NVDA listed with max 20x, 1,000 USDG max stake, 50,000 USDG oi cap and 1 day staleness.
abstract contract BookFixture is Test {
    uint256 internal constant USD = 1e6;
    uint256 internal constant SIGNER_PK = 0xA11CE;
    bytes32 internal constant NVDA = bytes32("NVDA");
    bytes32 internal constant SPY = bytes32("SPY");
    uint16 internal constant FEE_BPS = 100;
    // 2026-10-19 12:00:00 UTC, a Monday
    uint256 internal constant T0 = 1_792_411_200;

    MockUSDG internal usdg;
    HouseVault internal vault;
    TicketBook internal book;
    DemoSignerReference internal ref;
    address internal house = makeAddr("house");
    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal signerAddr;

    function setUp() public virtual {
        vm.warp(T0);
        signerAddr = vm.addr(SIGNER_PK);
        usdg = new MockUSDG();
        vault = new HouseVault(usdg, house);
        book = new TicketBook(usdg, vault, house, FEE_BPS);
        vm.prank(house);
        vault.setBook(address(book));
        ref = new DemoSignerReference(signerAddr);
        vm.startPrank(house);
        book.listMarket(NVDA, address(ref), 20, 1_000 * USD, 50_000 * USD, 1 days);
        book.listMarket(SPY, address(ref), 20, 1_000 * USD, 50_000 * USD, 1 days);
        vm.stopPrank();

        usdg.mint(lp, 1_000_000 * USD);
        vm.startPrank(lp);
        usdg.approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000 * USD, lp);
        vm.stopPrank();

        _fund(alice, 100_000 * USD);
        _fund(bob, 100_000 * USD);
        _post(NVDA, 100e8, uint64(block.timestamp));
        _post(SPY, 500e8, uint64(block.timestamp));
    }

    function _fund(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.prank(who);
        usdg.approve(address(book), type(uint256).max);
    }

    function _sign(uint256 pk, DemoSignerReference r, bytes32 symbol, uint256 price8, uint64 ts)
        internal
        view
        returns (bytes memory)
    {
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(r.digest(symbol, price8, ts));
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(rr, s, v);
    }

    function _post(bytes32 symbol, uint256 price8, uint64 ts) internal {
        ref.post(symbol, price8, ts, _sign(SIGNER_PK, ref, symbol, price8, ts));
    }

    function _open(address who, bytes32 symbol, bool long, uint8 lev, uint256 stake, uint8 horizon)
        internal
        returns (uint256 id)
    {
        vm.prank(who);
        id = book.open(symbol, long, lev, stake, horizon);
    }

    /// @dev Warps to the ticket's expiry and posts `price8` there.
    function _expireAt(uint256 id, uint256 price8) internal {
        TicketBook.Ticket memory t = book.getTicket(id);
        vm.warp(t.expiry);
        _post(t.symbol, price8, t.expiry);
    }

    function _net(uint256 stake) internal pure returns (uint256) {
        return stake - stake * FEE_BPS / 10_000;
    }
}
