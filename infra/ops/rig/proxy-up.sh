#!/usr/bin/env bash
# Rig upstream proxy on 127.0.0.1:18672 to the keyed dRPC URL (key from DRPC_KEY in the environment, never printed).
set -euo pipefail
RIG=${RIG_DIR:-./tmp/rig}
mkdir -p "$RIG"
WT=${WT:-$(cd "$(dirname "$0")/../../.." && pwd)}
PORT=${RIG_PROXY_PORT:-18672}
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "proxy already on :$PORT"; exit 0; fi
set +x
drpc_key=${DRPC_KEY:-}
[ -n "$drpc_key" ] || { echo "set DRPC_KEY (a dRPC key with Robinhood Chain access) in the environment"; exit 1; }
PROXY_UPSTREAM="https://lb.drpc.live/robinhood/$drpc_key" PROXY_HOST=127.0.0.1 \
  nohup python3 -u "$WT/infra/fork/upstream-proxy.py" "$PORT" >>"$RIG/proxy.log" 2>&1 &
echo $! > "$RIG/proxy.pid"
unset drpc_key
for _ in $(seq 1 30); do
  if [ "$(cast chain-id --rpc-url "http://127.0.0.1:$PORT" 2>/dev/null)" = 4663 ]; then echo "proxy up on :$PORT (pid $(cat "$RIG/proxy.pid")), chain id 4663"; exit 0; fi
  sleep 1
done
echo "proxy did not answer chain id 4663"; tail -5 "$RIG/proxy.log"; exit 1
