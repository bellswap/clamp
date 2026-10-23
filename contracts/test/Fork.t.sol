// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {TicketBook} from "../src/TicketBook.sol";
import {DemoSignerReference} from "../src/references/DemoSignerReference.sol";

/// @notice Opens, replays and settles a ticket on a fork of Robinhood Chain with the real USDG under the playground
/// chain id 46633. Skipped unless FORK_RPC_URL is set (a keyless endpoint, e.g. the `robinhood` alias in
/// foundry.toml). Also logs the USDG balance storage slot that the infrastructure uses to fund accounts on anvil.
contract ForkTest is Test {
    using stdStorage for StdStorage;

    /// @dev Paxos USDG on Robinhood Chain; the same constant as in script/Deploy.s.sol.
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 internal constant PK = 0x5161;
    bytes32 internal constant SYM = bytes32("RTX");

    function test_fork_openReplaySettle() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        vm.chainId(46633);
        IERC20 usdg = IERC20(USDG);
        assertEq(IERC20Metadata(USDG).decimals(), 6);

        address lp = makeAddr("lp");
        address user = makeAddr("user");
        uint256 slot = stdstore.target(USDG).sig("balanceOf(address)").with_key(lp).find();
        console2.log("USDG balanceOf(lp) slot", slot);
        deal(USDG, lp, 100_000e6);
        deal(USDG, user, 1_000e6);

        // transfer and approve work under the new chain id
        vm.prank(user);
        assertTrue(usdg.transfer(lp, 1e6));

        HouseVault vault = new HouseVault(usdg, address(this));
        TicketBook book = new TicketBook(usdg, vault, address(this), 100);
        vault.setBook(address(book));
        DemoSignerReference ref = new DemoSignerReference(vm.addr(PK));
        book.listMarket(SYM, address(ref), 20, 1_000e6, 50_000e6, 1 days);

        vm.startPrank(lp);
        usdg.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6, lp);
        vm.stopPrank();

        uint64 t0 = uint64(block.timestamp);
        _post(ref, 150e8, t0);
        vm.startPrank(user);
        usdg.approve(address(book), type(uint256).max);
        uint256 id = book.open(SYM, false, 10, 500e6, 0);
        vm.stopPrank();
        TicketBook.Ticket memory t = book.getTicket(id);

        // replay: one round every 15 minutes of chain time until past expiry, price drifting down 0.1% per round
        uint256 price = 150e8;
        uint64 ts = t0;
        while (ts < t.expiry) {
            ts += 15 minutes;
            vm.warp(ts);
            price = price * 999 / 1000;
            _post(ref, price, ts);
        }
        uint256 before = usdg.balanceOf(user);
        uint256 payout = book.settle(id, "");
        assertEq(usdg.balanceOf(user), before + payout);
        assertEq(vault.reserved(), 0);
        assertGt(payout, 495e6, "short wins on a falling price");
        console2.log("ticket payout (USDG units)", payout);
    }

    function _post(DemoSignerReference ref, uint256 p, uint64 ts) internal {
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(ref.digest(SYM, p, ts));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, h);
        ref.post(SYM, p, ts, abi.encodePacked(r, s, v));
    }
}
