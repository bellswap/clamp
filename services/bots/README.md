# bots

The labelled demo fleet of the playground: 24 traders and 4 LPs, every key derived from `BOTS_MNEMONIC`
(m/44'/60'/0'/0/i: traders 0..23, LPs 24..27). The service refuses the anvil mnemonic, so it never uses dev keys
0 to 9. Every address is registered with the bell (`POST /admin/bots`, Bearer `BELL_ADMIN_TOKEN`), so tickets,
activity and leaderboard rows carry `bot: true` and the site shows the "demo" tag. Opens and LP steps stay paused
while that registration has not succeeded (unset or wrong token, bell registry reset and re-registration failing),
so no row goes out without the flag.

## What it does

- Book addresses from bell `/state` (re-read every minute). A fork reset (head went back, or a different book,
  vault, USDG or startBlock) clears the local counts and re-funds, re-approves and re-registers.
- Funding on anvil: `anvil_setBalance` 10 ETH below 1 ETH; USDG through `anvil_setStorageAt` at
  `keccak256(abi.encode(holder, 1))` (`BOTS_USDG_SLOT`, default 1, the fork's USDG; 0 for the bare-anvil MockUSDG),
  traders topped up to 5,000 below 1,000 USDG; one max approve to the TicketBook and one to the vault per wallet.
- Traders: Poisson opens with mean `BOTS_INTERVAL_MS` over the fleet; symbols 40 % core (bell `feed.core`, else the
  14 book markets), 60 % uniform over the other tradable `/markets` rows; non-core first `POST /warm/:symbol {ttl:30}`
  and wait (up to 20 s) until `/markets/:symbol` says `fresh`; side from the last three 5-minute closes, half
  momentum, half reversal; multiples 2/5/10/20 at 25/35/25/15 %; 5 to 250 USDG skewed small; Session/Day/Week at
  55/30/15 %; every open is simulated before it is sent.
- Guards: vault free at least 40 % of assets; market oi plus the stake at most 80 % of oiCap; at most 6 open per bot
  and 150 for the fleet; no opens while the bell's last tick is older than 20 s; 60 s back-off after 5 consecutive
  failed opens. Opens in flight count against the fleet cap, and one open at a time per symbol, so concurrent
  traders never pass a cap together. Open counts per bot come from the bell's `/tickets?owner=` rows plus the ids this
  process opened; an id leaves only when the bell lists it settled or `getTicket` on chain says it is closed, so an
  indexer lag never frees a slot early.
- LPs: first deposit 25k to 150k USDG, staggered 20 to 60 s apart; then about every 20 minutes (15 to 25) a deposit
  or a withdraw of 2 to 10 % of the position (withdraws capped by maxWithdraw).
- A stats line per minute: opens, reverts by reason, skips by reason, fleet open count, vault free, tick age.

## Env

`BOTS_MNEMONIC` (required), `BOTS_COUNT` 24, `BOTS_LP` 4, `BOTS_ENABLED` 0|1, `BOTS_INTERVAL_MS` 3000,
`BOTS_RPC_URL` http://anvil:8545, `BOTS_BELL_URL` http://bell:8787, `BELL_ADMIN_TOKEN`. Optional: `BOTS_HEALTH_PORT`
8790, `BOTS_CORE` (comma list), `BOTS_USDG_SLOT` 1.

Kill switch: `BOTS_ENABLED=0` keeps the process idle with `/health` up, or `docker compose stop bots`.

## Run

    bun install && bun test
    bun run src/index.ts                 # long-running fleet (BOTS_ENABLED=1)
    bun run src/index.ts --once 50       # fund, open 50 tickets, check the bell lists them with bot true; JSON
                                         # summary; exit 0 only with 50 opened, 0 reverted transactions, 50 flagged
    bun run scripts/local-smoke.ts --dir <scratch dir> --n 20
                                         # bare anvil + real contracts + stand-in bell: --once and rpc-guard checks

Health: `GET :8790/health`.
