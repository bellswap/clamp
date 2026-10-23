#!/usr/bin/env bash
# Soak logger: status.sh every SOAK_INTERVAL seconds (default 60) appended to a log, with a linear projection of the
# dump size and the anvil RSS to SOAK_UNTIL (default the next 18:00 SGT, 10:00 UTC). Runs until stopped (kill the pid).
#
#   infra/ops/soak.sh [--rig] <log file>            e.g. infra/ops/soak.sh --rig "$RIG_DIR/soak.log"
#   infra/ops/soak.sh --verdict <log file>          PASS or FAIL for the soak gate (exit 0 or 1), see below
#
# Each sample is one line: "<UTC time> <status.sh key=value line> status_exit=<n> proj_dump_mb=<x> proj_rss_mb=<y>".
# The projection is linear over the last SOAK_WINDOW samples (default 20 minutes, two dump writes at the 600 s
# interval). Early samples overstate the growth while the keeper window fills (SOAK_KEEPER blocks, default 7200, about
# 55 min), so a projection over a threshold (dump 1.5 GB, RSS 6 GB) is a NOTE before the chain has advanced SOAK_KEEPER
# blocks since the first sample and an ALERT after. An "ALERT" line is also written when status.sh exits 1 or 2, or
# when the same ticket stays due for 60 s or more.
# Verdict: PASS only when the log covers at least SOAK_MIN_BLOCKS blocks (default SOAK_KEEPER + 1800: the window
# filled, then about 12 minutes of plateau), has no ALERT line, and its last projection is under both thresholds.
# A soak that stopped before the window filled is FAIL (not enough evidence), whatever its alerts say. Coverage is the
# forward advance from the first to the last sample; a block number lower than the sample before it (a chain reset,
# or another soak appended to the same log) is FAIL, and the logger writes an ALERT line for it.
# Environment is passed to status.sh unchanged (BELL_URL, ANVIL_PORT, RIG_DUMP, VM_IP, ...).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ARGS=()
LOG=""
VERDICT=0
for a in "$@"; do case "$a" in --rig) ARGS+=(--rig) ;; --verdict) VERDICT=1 ;; *) LOG=$a ;; esac; done
[ -n "$LOG" ] || { echo "usage: soak.sh [--rig] <log file> | soak.sh --verdict <log file>"; exit 2; }
KEEPER=${SOAK_KEEPER:-7200}
MAX_DUMP_MB=1500; MAX_RSS_MB=6144
if [ "$VERDICT" = 1 ]; then
  python3 - "$LOG" "${SOAK_MIN_BLOCKS:-$((KEEPER + 1800))}" "$MAX_DUMP_MB" "$MAX_RSS_MB" <<'PY'
import re, sys
log, min_blocks, max_dump, max_rss = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
blocks, alerts, proj = [], 0, None
for line in open(log):
    if ' ALERT ' in line: alerts += 1
    m = re.search(r' block=(\d+)', line)
    if m: blocks.append(int(m.group(1)))
    p = re.search(r'proj_dump_mb=([-\d.]+) proj_rss_mb=([-\d.]+)', line)
    if p: proj = (float(p.group(1)), float(p.group(2)))
back = [(a, b) for a, b in zip(blocks, blocks[1:]) if b < a]
covered = (blocks[-1] - blocks[0]) if blocks else 0
why = []
if back: why.append(f'block number went back {len(back)} times (first {back[0][0]} to {back[0][1]}): a chain reset or an appended soak, start a new log')
if covered < min_blocks: why.append(f'covers {covered} blocks, needs {min_blocks} (keeper window filled plus plateau)')
if alerts: why.append(f'{alerts} ALERT lines')
if proj is None: why.append('no projection')
elif proj[0] > max_dump or proj[1] > max_rss: why.append(f'last projection dump {proj[0]:.0f} MB, RSS {proj[1]:.0f} MB over {max_dump:.0f} / {max_rss:.0f}')
print(('FAIL ' + '; '.join(why)) if why else f'PASS {covered} blocks, 0 alerts, last projection dump {proj[0]:.0f} MB, RSS {proj[1]:.0f} MB')
sys.exit(1 if why else 0)
PY
  exit $?
