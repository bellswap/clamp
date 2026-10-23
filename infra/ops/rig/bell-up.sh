#!/usr/bin/env bash
# Rig bell: bell-up.sh <data dir> <speed> [bell port] [anvil port] [bell src dir]. Admin token in $RIG/admin-token (mode 600).
set -euo pipefail
RIG=${RIG_DIR:-./tmp/rig}
mkdir -p "$RIG"
DATA=${1:?data dir}; SPEED=${2:-60}; BPORT=${3:-18787}; APORT=${4:-18545}
SRC=${5:-${BELL_SRC:-$(cd "$(dirname "$0")/../../.." && pwd)/services/bell}}
BOOK=${RIG_BOOK:-$RIG/repo-$APORT/deployments/book.json}
mkdir -p "$DATA"
if [ ! -s "$RIG/admin-token" ]; then ( umask 077; openssl rand -hex 24 > "$RIG/admin-token" ); fi
if lsof -nP -iTCP:"$BPORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $BPORT busy"; exit 1; fi
cp "$BOOK" "$DATA/book.json"
# Charts cache: reuse a fetched series when one exists in the rig (saves a Yahoo round).
if [ ! -d "$DATA/charts" ] && [ -d "$RIG/charts-cache" ]; then cp -R "$RIG/charts-cache" "$DATA/charts"; fi
( cd "$SRC" && BELL_RPC_URL=http://127.0.0.1:$APORT BELL_PORT=$BPORT BELL_CHAIN_ID=46633 \
  BELL_SIGNER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
  BELL_ADMIN_TOKEN_FILE="$RIG/admin-token" BELL_STATE_FILE="$DATA/state.json" BELL_BOOK="$DATA/book.json" \
  BELL_REPLAY_SPEED=$SPEED BELL_FAUCET_IP_MAX=${BELL_FAUCET_IP_MAX:-1000} \
  nohup bun run src/index.ts >>"$DATA/bell.log" 2>&1 & echo $! > "$RIG/bell-$BPORT.pid" )
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$BPORT/state" >/dev/null 2>&1; then lsof -nP -iTCP:"$BPORT" -sTCP:LISTEN -t | head -1 > "$RIG/bell-$BPORT.pid"; echo "bell up on :$BPORT pid $(cat "$RIG/bell-$BPORT.pid") speed $SPEED data $DATA"; exit 0; fi
  sleep 1
done
echo "bell did not answer /state"; tail -20 "$DATA/bell.log"; exit 1
