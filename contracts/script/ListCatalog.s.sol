// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {TicketBook} from "../src/TicketBook.sol";

/// @title ListCatalog
/// @notice Lists every eligible catalog symbol on the playground TicketBook that is not listed yet.
/// Idempotent: a symbol that is already listed is skipped, so a rerun lists only what is missing. Prints the length
/// of listedSymbols() at the end.
///
/// Input: a JSON file with an "eligible" string array of tickers (the coverage.json of the bell's
/// scripts/prefetch-replay.ts has this shape; deployments/catalog-markets.json is a copy of it). The book and the
/// reference come from deployments/book.json ("book", "demoSigner").
///
/// Environment:
///   CATALOG_MARKETS  optional, path of the eligible list; default ../deployments/catalog-markets.json. It must be
///                    under ../deployments (fs_permissions in foundry.toml).
///   BOOK_JSON        optional, path of the address book; default ../deployments/book.json
///   LIST_LIMIT       optional, list at most this many new symbols in one run (default: all)
///
/// New markets: maxLeverage 20, maxStake 1,000 USDG, oiCap 20,000 USDG, maxStaleness 86400 s. The 14 markets of
/// Deploy.s.sol stay as deployed (they are listed already and skipped). Symbol encoding: the ticker's bytes,
/// left-aligned in a bytes32 (the same as Deploy.s.sol and book.json). Tickers longer than 32 bytes are skipped.
///
/// Run (fork, anvil dev account 0, the book owner; stop the bell first, it sends from the same account):
///   forge script script/ListCatalog.s.sol --rpc-url $PLAYGROUND_RPC_URL --chain 46633 --broadcast --slow \
///     --private-key <anvil dev key 0>
contract ListCatalog is Script {
    uint256 internal constant MAINNET_CHAIN_ID = 4663;
    uint8 internal constant MAX_LEVERAGE = 20;
    uint256 internal constant MAX_STAKE = 1_000e6;
    uint256 internal constant OI_CAP = 20_000e6;
    uint64 internal constant MAX_STALENESS = 1 days;

    error MainnetRefused();
    error NoSender();
    error NotOwner(address sender, address owner);

    function run() external {
        if (block.chainid == MAINNET_CHAIN_ID) revert MainnetRefused();
        string memory bookPath = vm.envOr("BOOK_JSON", string("../deployments/book.json"));
        string memory listPath = vm.envOr("CATALOG_MARKETS", string("../deployments/catalog-markets.json"));
        uint256 limit = vm.envOr("LIST_LIMIT", type(uint256).max);

        string memory bookJson = vm.readFile(bookPath);
        TicketBook book = TicketBook(vm.parseJsonAddress(bookJson, ".book"));
        address ref = vm.parseJsonAddress(bookJson, ".demoSigner");
        string[] memory tickers = vm.parseJsonStringArray(vm.readFile(listPath), ".eligible");

        address sender = msg.sender;
        if (sender == DEFAULT_SENDER) revert NoSender();
        if (book.owner() != sender) revert NotOwner(sender, book.owner());

        uint256 before = book.listedSymbols().length;
        uint256 added;
        uint256 skipped;
        vm.startBroadcast(sender);
        for (uint256 i; i < tickers.length && added < limit; ++i) {
            bytes memory b = bytes(tickers[i]);
            if (b.length == 0 || b.length > 32) {
                ++skipped;
                continue;
            }
            bytes32 sym = _sym(tickers[i]);
            (,, bool listed,,,,) = book.markets(sym);
            if (listed) continue;
            book.listMarket(sym, ref, MAX_LEVERAGE, MAX_STAKE, OI_CAP, MAX_STALENESS);
            ++added;
        }
        vm.stopBroadcast();

        console2.log("eligible", tickers.length);
        console2.log("listed before", before);
        console2.log("added", added);
        console2.log("skipped (empty or over 32 bytes)", skipped);
        console2.log("listedSymbols", book.listedSymbols().length);
    }

    /// @dev bytes to bytes32 conversion pads on the right with zeros (left-aligned, as Deploy.s.sol encodes).
    function _sym(string memory ticker) internal pure returns (bytes32) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes32(bytes(ticker));
    }
}