fi
INTERVAL=${SOAK_INTERVAL:-60}
UNTIL=${SOAK_UNTIL:-$(python3 -c 'import time,datetime as d
n=d.datetime.now(d.timezone.utc); t=n.replace(hour=10,minute=0,second=0,microsecond=0)
print(int((t if t>n else t+d.timedelta(days=1)).timestamp()))')}
mkdir -p "$(dirname "$LOG")"
echo "# soak start $(date -u +%FT%TZ) pid $$ interval ${INTERVAL}s projection to $(date -u -r "$UNTIL" +%FT%TZ 2>/dev/null || date -u -d "@$UNTIL" +%FT%TZ) args ${ARGS[*]:-vm}" >>"$LOG"
WINDOW=${SOAK_WINDOW:-20}
TS=(); DS=(); RS=(); due_id=""; due_since=0; block0=""; block_prev=""
while :; do
  now=$(date +%s)
  line=$(bash "$HERE/status.sh" "${ARGS[@]}" 2>&1); rc=$?
  dump=$(sed -n 's/.*dump_mb=\([0-9.]*\).*/\1/p' <<<"$line")
  rss=$(sed -n 's/.*anvil_rss_mb=\([0-9.]*\).*/\1/p' <<<"$line")
  due_oldest=$(sed -n 's/.*due_oldest=\([^ ]*\).*/\1/p' <<<"$line")
  proj=""
  if [ -n "$dump" ] && [ -n "$rss" ]; then
    TS+=("$now"); DS+=("$dump"); RS+=("$rss")
    i0=$(( ${#TS[@]} > WINDOW ? ${#TS[@]} - WINDOW - 1 : 0 ))
    proj=$(python3 -c "
t0,t1,u=${TS[$i0]},$now,$UNTIL
d0,d1,r0,r1=${DS[$i0]},$dump,${RS[$i0]},$rss
k=(u-t1)/(t1-t0) if t1>t0 else 0
print(f'proj_dump_mb={d1+(d1-d0)*k:.0f} proj_rss_mb={r1+(r1-r0)*k:.0f}')")
  fi
  echo "$(date -u +%FT%TZ) $line status_exit=$rc $proj" >>"$LOG"
  if [ "$rc" != 0 ]; then echo "$(date -u +%FT%TZ) ALERT status exit $rc" >>"$LOG"; fi
  block=$(sed -n 's/.* block=\([0-9]*\).*/\1/p' <<<"$line")
  if [ -n "$block" ] && [ -n "$block_prev" ] && [ "$block" -lt "$block_prev" ]; then
    echo "$(date -u +%FT%TZ) ALERT block number went back from $block_prev to $block (chain reset); the keeper window restarts" >>"$LOG"
    block0=$block
  fi
  [ -n "$block" ] && block_prev=$block
  [ -z "$block0" ] && [ -n "$block" ] && block0=$block
  if [ -n "$proj" ] && python3 -c "
import re, sys; m = re.search(r'proj_dump_mb=([-\d.]+) proj_rss_mb=([-\d.]+)', sys.argv[1])
sys.exit(0 if m and (float(m.group(1)) > $MAX_DUMP_MB or float(m.group(2)) > $MAX_RSS_MB) else 1)" "$proj"; then
    if [ -n "$block" ] && [ -n "$block0" ] && [ $((block - block0)) -ge "$KEEPER" ]; then
      echo "$(date -u +%FT%TZ) ALERT projection over threshold after the keeper window filled ($proj)" >>"$LOG"
    else
      echo "$(date -u +%FT%TZ) NOTE projection over threshold while the keeper window fills ($((${block:-0} - ${block0:-0})) of $KEEPER blocks)" >>"$LOG"
    fi
  fi
  if [ -n "$due_oldest" ] && [ "$due_oldest" != None ]; then
    if [ "$due_oldest" = "$due_id" ]; then
      [ $((now - due_since)) -ge 60 ] && echo "$(date -u +%FT%TZ) ALERT ticket $due_id due and unsettled for $((now - due_since)) s" >>"$LOG"
    else due_id=$due_oldest; due_since=$now; fi
  else due_id=""; fi
  sleep "$INTERVAL"
done
