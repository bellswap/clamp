#!/usr/bin/env bash
# Deploy the Bellswap v2 playground stack to the playground VM. Idempotent: rerun at will.
#
#   infra/deploy.sh                 sync, build, start, deploy contracts if missing, publish the book, start the replay
#   SKIP_CONTRACTS=1 infra/deploy.sh   stack only
#   FORCE_CONTRACTS=1 infra/deploy.sh  redeploy the contracts even when the recorded book has code on the fork
#   BELL=0 infra/deploy.sh             leave the bell service out
#   VM_IP, SSH_KEY (required), TUNNEL_PORT   the target VM, the SSH key path and the local tunnel port
#
# Steps: (1) rsync the repo to /opt/bellswap-v2 (no node_modules, .git, .trash, dist, secrets, build output);
# (2) create infra/.env on the VM on first run (fork block from .env.example, bell signer = anvil dev key 1, admin
# token = 24 random bytes hex made on the VM) and keep a local copy of the token in deploy/.admin-token (mode 600);
# (3) docker compose up -d --build (the bell profile only when services/bell has a src/index.ts); (4) wait for anvil
# and eRPC; (5) forge script contracts/script/Deploy.s.sol against the private anvil through an SSH tunnel with anvil
# dev key 0 on chain 46633, unless deployments/book.json already has code on the fork; (6) copy
# deployments/46633.json to deployments/book.json and into the bell volume (/data/book.json); (7) POST /replay.
# Secrets are never printed: the admin token goes to files and header files only.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VM_IP=${VM_IP:?set VM_IP to the playground VM address}
KEY=${SSH_KEY:?set SSH_KEY to the SSH key file for the VM}
REMOTE=/opt/bellswap-v2
TUNNEL_PORT=${TUNNEL_PORT:-18545}
RPC_HOST=rpc-play.bellswap.fun
API_HOST=api-play.bellswap.fun
CHAIN_ID=46633
# anvil dev account 0 (public test key; the fork's deployer and house wallet). Never a real key.
DEV0_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
SSH_OPTS=(-o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -i "$KEY")
CTL="/tmp/bsw-play-tunnel-$$.sock"

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
rsh() { ssh "${SSH_OPTS[@]}" "debian@$VM_IP" "$@"; }
cleanup() { ssh -S "$CTL" -O exit "debian@$VM_IP" 2>/dev/null || true; }
trap cleanup EXIT

# 1. Sync. No --delete: stale files on the VM are left in place (nothing is ever deleted by this script).
log "rsync $ROOT -> $VM_IP:$REMOTE"
rsync -az -e "ssh ${SSH_OPTS[*]}" \
  --exclude node_modules --exclude .git --exclude .trash --exclude dist --exclude 'dist-*' \
  --exclude .env --exclude '.env.local' --exclude .admin-token --exclude key --exclude '*.pem' \
  --exclude deploy/ --exclude contracts/out --exclude contracts/cache --exclude contracts/broadcast \
  --exclude deployments/local --exclude .DS_Store \
  "$ROOT/" "debian@$VM_IP:$REMOTE/"

# 2. Environment on the VM (first run only; an existing file is kept as is).
rsh "bash -s" <<'EOF'
set -euo pipefail
cd /opt/bellswap-v2/infra
umask 077
if [ ! -f .env ]; then
  grep -v '^BELL_ADMIN_TOKEN=' .env.example > .env
  echo "BELL_ADMIN_TOKEN=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> .env
  echo "[vm] infra/.env created"
elif ! grep -q '^BELL_ADMIN_TOKEN=..' .env; then
  sed -i '/^BELL_ADMIN_TOKEN=/d' .env
  echo "BELL_ADMIN_TOKEN=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> .env
  echo "[vm] admin token added to infra/.env"
fi
chmod 600 .env
EOF
mkdir -p "$ROOT/deploy"
( umask 077; rsh "sed -n 's/^BELL_ADMIN_TOKEN=//p' $REMOTE/infra/.env" > "$ROOT/deploy/.admin-token.new" )
if [ -s "$ROOT/deploy/.admin-token.new" ]; then mv "$ROOT/deploy/.admin-token.new" "$ROOT/deploy/.admin-token"; fi
chmod 600 "$ROOT/deploy/.admin-token"
log "admin token in deploy/.admin-token (mode 600)"

