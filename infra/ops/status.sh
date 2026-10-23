#!/usr/bin/env bash
# Playground health in one line. Read-only: GETs to the bell, ps/df/stat/cast on the anvil host.
#
#   infra/ops/status.sh            the VM: bell at https://api-play.bellswap.fun, host metrics over ssh (VM_IP and SSH_KEY required)
#   infra/ops/status.sh --rig      the local rig: bell :18787, anvil :18545, the dump that anvil writes (its --state)
#   --json                         one JSON object instead of the key=value line
#
# Fields: tick_age_s (wall seconds since the bell's last replay tick: feed.lastTickAt when the feed module is live,
# replay.lastTick.at only on a bell without it), rows (rows in the last post), tick_p95_ms (feed.tickP95Ms, else na),
# dump_mb, anvil_rss_mb, disk_free_gb, open, settled, due (open tickets, every page of /tickets, whose expiry is at or
# before the fork clock), due_oldest (its id), vault_free_pct, indexed_lag (blocks), head_ts (newest block timestamp),
# ref_ts (the reference's last round over NVDA, RTX, SPY), clock_ok (head_ts at or after ref_ts: the reference rejects
# rounds later than block.timestamp, so a head behind its last round means the clock regressed after an anvil restart
# and every post reverts).
# A measurement that could not be taken is printed as None and fails the line (fail=missing:<names>); it is never
# read as a zero. STATUS_DUMP_OPTIONAL=1 accepts a missing dump (a fresh fork writes its first dump after
# ANVIL_STATE_INTERVAL, 600 s); reseed.sh step j sets it.
# Exit 0 green; 1 when a threshold is crossed (tick lag over 5 s, rows over 128, anvil RSS over 6 GB, dump over
# 1.5 GB, disk under 3 GB, clock behind) or a measurement is missing; 2 when the bell does not answer. due above 0 is
# reported, not failed: soak.sh fails it when the same ticket stays due for 60 s.
# Env: BELL_URL, ANVIL_RPC, ANVIL_PORT, RIG_DIR, RIG_DUMP (rig); VM_IP, SSH_KEY, COMPOSE_PROJECT (VM); STATUS_REF.
set -uo pipefail

