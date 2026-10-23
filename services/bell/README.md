# bell v2

The playground service: faucet, demo signer price replay, settler, indexer, leaderboard. Bun and TypeScript, built
against docs/INTERFACES.md and the contracts in contracts/src.

## Run

    bun install
    bun test
    BELL_RPC_URL=http://127.0.0.1:8545 BELL_BOOK=../../deployments/book.json bun run src/index.ts

Docker: `docker build -t bellswap-v2-bell services/bell`, state on the /data volume, book at /data/book.json.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| BELL_RPC_URL | http://127.0.0.1:8545 | Private anvil URL (anvil_*, evm_* calls). Never the public eRPC. |
| BELL_CHAIN_ID | 46633 | Playground chain id. |
| BELL_PORT | 8787 | HTTP port. |
| BELL_BOOK | ../../deployments/book.json | Address book from the deploy script; re-read every indexer pass, so the service may start before the deploy. |
| BELL_STATE_FILE | data/state.json | JSON state (indexer, faucet log, rounds, replay cursor, bootstrap marker). |
| BELL_SIGNER_KEY | anvil dev key 1 | Demo signer key (the DemoSignerReference signer). Anvil dev key only. |
| BELL_HOUSE_KEY | anvil dev key 0 | Faucet and settler sender. Anvil dev key only. |
| BELL_REPLAY_SPEED | 60 | Recorded bars per wall minute (60: one five-minute bar per second; a session of 78 bars in about 78 s). |
| BELL_REPLAY | on | off stops the replay loop. |
| BELL_CLOSE_HOUR_UTC | 21 | Daily close on the playground clock (TicketBook SESSION_CLOSE). |
| BELL_SETTLE_SECONDS, BELL_INDEX_SECONDS | 4, 2 | Loop intervals. |
| BELL_FAUCET, BELL_FAUCET_COOLDOWN_S, BELL_FAUCET_IP_MAX | on, 3600, 200 | Faucet switch, per-address cooldown, and calls per client IP per hour (high for shared venue networks). |
| BELL_USDG | book USDG, else Robinhood Chain USDG | Token the faucet sends. |
| BELL_USDG_HOLDER | 0x8366...0951 (PoolManager) | Holder impersonated once at boot to move 5,000,000 USDG to dev account 0. |
| BELL_ORIGINS, BELL_ORIGIN_SUFFIXES | play and v2 subdomains, localhost; Pages preview suffixes | CORS. |
| BELL_ADMIN_TOKEN or BELL_ADMIN_TOKEN_FILE | unset (admin off) | Bearer token for POST /replay. |
| BELL_CHARTS | on | Charts layer (Yahoo, delayed, server side). |

## Routes

GET /state, /catalog, /charts/:range, /charts/:range/:symbol, /prices/:symbol, /tickets?owner=, /tickets/:id,
/activity?address=, /leaderboard, /vault, /health; POST /faucet {address}; admin POST /replay {speed, range, cursor,
paused}.

## Loops

- Replay: every 60000/speed ms one recorded bar: post a DemoSignerReference round for every listed market (one
  postMany transaction, signed by BELL_SIGNER_KEY), then evm_increaseTime by the bar's market seconds and evm_mine.
  The playground clock keeps the recorded time of day, so nights and weekends become one jump to the next open; when
  a jump crosses 21:00 UTC the last close is posted at that instant, so session tickets settle on the session close.
  The series wraps at its end.
- Settler: expired open tickets from the index, settle(id, 0x) from dev account 0 after an eth_call check.
- Indexer: eth_getLogs over TicketBook and HouseVault from the deployment block, applied to the state file.

## ABIs

src/abi/<Name>.ts are generated from contracts/out by the repo script `bun run scripts/abi.ts` (run from the repo
root; it runs forge build first) and are what the service uses. src/abi.ts re-exports them and keeps the minimal
ABIs from docs/INTERFACES.md for reference. Re-run the script when the contracts change.
