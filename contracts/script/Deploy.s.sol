// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {TicketBook} from "../src/TicketBook.sol";
import {DemoSignerReference} from "../src/references/DemoSignerReference.sol";
import {MockUSDG} from "../test/mocks/MockUSDG.sol";

/// @title Deploy
/// @notice Deploys the playground: HouseVault, TicketBook, DemoSignerReference; lists 14 markets; seeds the vault
/// from the deployer; writes deployments/<chainId>.json and deployments/book.json at the repo root.
///
/// Environment:
///   DEMO_SIGNER  required, the address whose signatures the DemoSignerReference accepts (the bell service key)
///   USDG         optional, must have 6 decimals; default: the Robinhood Chain USDG on chain 46633 (the playground fork), a fresh MockUSDG
///                (minted to the deployer) on any other chain id
///   SEED_USDG    optional, raw 6-decimal units the deployer deposits into the vault; default 1,000,000 USDG
///   FEE_BPS      optional, default 100 (1%), at most TicketBook.MAX_FEE_BPS (1000)
///   OWNER        optional, owner of the vault and the book; default the deployer
///
/// On the fork the deployer must hold SEED_USDG of the real USDG before the run (set the balance on anvil first).
/// Chain 4663 (Robinhood Chain mainnet) is refused.
///
/// Run (fork, anvil dev account 0):
///   DEMO_SIGNER=0x... forge script script/Deploy.s.sol --rpc-url $PLAYGROUND_RPC_URL --broadcast \
///     --private-key <anvil dev key 0>
contract Deploy is Script {
    uint256 internal constant PLAYGROUND_CHAIN_ID = 46633;
    uint256 internal constant MAINNET_CHAIN_ID = 4663;
    /// @dev Paxos USDG on Robinhood Chain (6 decimals); the fork carries it at the same address.
    address internal constant ROBINHOOD_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    uint8 internal constant MAX_LEVERAGE = 20;
    uint256 internal constant MAX_STAKE = 1_000e6;
    uint256 internal constant OI_CAP = 50_000e6;
    uint64 internal constant MAX_STALENESS = 1 days;
    /// @dev TicketBook.MAX_FEE_BPS (a constant of another contract cannot be read without an instance)
    uint256 internal constant MAX_FEE_BPS = 1000;

    struct M {
        string ticker;
        bool robinhoodChain; // listed on Robinhood Chain; the site hides these behind the toggle
    }

    error MainnetRefused();
    error SeedShort(uint256 balance, uint256 seed);
    error NoSender();
    error FeeOutOfRange(uint256 feeBps);
    error BadUsdgDecimals(uint8 decimals);

    function _markets() internal pure returns (M[14] memory m) {
        m[0] = M("RTX", false);
        m[1] = M("NOC", false);
        m[2] = M("CPER", false);
        m[3] = M("SOXL", false);
        m[4] = M("DRAM", false);
        m[5] = M("GD", false);
        m[6] = M("MARA", false);
        m[7] = M("UUUU", false);
        m[8] = M("SPY", true);
        m[9] = M("QQQ", true);
        m[10] = M("NVDA", true);
        m[11] = M("MU", true);
        m[12] = M("SNDK", true);
        m[13] = M("TSLA", true);
    }

    struct Out {
        address usdg;
        bool mock;
        address vault;
        address book;
        address ref;
        address signer;
        address owner;
        uint16 feeBps;
        uint256 seed;
    }

    function run() external {
        if (block.chainid == MAINNET_CHAIN_ID) revert MainnetRefused();
        Out memory o;
        o.signer = vm.envAddress("DEMO_SIGNER");
        o.seed = vm.envOr("SEED_USDG", uint256(1_000_000e6));
        // CONTRACTS-9: range-check the raw value before the cast, so 65636 cannot truncate to 100
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(100));
        if (feeBps > MAX_FEE_BPS) revert FeeOutOfRange(feeBps);
        o.feeBps = uint16(feeBps);

        // forge sets msg.sender to the single wallet passed with --private-key (or --sender)
        address deployer = msg.sender;
        if (deployer == DEFAULT_SENDER) revert NoSender();
        vm.startBroadcast(deployer);
        o.owner = vm.envOr("OWNER", deployer);
        o.usdg = _usdg(o, deployer);
        _deploy(o, deployer);
        vm.stopBroadcast();

        string memory json = _json(_markets(), o);
        string memory dir = "../deployments/";
        vm.createDir("../deployments", true);
        vm.writeFile(string.concat(dir, vm.toString(block.chainid), ".json"), json);
        vm.writeFile(string.concat(dir, "book.json"), json);
        console2.log("vault", o.vault);
        console2.log("book", o.book);
        console2.log("demoSigner", o.ref);
        console2.log("usdg", o.usdg, IERC20Metadata(o.usdg).decimals());
    }

    function _usdg(Out memory o, address deployer) internal returns (address usdgAddr) {
        usdgAddr = vm.envOr("USDG", address(0));
        if (usdgAddr == address(0)) {
            if (block.chainid == PLAYGROUND_CHAIN_ID) {
                usdgAddr = ROBINHOOD_USDG;
            } else {
                MockUSDG mu = new MockUSDG();
                mu.mint(deployer, o.seed);
                usdgAddr = address(mu);
                o.mock = true;
            }
        }
        // F5: amounts (MAX_STAKE, OI_CAP, SEED_USDG) and the json metadata assume 6 decimals
        uint8 dec = IERC20Metadata(usdgAddr).decimals();
        if (dec != 6) revert BadUsdgDecimals(dec);
        uint256 bal = IERC20(usdgAddr).balanceOf(deployer);
        if (bal < o.seed) revert SeedShort(bal, o.seed);
    }

    function _deploy(Out memory o, address deployer) internal {
        IERC20 usdg = IERC20(o.usdg);
        HouseVault vault = new HouseVault(usdg, deployer);
        TicketBook book = new TicketBook(usdg, vault, deployer, o.feeBps);
        vault.setBook(address(book));
        DemoSignerReference ref = new DemoSignerReference(o.signer);
        M[14] memory ms = _markets();
        for (uint256 i; i < ms.length; ++i) {
            book.listMarket(_sym(ms[i].ticker), address(ref), MAX_LEVERAGE, MAX_STAKE, OI_CAP, MAX_STALENESS);
        }
        if (o.seed > 0) {
            usdg.approve(address(vault), o.seed);
            vault.deposit(o.seed, deployer);
        }
        if (o.owner != deployer) {
            vault.transferOwnership(o.owner);
            book.transferOwnership(o.owner);
        }
        o.vault = address(vault);
        o.book = address(book);
        o.ref = address(ref);
    }

    function _sym(string memory ticker) internal pure returns (bytes32 s) {
        bytes memory b = bytes(ticker);
        require(b.length > 0 && b.length <= 32, "ticker");
        assembly {
            s := mload(add(b, 32))
        }
    }

    function _json(M[14] memory ms, Out memory o) internal view returns (string memory) {
        string memory markets = "[";
        for (uint256 i; i < ms.length; ++i) {
            markets = string.concat(
                markets,
                i == 0 ? "" : ",",
                '{"ticker":"',
                ms[i].ticker,
                '","symbol":"',
                vm.toString(_sym(ms[i].ticker)),
                '","reference":"',
                vm.toString(o.ref),
                '","robinhoodChain":',
                ms[i].robinhoodChain ? "true" : "false",
                ',"maxLeverage":20,"maxStake":"1000000000","oiCap":"50000000000","maxStaleness":86400}'
            );
        }
        markets = string.concat(markets, "]");
        string memory head = string.concat(
            '{"chainId":',
            vm.toString(block.chainid),
            ',"block":',
            vm.toString(block.number),
            ',"deployBlock":',
            vm.toString(block.number),
            ',"usdg":"',
            vm.toString(o.usdg),
            '","usdgDecimals":6,"usdgIsMock":',
            o.mock ? "true" : "false",
            ',"vault":"',
            vm.toString(o.vault),
            '","book":"',
            vm.toString(o.book),
            '","demoSigner":"',
            vm.toString(o.ref)
        );
        return string.concat(
            head,
            '","signer":"',
            vm.toString(o.signer),
            '","owner":"',
            vm.toString(o.owner),
            '","feeBps":',
            vm.toString(uint256(o.feeBps)),
            ',"seedUsdg":"',
            vm.toString(o.seed),
            '","addresses":{"USDG":"',
            vm.toString(o.usdg),
            '","HouseVault":"',
            vm.toString(o.vault),
            '","TicketBook":"',
            vm.toString(o.book),
            '","DemoSignerReference":"',
            vm.toString(o.ref),
            '"},"markets":',
            markets,
            "}"
        );
    }
}