MODE=vm; JSON=0
for a in "$@"; do case "$a" in --rig) MODE=rig ;; --json) JSON=1 ;; -h|--help) sed -n 2,24p "$0"; exit 0 ;; esac; done
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
VM_IP=${VM_IP:-}
KEY=${SSH_KEY:-}
PROJECT=${COMPOSE_PROJECT:-bellswap-play}
SSH_OPTS=(-o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -i "$KEY")
REF=${STATUS_REF:-$(jq -r '.demoSigner // empty' "$ROOT/deployments/book.json" 2>/dev/null)}
REF_SYMS="NVDA RTX SPY"
# The reference keys as bytes32 (cast format-bytes32-string), encoded here: that subcommand takes no --rpc-url, so the
# rpc-bound cast wrappers below cannot produce them.
REF_KEYS=$(python3 -c 'import sys
print(" ".join("0x" + s.encode().hex().ljust(64, "0") for s in sys.argv[1:]))' $REF_SYMS)
if [ "$MODE" = rig ]; then
  BELL_URL=${BELL_URL:-http://127.0.0.1:18787}
  ANVIL_PORT=${ANVIL_PORT:-18545}
  ANVIL_RPC=${ANVIL_RPC:-http://127.0.0.1:$ANVIL_PORT}
  RIG_DIR=${RIG_DIR:-./tmp/rig}
else
  BELL_URL=${BELL_URL:-https://api-play.bellswap.fun}
  [ -n "$VM_IP" ] && [ -n "$KEY" ] || { echo "status.sh: set VM_IP and SSH_KEY for the VM mode" >&2; exit 2; }
fi

get() { curl -sf --max-time 10 "$BELL_URL$1"; }
state=$(get /state | jq -c . 2>/dev/null) && [ -n "$state" ] || { echo "bell at $BELL_URL does not answer /state"; exit 2; }
vault=$(get /vault | jq -c . 2>/dev/null) || vault=""
# Every open ticket: pages of 500, newest first, continued with before=<lowest id of the page> (API contract 3.2).
tickets_ok=1; before=""; tickets=""
for _ in $(seq 1 400); do
  if ! page=$(get "/tickets?status=open&limit=500${before:+&before=$before}"); then tickets_ok=0; break; fi
  rows_jsonl=$(jq -c '.tickets[]?' <<<"$page") || { tickets_ok=0; break; }
  [ -n "$rows_jsonl" ] && tickets+="$rows_jsonl"$'\n'
  n=$(jq '.tickets | length' <<<"$page")
  [ "$n" -lt 500 ] && break
  next=$(jq -r '[.tickets[].id | tonumber] | min' <<<"$page")
  if [ "$next" = "$before" ]; then tickets_ok=0; break; fi # the bell ignores before=: more than 500 open, count incomplete
  before=$next
done
now_ms=$(python3 -c 'import time; print(int(time.time()*1000))')

ref_max() { # ref_max <rpc>: highest last-round timestamp of REF_SYMS at REF, empty when none could be read
  local k t best=""
  [ -n "$REF" ] || return 0
  for k in $REF_KEYS; do
    t=$(cast call "$REF" 'latest(bytes32)(uint256,uint64,uint8)' "$k" --rpc-url "$1" 2>/dev/null | sed -n 2p | awk '{print $1}')
    if [ -n "$t" ] && { [ -z "$best" ] || [ "$t" -gt "$best" ]; }; then best=$t; fi
  done
  echo "$best"
}
rss_kb=""; dump_b=""; disk_kb=""; head_ts=""; ref_ts=""
if [ "$MODE" = rig ]; then
  pid=$(lsof -nP -iTCP:"$ANVIL_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
  if [ -n "$pid" ]; then
    rss_kb=$(ps -o rss= -p "$pid" | tr -d ' ')
    # The dump this anvil writes: its --state argument (reseed --rig uses $RIG_DIR/reseed/anvil.json, soaks their own).
    state_arg=$(ps -o args= -p "$pid" | sed -n 's/.*--state \([^ ]*\).*/\1/p')
  fi
  RIG_DUMP=${RIG_DUMP:-${state_arg:-$RIG_DIR/reseed/anvil.json}}
  dump_b=$(stat -f %z "$RIG_DUMP" 2>/dev/null || stat -c %s "$RIG_DUMP" 2>/dev/null || true)
  disk_kb=$(df -k "$(dirname "$RIG_DUMP")" 2>/dev/null | awk 'NR==2{print $4}')
  head_ts=$(cast block latest -f timestamp --rpc-url "$ANVIL_RPC" 2>/dev/null || true)
  ref_ts=$(ref_max "$ANVIL_RPC")
else
  remote="pid=\$(docker inspect -f '{{.State.Pid}}' ${PROJECT}-anvil-1 2>/dev/null || echo 0)
apid=\$(pgrep -P \"\$pid\" -x anvil 2>/dev/null | head -1)
echo rss_kb=\$(ps -o rss= -p \"\${apid:-\$pid}\" 2>/dev/null | tr -d ' ')
echo dump_b=\$(sudo stat -c %s /var/lib/docker/volumes/${PROJECT}_anvil-data/_data/anvil.json 2>/dev/null)
echo disk_kb=\$(df -k / | awk 'NR==2{print \$4}')
c() { docker exec ${PROJECT}-anvil-1 cast \"\$@\" --rpc-url http://127.0.0.1:8545 2>/dev/null; }
echo head_ts=\$(c block latest -f timestamp)
best=
for k in $REF_KEYS; do
  t=\$(c call $REF 'latest(bytes32)(uint256,uint64,uint8)' \$k | sed -n 2p | awk '{print \$1}')
  if [ -n \"\$t\" ] && { [ -z \"\$best\" ] || [ \"\$t\" -gt \"\$best\" ]; }; then best=\$t; fi
done
echo ref_ts=\$best"
  [ -n "$REF" ] || remote=$(printf '%s\n' "$remote" | sed '/^best=$/,$d')
  host=$(ssh "${SSH_OPTS[@]}" "debian@$VM_IP" "bash -s" <<<"$remote" 2>/dev/null || true)
  eval "$(printf '%s\n' "$host" | grep -E '^(rss_kb|dump_b|disk_kb|head_ts|ref_ts)=[0-9]+$')"
fi

PY_STATUS=$(cat <<'PY'
import json, sys
tickets_ok, now_ms = sys.argv[1] == '1', int(sys.argv[2])
def num(x):
    return int(x) if x.strip().isdigit() else None
rss_kb, dump_b, disk_kb, head_ts, ref_ts = (num(x) for x in sys.argv[3:8])
as_json, dump_optional, ref_set = sys.argv[8] == '1', sys.argv[9] == '1', sys.argv[10] == '1'
lines = sys.stdin.read().split('\n')
def parse(x):
    try:
        return json.loads(x) if x.strip() else None
    except ValueError:
        return None
state = parse(lines[0]) or {}
vault = parse(lines[1]) if len(lines) > 1 else None
tickets = []
for l in lines[2:]:
    t = parse(l)
    if isinstance(t, dict): tickets.append(t)
    elif l.strip(): tickets_ok = False
replay = state.get('replay') or {}
has_feed = isinstance(state.get('feed'), dict)
feed = state.get('feed') or {}
# With the feed module only its own tick counts: an idle replay loop keeps replay.lastTick.at fresh without posting.
last = (feed.get('lastTickAt') or 0) if has_feed else ((replay.get('lastTick') or {}).get('at') or 0)
tick_age = round((now_ms - last) / 1000, 1) if last else None
rows = feed.get('rowsLastPost') if has_feed else (replay.get('lastTick') or {}).get('posted')
p95 = feed.get('tickP95Ms')
clock = int(state.get('clockUnix') or 0)
seen = {}
for t in tickets:
    if t.get('status', 'open') == 'open':
        seen[str(t.get('id'))] = t
due = [t for t in seen.values() if int(t.get('expiry', 0)) <= clock] if tickets_ok else None
due_oldest = min(due, key=lambda t: int(t['expiry']))['id'] if due else None
counts = state.get('counts') or {}
assets = int((vault or {}).get('assets') or (vault or {}).get('assetsRaw') or 0)
free = int((vault or {}).get('free') or (vault or {}).get('freeRaw') or 0)
free_pct = round(100 * free / assets, 1) if assets else None
clock_ok = None if head_ts is None or ref_ts is None else head_ts >= ref_ts
out = {
    'tick_age_s': tick_age, 'rows': rows, 'tick_p95_ms': p95 if p95 is not None else 'na',
    'dump_mb': round(dump_b / 1e6, 1) if dump_b is not None else None,
    'anvil_rss_mb': round(rss_kb / 1024, 1) if rss_kb is not None else None,
    'disk_free_gb': round(disk_kb / 1024 / 1024, 2) if disk_kb is not None else None,
    'tickets': counts.get('tickets'), 'open': counts.get('open'), 'open_listed': len(seen) if tickets_ok else None,
    'settled': counts.get('settled'), 'due': len(due) if due is not None else None, 'due_oldest': due_oldest,
    'vault_free_pct': free_pct, 'block': state.get('block'),
    'indexed_lag': (state.get('block') or 0) - (state.get('indexedBlock') or 0),
    'clock': clock, 'head_ts': head_ts, 'ref_ts': ref_ts, 'clock_ok': clock_ok, 'running': replay.get('running'),
    'feed': has_feed,
}
fail, missing = [], []
if rss_kb is None: missing.append('rss')
if dump_b is None and not dump_optional: missing.append('dump')
if disk_kb is None: missing.append('disk')
if head_ts is None: missing.append('head_ts')
if ref_set and ref_ts is None: missing.append('ref_ts')
if not tickets_ok: missing.append('tickets')
if vault is None: missing.append('vault')
if tick_age is None or tick_age > 5: fail.append('tick_lag')
if isinstance(rows, (int, float)) and rows > 128: fail.append('rows')
if rss_kb is not None and rss_kb > 6 * 1024 * 1024: fail.append('rss')
if dump_b is not None and dump_b > 1.5e9: fail.append('dump')
if disk_kb is not None and disk_kb < 3 * 1024 * 1024: fail.append('disk')
if clock_ok is False: fail.append('clock_behind')
if missing: fail.append('missing:' + '+'.join(missing))
out['fail'] = ','.join(fail) or 'none'
print(json.dumps(out) if as_json else ' '.join(f'{k}={v}' for k, v in out.items()))
sys.exit(1 if fail else 0)
PY
)
{ printf '%s\n%s\n' "$state" "$vault"; printf '%s' "$tickets"; } |
  python3 -c "$PY_STATUS" "$tickets_ok" "$now_ms" "$rss_kb" "$dump_b" "$disk_kb" "$head_ts" "$ref_ts" "$JSON" "${STATUS_DUMP_OPTIONAL:-0}" "$([ -n "$REF" ] && echo 1 || echo 0)"
