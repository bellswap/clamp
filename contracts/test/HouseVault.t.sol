// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BookFixture} from "./BookFixture.sol";
import {HouseVault} from "../src/HouseVault.sol";

contract HouseVaultTest is BookFixture {
    function test_metadata() public view {
        assertEq(vault.asset(), address(usdg));
        assertEq(vault.decimals(), 12); // 6 USDG decimals + a decimals offset of 6
        assertEq(vault.totalAssets(), 1_000_000 * USD);
        assertEq(vault.free(), 1_000_000 * USD);
    }

    function test_freeLiquidityLimitsWithdraw() public {
        // reserve 990,000 * 20 is too much; open many tickets to book 19,800 per ticket
        for (uint256 i; i < 10; ++i) {
            _open(alice, i % 2 == 0 ? NVDA : SPY, true, 20, 1_000 * USD, uint8(i % 3));
        }
        uint256 res = vault.reserved();
        assertEq(res, 10 * 19_800 * USD);
        uint256 f = vault.free();
        assertEq(f, 1_000_000 * USD + 10_000 * USD - res);
        uint256 maxW = vault.maxWithdraw(lp);
        assertLe(maxW, f);
        assertApproxEqAbs(maxW, f, 1); // ERC-4626 rounds the LP's assets down
        assertLe(vault.convertToAssets(vault.maxRedeem(lp)), f);

        vm.startPrank(lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, lp, f + 1, maxW));
        vault.withdraw(f + 1, lp, lp);
        uint256 maxR = vault.maxRedeem(lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, lp, maxR + 1, maxR));
        vault.redeem(maxR + 1, lp, lp);
        vault.withdraw(maxW, lp, lp);
        vm.stopPrank();
        assertLe(vault.free(), 1);
        assertLe(vault.maxWithdraw(lp), 1);
        assertGe(usdg.balanceOf(address(vault)), vault.reserved());
    }

    function test_depositAfterTicketsMintsAtShareValue() public {
        address lp2 = makeAddr("lp2");
        usdg.mint(lp2, 1_000 * USD);
        vm.startPrank(lp2);
        usdg.approve(address(vault), type(uint256).max);
        uint256 shares = vault.deposit(1_000 * USD, lp2);
        vm.stopPrank();
        assertEq(shares, vault.convertToShares(1_000 * USD));
        assertApproxEqAbs(vault.maxWithdraw(lp2), 1_000 * USD, 1); // at most one unit of rounding to the vault
        assertLe(vault.maxWithdraw(lp2), 1_000 * USD);
    }

    /// Open ticket stakes do not inflate share value, so redeeming before settlement does not pay.
    function test_openStakesDoNotInflateShares() public {
        vm.prank(lp);
        vault.withdraw(999_000 * USD, lp, lp); // the original LP keeps 1,000 USDG in
        address eve = makeAddr("eve");
        _fund(eve, 2_000 * USD);
        uint256 start = usdg.balanceOf(eve);
        vm.startPrank(eve);
        usdg.approve(address(vault), type(uint256).max);
        vault.deposit(1_000 * USD, eve);
        uint256 id = book.open(NVDA, true, 1, 1_000 * USD, 0);
        assertEq(vault.openNet(), _net(1_000 * USD));
        assertEq(vault.totalAssets(), 3_000 * USD - _net(1_000 * USD));
        vault.redeem(vault.maxRedeem(eve), eve, eve);
        vm.stopPrank();
        _expireAt(id, 100e8); // flat
        book.settle(id, "");
        assertEq(vault.openNet(), 0);
        assertLt(usdg.balanceOf(eve), start, "redeem before settlement must not profit");
        assertGe(vault.maxWithdraw(lp), 1_000 * USD, "original LP keeps at least its deposit");
    }

    /// On an empty vault a donation cannot make later deposits mint zero shares or pay the attacker.
    function test_donationAttackFails() public {
        HouseVault v = new HouseVault(usdg, house);
        address eve = makeAddr("eve");
        usdg.mint(eve, 201 * USD);
        vm.startPrank(eve);
        usdg.approve(address(v), type(uint256).max);
        v.deposit(1, eve);
        usdg.transfer(address(v), 200 * USD);
        vm.stopPrank();
        address[3] memory victims = [makeAddr("v1"), makeAddr("v2"), makeAddr("v3")];
        for (uint256 i; i < 3; ++i) {
            usdg.mint(victims[i], 100 * USD);
            vm.startPrank(victims[i]);
            usdg.approve(address(v), type(uint256).max);
            assertGt(v.deposit(100 * USD, victims[i]), 0, "victim minted zero shares");
            vm.stopPrank();
        }
        vm.startPrank(eve);
        uint256 out = v.redeem(v.balanceOf(eve), eve, eve);
        vm.stopPrank();
        assertLt(out, 200 * USD + 1, "attacker profits from the donation");
        for (uint256 i; i < 3; ++i) {
            assertGe(v.maxWithdraw(victims[i]), 99 * USD, "victim lost more than 1%");
        }
        // a deposit that rounds to zero shares reverts
        HouseVault w = new HouseVault(usdg, house);
        usdg.mint(eve, 300 * USD);
        vm.startPrank(eve);
        usdg.approve(address(w), type(uint256).max);
        w.deposit(1, eve);
        usdg.transfer(address(w), 200 * USD);
        vm.expectRevert(HouseVault.ZeroShares.selector);
        w.deposit(1, eve);
        vm.stopPrank();
    }

    function test_onlyBook() public {
        vm.startPrank(alice);
        vm.expectRevert(HouseVault.OnlyBook.selector);
        vault.reserve(1);
        vm.expectRevert(HouseVault.OnlyBook.selector);
        vault.release(1);
        vm.expectRevert(HouseVault.OnlyBook.selector);
        vault.pay(alice, 1);
        vm.expectRevert(HouseVault.OnlyBook.selector);
        vault.collect(bob, 1);
        vm.expectRevert(HouseVault.OnlyBook.selector);
        vault.addOpenNet(1);
        vm.expectRevert(HouseVault.OnlyBook.selector);
        vault.subOpenNet(1);
        vm.stopPrank();
    }

    function test_bookBindsOnce() public {
        vm.prank(house);
        vm.expectRevert(HouseVault.BookAlreadySet.selector);
        vault.setBook(alice);
        HouseVault v = new HouseVault(usdg, house);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        v.setBook(alice);
        vm.prank(house);
        vm.expectRevert(HouseVault.ZeroAddress.selector);
        v.setBook(address(0));
    }

    function test_bookGuards() public {
        // drive the vault as the book to hit the guards directly
        vm.startPrank(address(book));
        vm.expectRevert(
            abi.encodeWithSelector(HouseVault.InsufficientFree.selector, 1_000_001 * USD, 1_000_000 * USD)
        );
        vault.reserve(1_000_001 * USD);
        vault.reserve(600_000 * USD);
        vm.expectRevert(
            abi.encodeWithSelector(HouseVault.ReleaseExceedsReserved.selector, 600_001 * USD, 600_000 * USD)
        );
        vault.release(600_001 * USD);
        vm.expectRevert(abi.encodeWithSelector(HouseVault.PayBreaksReserve.selector, 400_001 * USD, 400_000 * USD));
        vault.pay(alice, 400_001 * USD);
        vault.pay(alice, 400_000 * USD);
        assertEq(vault.free(), 0);
        vault.release(600_000 * USD);
        vm.stopPrank();
        assertEq(vault.free(), 600_000 * USD);
    }
}