# 3. Stack.
PROFILES=""
# BELL=0 leaves the bell service out (for example while services/bell does not build yet).
if [ "${BELL:-auto}" != 0 ] && [ -f "$ROOT/services/bell/src/index.ts" ]; then PROFILES=bell; fi
BELL_DF=../../infra/bell/Dockerfile
[ -f "$ROOT/services/bell/Dockerfile" ] && BELL_DF=Dockerfile
log "docker compose up -d --build (profiles: ${PROFILES:-none}, bell dockerfile: $BELL_DF)"
rsh "cd $REMOTE/infra && COMPOSE_PROFILES='$PROFILES' BELL_DOCKERFILE='$BELL_DF' docker compose up -d --build --remove-orphans 2>&1 | tail -20"
# erpc.yaml and fork/upstream-proxy.py are bind mounts, so compose up does not see an edit; restart both to load them
# (a few seconds of no RPC; anvil keeps its state).
rsh "cd $REMOTE/infra && docker compose restart erpc proxy 2>&1 | tail -1"

# 4. Health: anvil (inside its container), then eRPC through Caddy on the VM.
log "waiting for anvil"
ok=0
for _ in $(seq 1 60); do
  cid=$(rsh "cd $REMOTE/infra && docker compose exec -T anvil cast chain-id --rpc-url http://127.0.0.1:8545 2>/dev/null" || true)
  if [ "$cid" = "$CHAIN_ID" ]; then ok=1; break; fi
  sleep 5
done
[ "$ok" = 1 ] || { log "anvil did not answer chain id $CHAIN_ID"; rsh "cd $REMOTE/infra && docker compose logs --tail 40 anvil proxy"; exit 1; }
log "anvil up: chain id $CHAIN_ID, block $(rsh "cd $REMOTE/infra && docker compose exec -T anvil cast block-number --rpc-url http://127.0.0.1:8545")"
log "waiting for eRPC behind Caddy"
ok=0
for _ in $(seq 1 30); do
  out=$(rsh "curl -sk --max-time 10 --resolve $RPC_HOST:443:127.0.0.1 https://$RPC_HOST -H 'content-type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_chainId\",\"params\":[]}'" || true)
  if printf '%s' "$out" | grep -q '"0xb629"'; then ok=1; break; fi
  sleep 5
done
[ "$ok" = 1 ] && log "eRPC answers eth_chainId 0xb629 behind Caddy" || log "eRPC not answering yet (last: ${out:-none})"

# 5. Contracts through an SSH tunnel to the VM's loopback anvil port.
BOOK="$ROOT/deployments/book.json"
book_live() { # the recorded vault, book and demo signer reference have code on the fork
  [ -s "$BOOK" ] || return 1
  [ "$(jq -r '.chainId // empty' "$BOOK")" = "$CHAIN_ID" ] || return 1
  local a
  for a in $(jq -r '.vault, .book, .demoSigner' "$BOOK"); do
    [[ $a =~ ^0x[0-9a-fA-F]{40}$ ]] || return 1
    [ "$(cast code "$a" --rpc-url "$TUN")" != 0x ] || return 1
  done
}
TUN="http://127.0.0.1:$TUNNEL_PORT"
DEV0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
# The bell service signs reference posts with anvil dev key 1 (BELL_SIGNER_KEY in infra/.env).
DEMO_SIGNER=${DEMO_SIGNER:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}
SEED_USDG=${SEED_USDG:-1000000000000}   # 1,000,000 USDG (6 decimals), the vault seed of Deploy.s.sol
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168          # USDG on Robinhood Chain, present on the fork
USDG_HOLDER=0x8366a39CC670B4001A1121B8F6A443A643e40951   # Uniswap v4 PoolManager, the largest USDG holder at the fork block
fund_deployer() { # fork only: give dev account 0 the vault seed from the impersonated holder, once
  local bal
  bal=$(cast call "$USDG" 'balanceOf(address)(uint256)' "$DEV0" --rpc-url "$TUN" | awk '{print $1}')
  if [ "$(python3 -c "print(int($bal) >= int($SEED_USDG))")" = True ]; then log "dev account 0 holds $bal USDG units"; return; fi
  log "funding dev account 0 with $SEED_USDG USDG units from the impersonated holder (fork only)"
  cast rpc anvil_setBalance "$USDG_HOLDER" 0x56BC75E2D63100000 --rpc-url "$TUN" >/dev/null
  cast rpc anvil_impersonateAccount "$USDG_HOLDER" --rpc-url "$TUN" >/dev/null
  cast send "$USDG" 'transfer(address,uint256)' "$DEV0" "$SEED_USDG" --from "$USDG_HOLDER" --unlocked --rpc-url "$TUN" >/dev/null
  cast rpc anvil_stopImpersonatingAccount "$USDG_HOLDER" --rpc-url "$TUN" >/dev/null
  log "dev account 0 now holds $(cast call "$USDG" 'balanceOf(address)(uint256)' "$DEV0" --rpc-url "$TUN") USDG units"
}
if [ "${SKIP_CONTRACTS:-0}" = 1 ]; then
  log "SKIP_CONTRACTS=1: contracts not touched"
