# Bellswap v2: Clamp tickets

Bellswap v2 is a ticket on a reference price: pick a ticker, long or short, a multiple from 1x to 20x, a stake in USDG and a horizon (session, day, week).
Payout is the net stake (stake minus the fee) times clamp(1 + multiple times the reference move, 0, multiple): the loss is at most the stake and there is no liquidation.
One USDG house vault is the counterparty; each ticket's worst case is reserved when it opens and released when it settles.
Settlement is a permissionless call against the reference round at or after expiry; nobody on Bellswap sets the price.

## Playground

https://play.bellswap.fun runs these contracts on a fork of Robinhood Chain (mainnet chain id 4663), run under chain id 46633 with recorded prices and play money.
A demo signer replays the recorded prices on chain; no real funds are involved.

## Repository map

| Path | What |
| --- | --- |
| contracts/ | Solidity 0.8.26, Foundry: TicketBook, HouseVault (ERC-4626), IReference and its adapters (Chainlink, Ondo, Pyth, demo signer); deploy scripts in script/, tests in test/, OpenZeppelin Contracts and forge-std vendored in lib/ |
| services/bell/ | bell v2 (Bun, TypeScript): faucet, demo signer replay, settler, indexer, leaderboard |
| services/bots/ | a fleet of demo traders and LPs for the playground |
| services/rpc-guard/ | JSON-RPC passthrough in front of the fork that rejects transactions signed by anvil dev keys or sent to the reference |
| site/ | the playground app (Vite 7, React 19, viem) |
| deployments/ | book.json (the playground addresses, fee and market parameters), 46633.json, catalog-markets.json |
| infra/ | docker-compose for the playground VM (anvil fork, eRPC, rpc-guard, bell, bots, Caddy), the deploy script and ops scripts |
| docs/ | INTERFACES.md (the interfaces the parts were built against), STYLE-SPEC.md (the site's style rules) |
| scripts/abi.ts | writes the ABIs from the contracts build into services/bell and site |

## For reviewers: the contracts

Two contracts hold the product. Both are in contracts/src, Solidity 0.8.26, built and tested with Foundry. They are not upgradeable and have had no external security review.

### TicketBook

A ticket pays on a reference price move over a fixed horizon. The trader picks a listed symbol, long or short, a multiple L from 1 to the market's maximum (at most 20), a stake in USDG (6 decimals) and a horizon:

- session: the next 21:00 UTC on the chain clock
- day: now plus 24 hours, rounded up to the next full hour
- week: now plus 7 days, rounded up to the next full hour

Tickets of one symbol and one expiry form a bucket and settle at one price.

Payout at settlement:

    net    = stake - stake * feeBps / 10_000
    r      = (settlePrice - entryPrice) / entryPrice     (sign flipped for a short)
    payout = net * clamp(1 + L * r, 0, L)

The payout arithmetic is 1e18 fixed point and rounds to the house: a gain is floored, a loss is ceiled, the payout is floored. The fee is rounded down. A trader can lose at most the stake. There is no liquidation and no margin call. The entry price is the reference's latest price when the ticket opens.

### HouseVault

One ERC-4626 vault on USDG (share token bsHOUSE, 12 decimals: a decimals offset of 6 against donation attacks) is the counterparty to every ticket. Only the TicketBook, bound once by the owner, can reserve, release, pay and collect.

- Reserve rule: when a ticket opens, its whole stake moves into the vault and its worst case, net * L, is reserved. A bucket reserves the sum of its tickets' caps, so a settlement can never pay more than was reserved, whatever the entry prices. A ticket that would push reservations above the vault's free USDG reverts.
- LPs can withdraw only free USDG: balance minus reserved.
- Share value is the USDG balance minus the summed net stakes of open tickets, so LPs cannot redeem against stakes the house still owes back.

### Settlement rule

settle(id, proof) is permissionless and works at or after the ticket's expiry. The first settlement in a bucket asks the bucket's reference for the first price at or after the expiry and fixes it for the whole bucket; later settlements in the bucket reuse it. Each payout comes out of the bucket's reservation and the rest is released to the vault. Pausing stops new tickets only; settlement stays open while paused.

References (contracts/src/references) put one interface, IReference, over Chainlink and Ondo style aggregator feeds, Pyth, and a demo signer. The playground uses DemoSignerReference: one signer, fixed at deployment, posts signed rounds in increasing time order.

### Known limitations

- Owner: one owner account lists markets and their reference, sets the fee and pauses. A wrong or hostile reference can set any price, so the owner is fully trusted. There is no timelock and no multisig yet.
- No external audit. The contracts went through automated review rounds before this release.
- Flat fee: one fee rate (default 1%, maximum 10%) for every market and multiple. It is charged on the stake and stays in the vault. A fee change applies to new tickets only.
- Staleness: a ticket opens only if the reference's latest price is at most maxStaleness old, 86,400 s on the playground. A price up to a day old can be the entry, which is fine for replayed play prices and too loose for markets with real prices.
- The vault reserves each ticket's full cap. This is safe but ties up a large share of the vault; netting long against short is future work.
- A bucket whose reference never returns a price at or after expiry cannot settle; there is no refund path yet.
- Playground only: the deployment in deployments/book.json is on a fork of Robinhood Chain run under chain id 46633 with play money, and its demo signer is a public development key.

### Deployments

deployments/book.json lists the playground addresses of USDG, HouseVault, TicketBook and DemoSignerReference, plus the fee and the market parameters. Nothing in this repository is deployed on a public mainnet.

### Run the tests

    cd contracts
    forge build
    forge test                 # 63 pass, 1 skipped (the fork test)
    forge test --gas-report
    forge coverage --report summary

The fork test opens, replays and settles a ticket on a fork of Robinhood Chain. It runs only with an RPC URL set:

    FORK_RPC_URL=https://robinhood-rpc.publicnode.com forge test --match-test test_fork

The tests cover the payout table for both sides and multiples 1 to 20, clamps at 0 and L, rounding, open and settle paths and their reverts, reservation and release, fee handling, pause, staleness, LP withdrawal limits, the donation attack, and fuzzed bucket accounting that checks USDG is conserved.

## Run the site in mock mode

Mock mode (VITE_MOCK=1, site/src/config.ts) runs the app on fixture data (site/src/lib/mock.ts): no RPC and no bell needed.

    cd site
    bun install
    bun run dev:mock           # site/package.json "dev:mock": VITE_MOCK=1 vite
    bun run build              # naming lint, typecheck, vite build into site/dist
    bun test src scripts       # site/package.json "test"

Against a fork, the site reads VITE_RPC_URL, VITE_BELL_URL and VITE_BOOK_JSON (the contents of deployments/book.json).

## Run the services

- bell v2: `cd services/bell && bun install && bun run start` (listens on PORT, default 8787; `bun test` for the tests)
- bots and rpc-guard: see services/bots/README.md and services/rpc-guard/README.md
- Infrastructure: see infra/README.md

## License

MIT, see LICENSE. The vendored libraries in contracts/lib keep their own licenses.

Bellswap is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.
