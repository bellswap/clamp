#!/usr/bin/env bash
# Clock restore after anvil starts on a dump. anvil 1.7.1 does not keep the evm_increaseTime offset in its dump: after a
# restart new blocks are stamped near wall time, behind the reference's last round, so every bell post reverts
# (OutOfOrder) and no ticket settles until wall time catches up (rig, 2026-10-23: 2,170 reverted posts).
#
#   restore-clock.sh <rpc url> <fork block> [anvil pid]
#
# Used by infra/anvil/entrypoint.sh (in the background, after every anvil start) and by the rig helper
# infra/ops/rig/anvil-up.sh (after the rig anvil answers), so the VM and the rig restore the clock the same way.
# Target: the highest of
#   (a) the reference's last round timestamp for ANVIL_CLOCK_SYMBOLS (default NVDA RTX SPY) at ANVIL_CLOCK_REF (the
#       DemoSignerReference, default the deployments/book.json demoSigner). DemoSignerReference.post rejects a round
#       later than block.timestamp (FutureRound), so on a healthy chain the head is never behind it; and
#   (b) the block timestamps of the last ANVIL_CLOCK_WINDOW blocks (default 64) above the fork block.
# (a) does not depend on how many blocks were mined at wall time before this check ran; (b) covers a fork without
# rounds. When the newest block is behind the target, or the target is ahead of wall time (the next block would be
# stamped near wall time), the next block is stamped target + 1 and one block is mined; anvil continues from there.
# ANVIL_RESTORE_CLOCK=0 turns it off. A fresh fork (head at the fork block) is left alone. Exit 0 always (logs only).
set -uo pipefail
RPC=${1:?rpc url}; FORK_BLOCK=${2:?fork block}; PID=${3:-}
[ "${ANVIL_RESTORE_CLOCK:-1}" = 1 ] || exit 0
CHAIN_ID=${ANVIL_CHAIN_ID:-46633}
WINDOW=${ANVIL_CLOCK_WINDOW:-64}
REF=${ANVIL_CLOCK_REF-0x980ea9f1a0C36e1E5f3B6BD451bEf8a7Fe661f97}
SYMS=${ANVIL_CLOCK_SYMBOLS:-NVDA RTX SPY}
log() { echo "[anvil-supervisor $(date -u +%FT%TZ)] $*"; }

for _ in $(seq 1 600); do
  [ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" = "$CHAIN_ID" ] && break
  if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then exit 0; fi
  sleep 1
done
head=$(cast block-number --rpc-url "$RPC" 2>/dev/null) || exit 0
if [ "$head" -le "$FORK_BLOCK" ]; then log "clock check: fresh fork (head $head), nothing to restore"; exit 0; fi

win=0; n=$head
while [ "$n" -gt "$FORK_BLOCK" ] && [ "$n" -gt $((head - WINDOW)) ]; do
  ts=$(cast block "$n" -f timestamp --rpc-url "$RPC" 2>/dev/null) && [ "$ts" -gt "$win" ] && win=$ts
  n=$((n - 1))
done
ref=0
if [ -n "$REF" ] && [ "$(cast code "$REF" --rpc-url "$RPC" 2>/dev/null)" != 0x ]; then
  for s in $SYMS; do
    t=$(cast call "$REF" 'latest(bytes32)(uint256,uint64,uint8)' "$(cast format-bytes32-string "$s")" --rpc-url "$RPC" 2>/dev/null |
      sed -n 2p | awk '{print $1}')
    [ -n "$t" ] && [ "$t" -gt "$ref" ] 2>/dev/null && ref=$t
  done
fi
target=$(( win > ref ? win : ref ))
latest=$(cast block latest -f timestamp --rpc-url "$RPC" 2>/dev/null) || exit 0
now=$(date +%s)
if [ "$target" -gt "$now" ] || [ "$latest" -lt "$target" ]; then
  if cast rpc evm_setNextBlockTimestamp $((target + 1)) --rpc-url "$RPC" >/dev/null && cast rpc evm_mine --rpc-url "$RPC" >/dev/null; then
    log "clock restored: reference last round $ref, last $WINDOW blocks max $win, newest block $latest, wall $now; next block at $((target + 1))"
  else
    log "clock restore FAILED: could not set the next block timestamp to $((target + 1)) (newest block $latest)"
  fi
else
  log "clock check: newest block $latest, reference last round $ref, last $WINDOW blocks max $win, wall $now; nothing to restore"
fi
