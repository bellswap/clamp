#!/usr/bin/env bash
# Rig anvil: anvil-up.sh <keeper N|none> <state file> [port]. Same flags as infra/anvil/entrypoint.sh, and the same
# clock restore (infra/anvil/restore-clock.sh) once anvil answers, so a reloaded dump does not regress the clock.
set -euo pipefail
WT_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RIG=${RIG_DIR:-./tmp/rig}
mkdir -p "$RIG"
N=${1:?keeper}; STATE=${2:?state}; PORT=${3:-18545}
FORK_BLOCK=${ANVIL_FORK_BLOCK:-91989489}
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT busy"; exit 1; fi
mkdir -p "$(dirname "$STATE")"
extra=()
[ "$N" != none ] && extra=(--transaction-block-keeper "$N")
nohup anvil --fork-url http://127.0.0.1:${RIG_PROXY_PORT:-18672} --fork-block-number "$FORK_BLOCK" --chain-id 46633 \
  --host 127.0.0.1 --port "$PORT" --state "$STATE" --state-interval "${ANVIL_STATE_INTERVAL:-600}" --hardfork cancun \
  --retries 12 --fork-retry-backoff 1000 --timeout 120000 --prune-history 8 "${extra[@]}" \
  >>"$RIG/anvil-$PORT.log" 2>&1 &
echo $! > "$RIG/anvil-$PORT.pid"
for _ in $(seq 1 60); do
  if [ "$(cast chain-id --rpc-url "http://127.0.0.1:$PORT" 2>/dev/null)" = 46633 ]; then
    echo "anvil up on :$PORT pid $(cat "$RIG/anvil-$PORT.pid") keeper $N state $STATE block $(cast block-number --rpc-url http://127.0.0.1:$PORT)"
    bash "$WT_ROOT/infra/anvil/restore-clock.sh" "http://127.0.0.1:$PORT" "$FORK_BLOCK" "$(cat "$RIG/anvil-$PORT.pid")"
    exit 0; fi
  sleep 1
done
echo "anvil did not come up"; tail -20 "$RIG/anvil-$PORT.log"; exit 1