elif [ ! -f "$ROOT/contracts/script/Deploy.s.sol" ]; then
  log "contracts/script/Deploy.s.sol not there yet: contracts skipped (rerun this script once it exists)"
else
  ssh "${SSH_OPTS[@]}" -M -S "$CTL" -f -N -o ExitOnForwardFailure=yes -L "127.0.0.1:$TUNNEL_PORT:127.0.0.1:8545" "debian@$VM_IP"
  [ "$(cast chain-id --rpc-url "$TUN")" = "$CHAIN_ID" ] || { log "tunnel does not reach the playground anvil"; exit 1; }
  if [ "${FORCE_CONTRACTS:-0}" != 1 ] && book_live; then
    log "deployments/book.json has code on the fork: contracts kept"
  else
    fund_deployer
    log "forge script Deploy.s.sol (dev key 0, chain $CHAIN_ID, DEMO_SIGNER $DEMO_SIGNER)"
    ( cd "$ROOT/contracts" && PLAYGROUND_RPC_URL="$TUN" DEMO_SIGNER="$DEMO_SIGNER" SEED_USDG="$SEED_USDG" \
        forge script script/Deploy.s.sol --rpc-url "$TUN" --chain "$CHAIN_ID" --private-key "$DEV0_KEY" --broadcast --slow )
    [ -s "$ROOT/deployments/$CHAIN_ID.json" ] || { log "deployments/$CHAIN_ID.json missing after forge script"; exit 1; }
    cp "$ROOT/deployments/$CHAIN_ID.json" "$BOOK"
    log "deployments/$CHAIN_ID.json copied to deployments/book.json"
  fi
fi

# 6. Book to the VM and into the bell volume.
if [ -s "$BOOK" ]; then
  rsync -az -e "ssh ${SSH_OPTS[*]}" "$BOOK" "debian@$VM_IP:$REMOTE/deployments/book.json"
  if [ -n "$PROFILES" ]; then
    if rsh "cd $REMOTE/infra && docker compose cp ../deployments/book.json bell:/data/book.json && docker compose restart bell >/dev/null"; then
      log "book.json copied into the bell volume, bell restarted"
    else
      log "could not copy book.json into the bell container (is bell running? docker compose logs bell)"
    fi
  fi
fi

# 7. Start the replay (admin route). Public TLS first, then through Caddy on the VM if the certificate is pending.
if [ -n "$PROFILES" ] && [ -s "$BOOK" ]; then
  body='{"action":"start","speed":60}'
  if code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X POST "https://$API_HOST/replay" \
      -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$ROOT/deploy/.admin-token")") \
      -H 'content-type: application/json' -d "$body" 2>/dev/null) && [ "${code:0:1}" = 2 ]; then
    log "replay started (HTTP $code)"
  else
    code=$(rsh "bash -s" <<EOF
T=\$(sed -n 's/^BELL_ADMIN_TOKEN=//p' $REMOTE/infra/.env)
curl -sk -o /dev/null -w '%{http_code}' --max-time 20 --resolve $API_HOST:443:127.0.0.1 -X POST https://$API_HOST/replay \
  -H @<(printf 'Authorization: Bearer %s\n' "\$T") -H 'content-type: application/json' -d '$body'
EOF
) || true
    log "replay start through the VM: HTTP ${code:-none}"
  fi
else
  log "replay not started (bell profile: ${PROFILES:-off}, book: $([ -s "$BOOK" ] && echo present || echo missing))"
fi

rsh "cd $REMOTE/infra && COMPOSE_PROFILES='$PROFILES' docker compose ps -a --format 'table {{.Service}}\t{{.Status}}'"
log "done"
