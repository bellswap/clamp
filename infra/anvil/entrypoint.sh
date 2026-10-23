#!/usr/bin/env bash
# Playground fork of Robinhood Chain (upstream chain 4663) under its own chain id 46633.
# Adapted from the first Bellswap demo: the retry proxy runs as its own compose service (proxy),
# anvil runs under a restart loop, and SIGTERM is forwarded so anvil writes its --state dump before the container stops.
# A reset: stop the stack, move /data/anvil.json aside on the volume (never delete), start again.
# Self-heal: anvil writes the dump in place, so a kill during the write leaves a truncated file, and every later start
# fails with "failed to parse json file ... EOF" (exit 2). Before each start the supervisor moves a dump whose last
# non-blank byte is not "}" to $STATE.corrupt-<UTC time>. A cut right after a nested "}" passes that check, so after
# any exit the supervisor also moves the dump aside when anvil's stderr holds clap's --state parse error (see STATE_ERR);
# a plain exit 2 is not enough, because clap exits 2 on every bad flag or value (a renamed flag, a bad .env value).
# anvil then starts a fresh fork; the contracts need FORCE_CONTRACTS=1 infra/deploy.sh again (infra/README.md).
set -uo pipefail
: "${ANVIL_FORK_BLOCK:?ANVIL_FORK_BLOCK missing}"
UPSTREAM=${ANVIL_FORK_URL:-http://proxy:8672}
STATE=${ANVIL_STATE:-/data/anvil.json}
# Dump interval in seconds. 600, not 60: a 2.5 GB dump every minute got anvil OOM-killed 261 times on 2026-10-20, and
# the last kill truncated the dump (the fork was down until the reset on 2026-10-22).
INTERVAL=${ANVIL_STATE_INTERVAL:-600}
CHAIN_ID=${ANVIL_CHAIN_ID:-46633}
# Keep at most PRUNE block states in memory and none on disk. Without it anvil writes every mined block's full state
# to /root/.foundry/anvil/tmp in the container layer; the replay mines a block per tick, which filled the 23 GB disk
# on 2026-10-18 (16 GB of state history). Nothing reads state at an old block (the bell reads headers by number only).
PRUNE=${ANVIL_PRUNE_HISTORY:-8}
# Transaction retention: keep transactions and receipts of the last N blocks (anvil --transaction-block-keeper). The
# flag is added only when ANVIL_TX_BLOCK_KEEPER is set and non-empty (compose default 7200). It bounds history on a
# fresh fork only; a dump loaded with the flag keeps the transactions it already holds (rig probe 2026-10-23).
KEEPER=${ANVIL_TX_BLOCK_KEEPER:-}
EXTRA=()
if [ -n "$KEEPER" ]; then EXTRA+=(--transaction-block-keeper "$KEEPER"); fi
mkdir -p "$(dirname "$STATE")"
child=0
stopping=0
log() { echo "[anvil-supervisor $(date -u +%FT%TZ)] $*"; }
quarantine() { # move the dump aside (never delete) so anvil starts a fresh fork instead of failing on it
  local dst
  dst="$STATE.corrupt-$(date -u +%Y%m%dT%H%M%SZ)"
  if mv -- "$STATE" "$dst"; then log "$1: moved $STATE ($(stat -c %s "$dst" 2>/dev/null || echo '?') bytes) to $dst"
  else log "$1: could not move $STATE aside"; fi
}
state_truncated() { # true when the dump exists and its last non-blank byte is not "}"
  [ -e "$STATE" ] || return 1
  [ "$(tail -c 64 "$STATE" 2>/dev/null | tr -d ' \t\r\n' | tail -c 1)" != "}" ]
}
# anvil 1.7.1 on a truncated dump: "error: invalid value '/data/anvil.json' for '--state <PATH>': failed to parse json
# file: ...", exit 2. stderr is copied to ERRLOG (container tmp, truncated on every start) so the loop can match it.
STATE_ERR="for '--state <PATH>': failed to parse json file"
ERRLOG=${ANVIL_ERRLOG:-/tmp/anvil-supervisor.stderr}
: > "$ERRLOG"
on_stop() {
  stopping=1
  echo "[anvil-supervisor $(date -u +%FT%TZ)] $1: stopping anvil (pid $child), waiting for the state dump"
  if [ "$child" -gt 0 ]; then kill -TERM "$child" 2>/dev/null; wait "$child"; fi
  exit 0
}
# Clock restore: anvil 1.7.1 does not keep the evm_increaseTime offset in its dump, so after a restart on a dump new
# blocks are stamped near wall time, behind the reference's last round, and every bell post reverts (OutOfOrder).
# restore-clock.sh (next to this file; the rig helper infra/ops/rig/anvil-up.sh runs the same script) waits until anvil
# answers, then stamps the next block after the reference's last round and the recent block timestamps.
HERE=$(cd "$(dirname "$0")" && pwd)
restore_clock() {
  if [ -f "$HERE/restore-clock.sh" ]; then bash "$HERE/restore-clock.sh" http://127.0.0.1:8545 "$ANVIL_FORK_BLOCK" "$1"
  else log "clock restore skipped: $HERE/restore-clock.sh missing (compose must mount ./anvil, not only entrypoint.sh)"; fi
}
trap 'on_stop SIGTERM' TERM
trap 'on_stop SIGINT' INT
for _ in $(seq 1 60); do
  if [ "$(cast chain-id --rpc-url "$UPSTREAM" 2>/dev/null)" = 4663 ]; then break; fi
  echo "[anvil-supervisor] waiting for the upstream proxy at $UPSTREAM"
  sleep 2
done
while [ "$stopping" = 0 ]; do
  if [ -e "$STATE" ] && grep -qF -- "$STATE_ERR" "$ERRLOG" 2>/dev/null; then quarantine "anvil could not parse the dump"
  elif state_truncated; then quarantine "dump does not end with }"; fi
  : > "$ERRLOG"
  started=$SECONDS
  echo "[anvil-supervisor $(date -u +%FT%TZ)] start anvil 0.0.0.0:8545, chain id $CHAIN_ID, fork block $ANVIL_FORK_BLOCK, tx keeper ${KEEPER:-off}"
  anvil --fork-url "$UPSTREAM" --fork-block-number "$ANVIL_FORK_BLOCK" --chain-id "$CHAIN_ID" \
    --host 0.0.0.0 --port 8545 --state "$STATE" --state-interval "$INTERVAL" --hardfork cancun \
    --retries 12 --fork-retry-backoff 1000 --timeout 120000 --prune-history "$PRUNE" "${EXTRA[@]}" \
    2> >(tee -a "$ERRLOG" >&2) &
  child=$!
  restore_clock "$child" &
  wait "$child"
  rc=$?
  child=0
  log "anvil exited $rc after $((SECONDS - started)) s"
  sleep 2 # also lets tee flush ERRLOG before the next check
done
