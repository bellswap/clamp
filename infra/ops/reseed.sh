#!/usr/bin/env bash
# Planned fork reseed: fresh fork with the transaction keeper, the same contracts at the same addresses,
# the catalog listed, the vault topped up to 10M USDG, bell state moved aside, bell restarted. Every step prints what it
# does and checks its result; the script stops at the first failed check. Nothing is deleted: dumps and bell state are
# moved aside with a UTC suffix.
#
#   infra/ops/reseed.sh --rig                     every step a..j on the local rig (anvil :18545, bell :18787)
#   infra/ops/reseed.sh --steps a                 VM, rollout R1 (backups, preconditions, reviewed HEAD recorded)
#   infra/ops/reseed.sh --steps b-e               VM, rollout R2 (sync and build first, then fresh fork, contracts)
#   infra/ops/reseed.sh --steps f-h               VM, rollout R3 (listing, top-up, bell state)
#   infra/ops/reseed.sh --steps i-j               VM, rollout R4 (bell up, checks; the checks fail the step)
#   --dry-run                                     print the VM commands instead of running them
#
# Steps:
#   a  preconditions and backups: clean tree, services/rpc-guard/Dockerfile present, the compose guard defaults equal
#      deployments/book.json; HEAD recorded as the reviewed HEAD (RESEED_STATE_DIR/reviewed-head); docker tag of the
#      bell image as :pre-demo; at least 6 GB free on the VM disk
#   b  tree clean and HEAD equal to the reviewed HEAD (REVIEWED_HEAD overrides the recorded one); rsync the tree
#      (deploy.sh step 1); docker compose config; build the bell and rpc-guard images while the old stack still
#      runs (a failed build stops here, nothing replaced); then docker compose stop bots bell erpc (erpc too: no
#      public transaction reaches the fresh fork before the deploy)
#   c  docker compose stop -t 180 anvil (the dump is written), move the dump to anvil.json.pre-reseed-<UTC>
#   d  docker compose up -d proxy anvil, wait for chain id 46633, dev account 0 nonce equals EXPECT_DEV0_NONCE (1834
#      at fork block 91989489, measured on the rig)
#   e  Deploy.s.sol through an SSH tunnel from a scratch copy of contracts/ (the repo's book.json is never written),
#      the four addresses must equal deployments/book.json, then docker compose up -d --no-build rpc-guard erpc
#   f  ListCatalog.s.sol with the eligible list (CATALOG_MARKETS_SRC, a coverage.json with an "eligible" array);
#      listedSymbols length must equal the eligible list plus the core markets not in it
#   g  vault top-up: USDG balance slot of dev 0 (keccak256(abi.encode(dev0, 1))) set to balance + 9,000,000 USDG,
#      approve and deposit 9,000,000 USDG from dev 0; vault totalAssets at least 10,000,000 USDG
#   h  refuse when the bell's state.json belongs to the current fork (its lastBlock hash matches the chain; a
#      re-index from deployBlock would miss everything outside the transaction keeper window; RESEED_FORCE_STATE=1
#      overrides); move state.json and charts/replay-5d-5m.json aside; copy the prefetched series
#      (REPLAY_SERIES_SRC, optional) and book.json into the bell volume
#   i  refuse to start a bell without the feed module (src/feed/index.ts in RIG_BELL_SRC or in the step b image) when
#      more than the 14 core markets are listed (the replay runs from start); docker compose --profile bell up -d
#      --no-build bell (image from step b); a running bell whose /state lacks the feed module is stopped; POST /replay
#      speed 60, paused false
#   j  checks, each one fails the step: code at each address; /state replay running and ticking; /markets has a row
#      per catalog symbol; /replay/coverage eligible all listed, listed minus eligible only core markets, tradable
#      rows equal eligible; rows per post at most RESEED_MAX_IDLE_ROWS (20); the guard rejects a dev key 0
#      transaction and a fresh key's transaction to the reference on the public RPC (VM); a cold long-tail market
#      warms, takes a ticket and settles it (RESEED_SETTLE_PROBE=0 skips the settlement wait); status.sh green
#      within a minute. On the VM the bell image then gets the :demo-good tag (the rollback target).
#
# Environment (VM): VM_IP and SSH_KEY (both required), TUNNEL_PORT (default 18645, not the rig's 18545),
# CATALOG_MARKETS_SRC, REPLAY_SERIES_SRC, EXPECT_DEV0_NONCE, BELL_URL (https://api-play.bellswap.fun),
# PUBLIC_RPC (https://rpc-play.bellswap.fun), REVIEWED_HEAD, RESEED_STATE_DIR (~/.local/state/bellswap-reseed).
# Environment (rig): RIG_DIR, RIG_ANVIL_PORT (18545), RIG_BELL_PORT (18787), RIG_PROXY_PORT (18672),
# RIG_BELL_SRC (default: services/bell of this tree), ANVIL_TX_BLOCK_KEEPER (7200),
# RIG_ALLOW_NO_FEED=1 (a bell without the feed module: the catalog and probe checks are skipped and said so).
# Probes: RESEED_PROBE_SYMBOL (default the first eligible non-core symbol), RESEED_SETTLE_WAIT_S (cap, 900).
# Secrets: the admin token is read from deploy/.admin-token (VM) or $RIG_DIR/admin-token (rig) straight into curl's
# header argument (process substitution, no file) and never printed; the dRPC key is read by the rig's proxy-up.sh.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MODE=vm; STEPS=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rig) MODE=rig ;;
    --steps) STEPS=$2; shift ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n 2,64p "$0"; exit 0 ;;
    *) echo "unknown argument $1"; exit 2 ;;
  esac
  shift
done
if [ "$MODE" = rig ] && [ -z "$STEPS" ]; then STEPS=a-j; fi
[ -n "$STEPS" ] || { echo "VM mode needs --steps (a, b-e, f-h, i-j); --rig runs a-j on the local rig"; exit 2; }
want() { # want <step>: true when the step is in STEPS (a single letter or a range like b-e)
  local s=$1 r
  IFS=, read -ra parts <<<"$STEPS"
  for r in "${parts[@]}"; do
    if [[ $r == ?-? ]]; then [[ $s > ${r:0:1} || $s == ${r:0:1} ]] && [[ $s < ${r:2:1} || $s == ${r:2:1} ]] && return 0
    elif [ "$r" = "$s" ]; then return 0; fi
  done
  return 1
}

CHAIN_ID=46633
FORK_BLOCK_EXPECTED=91989489
EXPECT_DEV0_NONCE=${EXPECT_DEV0_NONCE:-1834}
DEV0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
# anvil dev account 0 (public test key; the fork's deployer, book owner and house wallet). Never a real key.
DEV0_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEMO_SIGNER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
USDG_HOLDER=0x8366a39CC670B4001A1121B8F6A443A643e40951
SEED_USDG=1000000000000            # 1,000,000 USDG, the vault seed of Deploy.s.sol
TOPUP_USDG=9000000000000           # 9,000,000 USDG (vault at 10,000,000)
CORE="RTX NOC CPER SOXL DRAM GD MARA UUUU SPY QQQ NVDA MU SNDK TSLA"
UTC=$(date -u +%Y%m%dT%H%M%SZ)
BOOK_REPO="$ROOT/deployments/book.json"

log() { printf '[reseed %s %s] %s\n' "$(date -u +%H:%M:%S)" "$MODE" "$*"; }
step() { printf '\n[reseed %s] ===== step %s: %s\n' "$(date -u +%H:%M:%S)" "$1" "$2"; }
die() { log "FAIL: $*"; exit 1; }
ok() { log "ok: $*"; }

# ---------------------------------------------------------------- mode setup
if [ "$MODE" = rig ]; then
  RIG_DIR=${RIG_DIR:-./tmp/rig}
  APORT=${RIG_ANVIL_PORT:-18545}; BPORT=${RIG_BELL_PORT:-18787}; PPORT=${RIG_PROXY_PORT:-18672}
  RPC=http://127.0.0.1:$APORT
  BELL_URL=http://127.0.0.1:$BPORT
  WORK=$RIG_DIR/reseed
  STATE=$WORK/anvil.json
  BELL_DATA=$WORK/bell
  TOKEN_FILE=$RIG_DIR/admin-token
  KEEPER=${ANVIL_TX_BLOCK_KEEPER-7200}
  RIG_BELL_SRC=${RIG_BELL_SRC:-$ROOT/services/bell}
  mkdir -p "$WORK" "$BELL_DATA"
else
  VM_IP=${VM_IP:?set VM_IP to the playground VM address}
  KEY=${SSH_KEY:?set SSH_KEY to the SSH key file for the VM}
  REMOTE=/opt/bellswap-v2
  TUNNEL_PORT=${TUNNEL_PORT:-18645}
  RPC=http://127.0.0.1:$TUNNEL_PORT
  BELL_URL=${BELL_URL:-https://api-play.bellswap.fun}
  TOKEN_FILE=$ROOT/deploy/.admin-token
  WORK=${RESEED_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/reseed.XXXXXX")}
  SSH_OPTS=(-o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -i "$KEY")
  CTL="${TMPDIR:-/tmp}/bsw-reseed-tunnel-$$.sock"
  VOL_ANVIL=/var/lib/docker/volumes/bellswap-play_anvil-data/_data
  VOL_BELL=/var/lib/docker/volumes/bellswap-play_bell-data/_data
  # The bell's Dockerfile as deploy.sh picks it: services/bell/Dockerfile when the tree has one, else infra's.
  BELL_DF=../../infra/bell/Dockerfile
  [ -f "$ROOT/services/bell/Dockerfile" ] && BELL_DF=Dockerfile
fi
log "steps $STEPS, rpc $RPC, bell $BELL_URL, work dir $WORK"

rsh() { # VM command (printed to stderr, so a captured answer holds only the VM's output; skipped in --dry-run)
  log "vm\$ $*" >&2
  [ "$DRY" = 1 ] && return 0
  ssh "${SSH_OPTS[@]}" "debian@$VM_IP" "$@"
}
compose() { rsh "cd $REMOTE/infra && BELL_DOCKERFILE='${BELL_DF:-}' docker compose $*"; }
tunnel_up() {
  [ "$MODE" = vm ] || return 0
  [ "$DRY" = 1 ] && { log "tunnel 127.0.0.1:$TUNNEL_PORT -> VM 127.0.0.1:8545 (dry run)"; return 0; }
  if [ ! -S "$CTL" ]; then
    ssh "${SSH_OPTS[@]}" -M -S "$CTL" -f -N -o ExitOnForwardFailure=yes -L "127.0.0.1:$TUNNEL_PORT:127.0.0.1:8545" "debian@$VM_IP"
  fi
}
cleanup() { if [ "$MODE" = vm ] && [ -S "${CTL:-/nonexistent}" ]; then ssh -S "$CTL" -O exit "debian@$VM_IP" 2>/dev/null || true; fi; }
trap cleanup EXIT
wait_chain() { # wait_chain <seconds>
  local i
  for i in $(seq 1 "$1"); do [ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" = "$CHAIN_ID" ] && return 0; sleep 1; done
  return 1
}
bell_pid() { lsof -nP -iTCP:"$BPORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }
anvil_pid() { lsof -nP -iTCP:"$APORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }
auth_header() { # the admin token header on stdout, for curl -H @<(auth_header): no file, never printed
  printf 'Authorization: Bearer %s\n' "$(tr -d '\n' <"$TOKEN_FILE")"
}
listed_symbols() { # listedSymbols() of the book, one ticker per line
  cast call "$(jq -r .book "$BOOK_REPO")" 'listedSymbols()(bytes32[])' --rpc-url "$RPC" | tr -d '[] ' | tr ',' '\n' |
    grep 0x | python3 -c 'import sys
for l in sys.stdin: print(bytes.fromhex(l.strip()[2:]).rstrip(b"\0").decode())'
}
STATE_DIR=${RESEED_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/bellswap-reseed}
clean_tree() { [ -z "$(git -C "$ROOT" status --short)" ]; }
copy_contracts() { # scratch copy of contracts/ and deployments/, so forge never writes the repo's book.json
  mkdir -p "$WORK/tree"
  rsync -a --exclude out --exclude cache --exclude broadcast "$ROOT/contracts" "$ROOT/deployments" "$WORK/tree/"
}
forge_env() { echo "FOUNDRY_OUT=$WORK/forge-out FOUNDRY_CACHE_PATH=$WORK/forge-cache"; }

# ---------------------------------------------------------------- a. backups
if want a; then
  step a "backups and preconditions"
  log "git HEAD $(git -C "$ROOT" rev-parse HEAD), status lines $(git -C "$ROOT" status --short | wc -l | tr -d ' ')"
  if [ "$MODE" = rig ]; then
    free_kb=$(df -k "$RIG_DIR" | awk 'NR==2{print $4}')
    [ "$free_kb" -ge $((6 * 1024 * 1024)) ] || die "less than 6 GB free in $RIG_DIR"
    ok "$((free_kb / 1024 / 1024)) GB free; rig has no bell image to tag"
  else
    clean_tree || die "git status is not clean"
    # rpc-guard is built from services/rpc-guard; erpc's only upstream is rpc-guard:8546, so a tree
    # without it would leave the public RPC down after step e (compose config -q does not catch a missing context).
    [ -f "$ROOT/services/rpc-guard/Dockerfile" ] || die "services/rpc-guard/Dockerfile missing: merge the guard first, or set erpc.yaml's upstream to http://anvil:8545"
    [ -f "$ROOT/services/bots/Dockerfile" ] || log "note: services/bots/Dockerfile missing; the bots service cannot start"
    for k in demoSigner book vault usdg; do
      a=$(jq -r ".$k" "$BOOK_REPO")
      grep -qi -- "$a" "$ROOT/infra/docker-compose.yml" || die "infra/docker-compose.yml rpc-guard defaults lack book.json $k $a"
    done
    mkdir -p "$STATE_DIR"
    git -C "$ROOT" rev-parse HEAD >"$STATE_DIR/reviewed-head"
    log "reviewed HEAD $(cat "$STATE_DIR/reviewed-head") recorded in $STATE_DIR/reviewed-head (step b refuses any other)"
    rsh "docker image tag bellswap-play-bell:latest bellswap-play-bell:pre-demo && docker image ls bellswap-play-bell --format '{{.Tag}} {{.ID}}'"
    rsh "df -h / | tail -1; test \$(df -k / | awk 'NR==2{print \$4}') -ge $((6 * 1024 * 1024))" || die "less than 6 GB free on the VM"
    ok "bell image tagged :pre-demo, disk checked"
  fi
fi

# ---------------------------------------------------------------- b. sync, build, then stop bots, bell, erpc
if want b; then
  step b "reviewed tree synced and images built, then stop bots, bell and erpc"
  if [ "$MODE" = rig ]; then
    [ -f "$RIG_BELL_SRC/src/index.ts" ] || die "no bell source at $RIG_BELL_SRC"
    p=$(bell_pid); if [ -n "$p" ]; then kill -TERM "$p"; for _ in $(seq 1 20); do [ -z "$(bell_pid)" ] && break; sleep 1; done; fi
    [ -z "$(bell_pid)" ] || die "bell still listening on :$BPORT"
    ok "bell on :$BPORT stopped (rig has no bots or erpc)"
  else
    clean_tree || die "git status is not clean: only the reviewed tree is deployed"
    head=$(git -C "$ROOT" rev-parse HEAD)
    reviewed=${REVIEWED_HEAD:-$(cat "$STATE_DIR/reviewed-head" 2>/dev/null || true)}
    [ -n "$reviewed" ] || die "no reviewed HEAD: run step a (R1) or set REVIEWED_HEAD"
    [ "$head" = "$reviewed" ] || die "HEAD $head is not the reviewed HEAD $reviewed"
    [ -f "$ROOT/services/rpc-guard/Dockerfile" ] || die "services/rpc-guard/Dockerfile missing (see step a)"
    log "rsync $ROOT ($head) -> $VM_IP:$REMOTE (deploy.sh step 1 filters)"
    if [ "$DRY" = 0 ]; then
      rsync -az -e "ssh ${SSH_OPTS[*]}" \
        --exclude node_modules --exclude .git --exclude .trash --exclude dist --exclude 'dist-*' \
        --exclude .env --exclude '.env.local' --exclude .admin-token --exclude key --exclude '*.pem' \
        --exclude deploy/ --exclude contracts/out --exclude contracts/cache --exclude contracts/broadcast \
        --exclude deployments/local --exclude .DS_Store \
        "$ROOT/" "debian@$VM_IP:$REMOTE/"
    fi
    compose "--profile bell config -q" || die "docker compose config failed on the VM"
    # Build while the old fork and bell still run: a failed build stops the reseed with nothing replaced.
    compose "--profile bell build bell rpc-guard" || die "image build failed: nothing was stopped or replaced"
    rsh "cd $REMOTE/infra && if docker compose --profile bell config --services | grep -qx bots; then docker compose --profile bell stop bots; fi"
    compose "--profile bell stop bell erpc"
    compose "ps --format '{{.Service}} {{.State}}'"
    ok "bots, bell, erpc stopped"
  fi
fi

# ---------------------------------------------------------------- c. stop anvil, dump aside
if want c; then
  step c "stop anvil (dump written), move the dump aside"
  if [ "$MODE" = rig ]; then
    p=$(anvil_pid)
    if [ -n "$p" ]; then kill -TERM "$p"; for _ in $(seq 1 180); do kill -0 "$p" 2>/dev/null || break; sleep 1; done; fi
    [ -z "$(anvil_pid)" ] || die "anvil still listening on :$APORT"
    if [ -e "$STATE" ]; then mv "$STATE" "$STATE.pre-reseed-$UTC"; ok "dump moved to $STATE.pre-reseed-$UTC ($(stat -f %z "$STATE.pre-reseed-$UTC" 2>/dev/null) bytes)"
    else ok "no dump at $STATE (first rig reseed)"; fi
  else
    compose "stop -t 180 anvil"
    rsh "sudo ls -la $VOL_ANVIL/ && sudo mv $VOL_ANVIL/anvil.json $VOL_ANVIL/anvil.json.pre-reseed-$UTC && sudo ls -la $VOL_ANVIL/anvil.json.pre-reseed-$UTC"
    ok "dump moved to anvil.json.pre-reseed-$UTC on the volume"
  fi
fi

# ---------------------------------------------------------------- d. fresh fork
if want d; then
  step d "fresh fork with the transaction keeper, chain id and dev 0 nonce"
  if [ "$MODE" = rig ]; then
    [ -z "$(anvil_pid)" ] || die "anvil already on :$APORT (run step c first)"
    bash "$ROOT/infra/ops/rig/proxy-up.sh"
    k=${KEEPER:-none}
    bash "$ROOT/infra/ops/rig/anvil-up.sh" "$k" "$STATE" "$APORT"
  else
    # The reviewed tree was synced in step b.
    rsh "grep -q '^ANVIL_FORK_BLOCK=$FORK_BLOCK_EXPECTED\$' $REMOTE/infra/.env" || die "ANVIL_FORK_BLOCK in infra/.env on the VM is not $FORK_BLOCK_EXPECTED"
    compose "up -d proxy anvil"
    tunnel_up
  fi
  [ "$DRY" = 1 ] || wait_chain 300 || die "no chain id $CHAIN_ID at $RPC"
  if [ "$DRY" = 0 ]; then
    n=$(cast block-number --rpc-url "$RPC"); nonce=$(cast nonce "$DEV0" --rpc-url "$RPC")
    log "block $n, dev 0 nonce $nonce (expected $EXPECT_DEV0_NONCE)"
    [ "$n" -le $((FORK_BLOCK_EXPECTED + 2)) ] || die "block $n is not a fresh fork of $FORK_BLOCK_EXPECTED (was the dump moved?)"
    [ "$nonce" = "$EXPECT_DEV0_NONCE" ] || die "dev 0 nonce $nonce, expected $EXPECT_DEV0_NONCE: addresses would differ"
    ok "fresh fork at block $n, dev 0 nonce $nonce"
  fi
fi

# ---------------------------------------------------------------- e. contracts
if want e; then
  step e "Deploy.s.sol, addresses equal deployments/book.json"
  tunnel_up
  copy_contracts
  if [ "$DRY" = 0 ]; then
    bal=$(cast call "$USDG" 'balanceOf(address)(uint256)' "$DEV0" --rpc-url "$RPC" | awk '{print $1}')
    if [ "$(python3 -c "print(int($bal) >= $SEED_USDG)")" != True ]; then
      log "funding dev 0 with the vault seed from the impersonated USDG holder (fork only; not a dev 0 transaction)"
      cast rpc anvil_setBalance "$USDG_HOLDER" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
      cast rpc anvil_impersonateAccount "$USDG_HOLDER" --rpc-url "$RPC" >/dev/null
      cast send "$USDG" 'transfer(address,uint256)' "$DEV0" "$SEED_USDG" --from "$USDG_HOLDER" --unlocked --rpc-url "$RPC" >/dev/null
      cast rpc anvil_stopImpersonatingAccount "$USDG_HOLDER" --rpc-url "$RPC" >/dev/null
    fi
    ( cd "$WORK/tree/contracts" && env $(forge_env) PLAYGROUND_RPC_URL="$RPC" DEMO_SIGNER="$DEMO_SIGNER" SEED_USDG="$SEED_USDG" \
        forge script script/Deploy.s.sol --rpc-url "$RPC" --chain "$CHAIN_ID" --private-key "$DEV0_KEY" --broadcast --slow ) \
      >"$WORK/deploy.log" 2>&1 || { tail -20 "$WORK/deploy.log"; die "forge script Deploy.s.sol failed ($WORK/deploy.log)"; }
    same=1
    for k in usdg vault book demoSigner; do
      a=$(jq -r ".$k" "$BOOK_REPO" | tr 'A-F' 'a-f'); b=$(jq -r ".$k" "$WORK/tree/deployments/book.json" | tr 'A-F' 'a-f')
      if [ "$a" = "$b" ] && [ "$(cast code "$b" --rpc-url "$RPC")" != 0x ]; then log "$k $b equal, code present"; else log "$k differs: repo $a, fork $b"; same=0; fi
    done
    [ "$same" = 1 ] || die "addresses differ from deployments/book.json: stop and report; new book at $WORK/tree/deployments/book.json"
    ok "contracts at the recorded addresses"
  fi
  if [ "$MODE" = vm ]; then
    compose "up -d --no-build rpc-guard erpc" || die "rpc-guard or erpc did not start (images from step b)"
    compose "ps rpc-guard erpc --format '{{.Service}} {{.State}}'"
  fi
fi

# ---------------------------------------------------------------- f. listing
if want f; then
  step f "ListCatalog.s.sol"
  tunnel_up
  [ -d "$WORK/tree/contracts" ] || copy_contracts
  src=${CATALOG_MARKETS_SRC:-}
  if [ -z "$src" ] && [ -s "$ROOT/deployments/catalog-markets.json" ]; then src=$ROOT/deployments/catalog-markets.json; fi
  if [ -z "$src" ] && [ "$MODE" = rig ]; then
    # Rig only: no FEED prefetch yet, so the rig lists every catalog symbol except SATS (no Yahoo series).
    src=$WORK/catalog-markets.rig.json
    jq '{source: "rig placeholder: services/bell/vendor/catalog.json minus SATS", eligible: [.[] | .symbol | select(. != "SATS")]}' \
      "$ROOT/services/bell/vendor/catalog.json" >"$src"
    log "rig eligible list generated from the bell catalog: $src"
  fi
  [ -n "$src" ] && [ -s "$src" ] || die "no eligible list: set CATALOG_MARKETS_SRC to the prefetch coverage.json"
  cp "$src" "$WORK/tree/deployments/catalog-markets.json"
  eligible=$(jq '.eligible | length' "$src")
  expected=$(jq --arg core "$CORE" '[.eligible[]] + ($core | split(" ")) | unique | length' "$src")
  log "eligible $eligible, expected listedSymbols $expected (eligible plus core markets not in it)"
  if [ "$DRY" = 0 ]; then
    ( cd "$WORK/tree/contracts" && env $(forge_env) forge script script/ListCatalog.s.sol --rpc-url "$RPC" --chain "$CHAIN_ID" \
        --private-key "$DEV0_KEY" --broadcast --slow ) >"$WORK/list.log" 2>&1 \
      || { tail -20 "$WORK/list.log"; die "forge script ListCatalog.s.sol failed ($WORK/list.log)"; }
    grep -E 'eligible|listed before|added|skipped|listedSymbols' "$WORK/list.log" | sed 's/^ */  /'
    book=$(jq -r .book "$BOOK_REPO")
    listed=$(cast call "$book" 'listedSymbols()(bytes32[])' --rpc-url "$RPC" | tr -d '[]' | tr ',' '\n' | grep -c 0x)
    echo "listedSymbols length $listed"
    [ "$listed" = "$expected" ] || die "listedSymbols $listed, expected $expected"
    ok "listedSymbols $listed equals the eligible list ($eligible) plus core markets outside it ($((expected - eligible)))"
  fi
fi

# ---------------------------------------------------------------- g. vault top-up
if want g; then
  step g "vault top-up to 10,000,000 USDG"
  tunnel_up
  if [ "$DRY" = 0 ]; then
    vault=$(jq -r .vault "$BOOK_REPO")
    assets=$(cast call "$vault" 'totalAssets()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
    target=$((SEED_USDG + TOPUP_USDG))
    if [ "$(python3 -c "print(int($assets) >= $target)")" = True ]; then
      ok "vault already holds $assets raw USDG"
    else
      bal=$(cast call "$USDG" 'balanceOf(address)(uint256)' "$DEV0" --rpc-url "$RPC" | awk '{print $1}')
      slot=$(cast keccak "$(cast abi-encode 'f(address,uint256)' "$DEV0" 1)")
      newbal=$(python3 -c "print($bal + $TOPUP_USDG)")
      cast rpc anvil_setStorageAt "$USDG" "$slot" "$(cast to-uint256 "$newbal")" --rpc-url "$RPC" >/dev/null
      got=$(cast call "$USDG" 'balanceOf(address)(uint256)' "$DEV0" --rpc-url "$RPC" | awk '{print $1}')
      [ "$got" = "$newbal" ] || die "USDG slot write did not take (balance $got, wanted $newbal): slot layout differs"
      cast send "$USDG" 'approve(address,uint256)' "$vault" "$TOPUP_USDG" --private-key "$DEV0_KEY" --rpc-url "$RPC" >/dev/null
      cast send "$vault" 'deposit(uint256,address)' "$TOPUP_USDG" "$DEV0" --private-key "$DEV0_KEY" --rpc-url "$RPC" >/dev/null
      assets=$(cast call "$vault" 'totalAssets()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
      [ "$(python3 -c "print(int($assets) >= $target)")" = True ] || die "vault totalAssets $assets below $target"
      ok "vault totalAssets $assets raw USDG"
    fi
  fi
fi

# ---------------------------------------------------------------- h. bell state aside
if want h; then
  step h "bell state and recorded series aside, series and book in place"
  tunnel_up
  # Never move aside the state of the current fork: anvil keeps transactions and receipts of the last
  # ANVIL_TX_BLOCK_KEEPER blocks only, so a re-index from deployBlock would miss every older ticket.
  # A read that fails (ssh, jq, the RPC) stops the step: only a state.json that is absent, has no index, or whose
  # lastBlock is past the head or hashes differently on this chain counts as an older fork's index.
  if [ "$DRY" = 0 ]; then
    FORCE_STATE=${RESEED_FORCE_STATE:-0}
    jqf='[.lastBlock // -1, .lastHash // ""] | @tsv'
    if [ "$MODE" = rig ]; then
      if [ -e "$BELL_DATA/state.json" ]; then sb=$(jq -r "$jqf" "$BELL_DATA/state.json") || die "cannot read $BELL_DATA/state.json"
      else sb=""; fi
    else
      present=$(rsh "sudo test -e $VOL_BELL/state.json && echo yes || echo no") || die "cannot reach the VM to read state.json"
      case "$present" in
        yes) sb=$(rsh "sudo jq -r '$jqf' $VOL_BELL/state.json") || die "cannot read $VOL_BELL/state.json on the VM" ;;
        no) sb="" ;;
        *) die "cannot tell whether $VOL_BELL/state.json exists on the VM (answer: ${present:-none})" ;;
      esac
    fi
    lb=$(cut -f1 <<<"$sb"); lh=$(cut -f2 <<<"$sb")
    if [ -n "$lb" ] && [ "$lb" -ge 0 ] 2>/dev/null && [ -n "$lh" ]; then
      chead=$(cast block-number --rpc-url "$RPC" 2>/dev/null || true)
      [[ "$chead" =~ ^[0-9]+$ ]] || [ "$FORCE_STATE" = 1 ] ||
        die "cannot read the chain head at $RPC, so state.json (lastBlock $lb) cannot be told apart from this fork's index; it stays in place (RESEED_FORCE_STATE=1 overrides)"
      ch=""
      if [[ "$chead" =~ ^[0-9]+$ ]] && [ "$lb" -le "$chead" ]; then
        ch=$(cast block "$lb" -f hash --rpc-url "$RPC" 2>/dev/null || true)
        [[ "$ch" =~ ^0x[0-9a-fA-F]{64}$ ]] || [ "$FORCE_STATE" = 1 ] ||
          die "cannot read the hash of block $lb at $RPC (head $chead), so state.json cannot be told apart from this fork's index; it stays in place (RESEED_FORCE_STATE=1 overrides)"
      fi
      if [ "$ch" = "$lh" ] && [ "$FORCE_STATE" != 1 ]; then
        die "state.json lastBlock $lb matches the current fork (hash $lh): it is this fork's index, not the old one; RESEED_FORCE_STATE=1 overrides"
      fi
      log "state.json lastBlock $lb, chain head ${chead:-unknown}, hash on the current chain ${ch:-none (past the head)}: an older fork's index"
    else log "no state.json index to compare (first start)"; fi
  fi
  if [ "$MODE" = rig ]; then
    for f in state.json charts/replay-5d-5m.json; do
      if [ -e "$BELL_DATA/$f" ]; then mv "$BELL_DATA/$f" "$BELL_DATA/$f.pre-reseed-$UTC"; log "moved $f aside"; fi
    done
    mkdir -p "$BELL_DATA/charts"
    if [ -n "${REPLAY_SERIES_SRC:-}" ]; then cp "$REPLAY_SERIES_SRC" "$BELL_DATA/charts/replay-5d-5m.json"; log "series from $REPLAY_SERIES_SRC"
    elif [ -s "$RIG_DIR/charts-cache/replay-5d-5m.json" ]; then cp "$RIG_DIR/charts-cache/replay-5d-5m.json" "$BELL_DATA/charts/"; log "series from the rig cache (14 symbols; the bell fetches the rest)"; fi
    cp "$BOOK_REPO" "$BELL_DATA/book.json"
    ok "bell data dir $BELL_DATA ready"
  else
    rsh "sudo bash -c 'cd $VOL_BELL && for f in state.json charts/replay-5d-5m.json; do [ -e \"\$f\" ] && mv \"\$f\" \"\$f.pre-reseed-$UTC\" && echo moved \$f; done; ls -la . charts | head -30'"
    if [ -n "${REPLAY_SERIES_SRC:-}" ]; then
      log "copy $REPLAY_SERIES_SRC to the VM"
      [ "$DRY" = 1 ] || rsync -az -e "ssh ${SSH_OPTS[*]}" "$REPLAY_SERIES_SRC" "debian@$VM_IP:/tmp/replay-5d-5m.json"
      rsh "sudo mkdir -p $VOL_BELL/charts && sudo cp /tmp/replay-5d-5m.json $VOL_BELL/charts/replay-5d-5m.json"
    else
      log "no REPLAY_SERIES_SRC: the bell fetches the series itself on start (Yahoo, rate limits apply)"
    fi
    [ "$DRY" = 1 ] || rsync -az -e "ssh ${SSH_OPTS[*]}" "$BOOK_REPO" "debian@$VM_IP:$REMOTE/deployments/book.json"
    rsh "sudo cp $REMOTE/deployments/book.json $VOL_BELL/book.json"
    ok "bell volume prepared"
  fi
fi

# ---------------------------------------------------------------- i. bell up
if want i; then
  step i "bell up, replay start speed 60"
  tunnel_up
  # Feed guard, before the bell starts: the bell runs its replay loop from start (services/bell/src/app.ts replayPaused
  # false, first tick 1 s after start, whatever state.json holds), and a bell without the feed module
  # (src/feed/index.ts) posts every listed market every tick (rig: 512 rows per tick, dump 883 MB and anvil RSS 1.1 GB
  # after about 1,400 blocks). So the source (rig) or the built image (VM) is checked before anything starts.
  if [ "$DRY" = 0 ]; then
    nlisted=$(listed_symbols | wc -l | tr -d ' ') || die "cannot read listedSymbols from the book at $RPC"
    [[ "$nlisted" =~ ^[0-9]+$ ]] && [ "$nlisted" -gt 0 ] || die "listedSymbols of the book at $RPC is empty"
    if [ "$MODE" = rig ]; then
      if [ -f "$RIG_BELL_SRC/src/feed/index.ts" ]; then srcfeed=true; else srcfeed=false; fi
    else
      srcfeed=$(rsh "if ! docker image inspect bellswap-play-bell:latest >/dev/null 2>&1; then echo noimage; elif docker run --rm --entrypoint test bellswap-play-bell:latest -f /app/src/feed/index.ts; then echo true; else echo false; fi") ||
        die "cannot inspect the bell image on the VM"
      [ "$srcfeed" != noimage ] || die "no bellswap-play-bell:latest image on the VM (step b builds it)"
    fi
    if [ "$srcfeed" != true ] && [ "$nlisted" -gt 14 ]; then
      if [ "$MODE" = vm ]; then
        die "the bell image has no feed module (src/feed/index.ts) and $nlisted markets are listed: it would post $nlisted rows from its first tick; the bell was not started (deploy the reviewed feed build, then step i again)"
      fi
      if [ "${RIG_ALLOW_NO_FEED:-0}" != 1 ]; then
        die "rig bell at $RIG_BELL_SRC has no feed module (src/feed/index.ts) and $nlisted markets are listed; not started. Set RIG_BELL_SRC to a bell with src/feed, or RIG_ALLOW_NO_FEED=1"
      fi
      log "rig bell has no feed module ($RIG_BELL_SRC, RIG_ALLOW_NO_FEED=1): it is stopped after step j (it posts $nlisted rows per tick)"
      STOP_RIG_BELL=1
    fi
  fi
  if [ "$MODE" = rig ]; then
    [ -z "$(bell_pid)" ] || die "a bell already listens on :$BPORT"
    RIG_BOOK="$BOOK_REPO" bash "$ROOT/infra/ops/rig/bell-up.sh" "$BELL_DATA" 60 "$BPORT" "$APORT" "$RIG_BELL_SRC"
  else
    compose "--profile bell up -d --no-build bell" || die "bell did not start (image from step b)"
  fi
  if [ "$DRY" = 0 ]; then
    for _ in $(seq 1 90); do curl -sf --max-time 5 "$BELL_URL/state" >/dev/null && break; sleep 2; done
    # Backstop for the check above: the running bell must report its feed module on /state too.
    hasfeed=$(curl -sf --max-time 10 "$BELL_URL/state" | jq -r 'has("feed")' 2>/dev/null || echo false)
    if [ "$hasfeed" != true ] && [ "$nlisted" -gt 14 ] && [ "${STOP_RIG_BELL:-0}" != 1 ]; then
      if [ "$MODE" = vm ]; then compose "--profile bell stop bell"; else p=$(bell_pid); [ -n "$p" ] && kill -TERM "$p"; fi
      die "the bell source has src/feed/index.ts but /state reports no feed module, and $nlisted markets are listed; bell stopped"
    fi
    resp=$(curl -s -w '\n%{http_code}' --max-time 20 -X POST "$BELL_URL/replay" -H @<(auth_header) \
      -H 'content-type: application/json' -d '{"speed":60,"paused":false}')
    code=$(tail -1 <<<"$resp")
    [ "${code:0:1}" = 2 ] || die "POST /replay answered HTTP $code"
    [ "$(sed '$d' <<<"$resp" | jq -r '.paused')" = false ] || die "POST /replay left the replay paused: $(sed '$d' <<<"$resp" | head -c 200)"
    ok "replay running at speed 60, not paused (HTTP $code), bell source ${RIG_BELL_SRC:-VM image}"
  fi
fi

# ---------------------------------------------------------------- j. checks
if want j; then
  step j "checks (each one fails the step)"
  tunnel_up
  if [ "$DRY" = 0 ]; then
    for k in usdg vault book demoSigner; do
      a=$(jq -r ".$k" "$BOOK_REPO"); c=$(cast code "$a" --rpc-url "$RPC")
      [ "$c" != 0x ] || die "no code at $k $a"; log "$k $a code $(( (${#c} - 2) / 2 )) bytes"
    done
    book=$(jq -r .book "$BOOK_REPO")
    listed_symbols | sort >"$WORK/listed.txt"
    listed=$(wc -l <"$WORK/listed.txt" | tr -d ' ')
    echo "listedSymbols length $listed"
    sleep 5
    st=$(curl -sf --max-time 10 "$BELL_URL/state") || die "bell /state does not answer"
    hasfeed=$(jq -r 'has("feed")' <<<"$st")
    running=$(jq -r '.replay.running' <<<"$st")
    age=$(jq -r --arg now "$(date +%s)000" 'if has("feed") then .feed.lastTickAt else .replay.lastTick.at end // 0 | if . == 0 then 999999 else ((($now|tonumber) - .) / 1000 | floor) end' <<<"$st")
    log "bell: feed $hasfeed, replay running $running, last tick ${age}s ago, block $(jq -r .block <<<"$st"), indexed $(jq -r .indexedBlock <<<"$st"), markets $(jq -r .counts.markets <<<"$st")"
    [ "$running" = true ] || die "replay not running"
    [ "$age" -le 30 ] || die "last tick ${age}s ago"
    catalog=$(jq length "$ROOT/services/bell/vendor/catalog.json")
    skip_feed=0
    if [ "$hasfeed" != true ]; then
      [ "$MODE" = rig ] && [ "${RIG_ALLOW_NO_FEED:-0}" = 1 ] || die "the bell has no feed module: /markets, /replay/coverage and the probes cannot be checked"
      skip_feed=1
      log "SKIPPED (RIG_ALLOW_NO_FEED=1, bell without the feed module): /markets, /replay/coverage, rows per post, cold-market probe"
    fi
    if [ "$skip_feed" = 0 ]; then
      m=$(curl -sf --max-time 20 "$BELL_URL/markets") && jq -e '.markets | type == "array"' >/dev/null <<<"$m" || die "/markets does not answer with a markets array"
      rows=$(jq '.markets | length' <<<"$m"); tradable=$(jq '[.markets[] | select(.tradable)] | length' <<<"$m")
      log "/markets rows $rows (catalog $catalog), tradable $tradable"
      [ "$rows" = "$catalog" ] || die "/markets has $rows rows, the catalog $catalog"
      cv=$(curl -sf --max-time 20 "$BELL_URL/replay/coverage") && jq -e '.eligible | type == "array"' >/dev/null <<<"$cv" || die "/replay/coverage does not answer with an eligible array"
      jq -r '.eligible[]' <<<"$cv" | sort -u >"$WORK/eligible.txt"
      ce=$(wc -l <"$WORK/eligible.txt" | tr -d ' ')
      unlisted=$(comm -23 "$WORK/eligible.txt" "$WORK/listed.txt" | tr '\n' ' ')
      extra=$(comm -13 "$WORK/eligible.txt" "$WORK/listed.txt" | tr '\n' ' ')
      extra_noncore=$(for x in $extra; do case " $CORE " in *" $x "*) ;; *) printf '%s ' "$x" ;; esac; done)
      log "/replay/coverage eligible $ce, listedSymbols $listed; listed but not eligible: ${extra:-none}"
      [ -z "$unlisted" ] || die "eligible but not listed: $unlisted"
      [ -z "$extra_noncore" ] || die "listed but not eligible and not core: $extra_noncore"
      [ "$tradable" = "$ce" ] || die "tradable rows $tradable, coverage eligible $ce"
      rpp=$(jq -r '.feed.rowsLastPost // empty' <<<"$st")
      [ -n "$rpp" ] && [ "$rpp" -le "${RESEED_MAX_IDLE_ROWS:-20}" ] || die "rows per post ${rpp:-unknown}, at most ${RESEED_MAX_IDLE_ROWS:-20} at idle"
      ok "catalog: $rows rows, $ce eligible all listed, $tradable tradable, $rpp rows per post"
    fi
    if [ "$MODE" = vm ]; then
      # The guard on the public RPC: a dev key 0 transaction and a fresh key's post to the reference must both be
      # rejected by rpc-guard (-32003, "playground guard"). Signed here, sent raw; neither can change state.
      pub=${PUBLIC_RPC:-https://rpc-play.bellswap.fun}
      ref=$(jq -r .demoSigner "$BOOK_REPO")
      fresh=$(cast wallet new --json | jq -r '.[0].private_key')
      for probe in "dev0:$DEV0_KEY:$DEV0" "ref:$fresh:$ref"; do
        name=${probe%%:*}; rest=${probe#*:}; pk=${rest%%:*}; to=${rest#*:}
        raw=$(cast mktx --legacy --private-key "$pk" --chain "$CHAIN_ID" --nonce 0 --gas-limit 100000 --gas-price 1000000000 "$to" --rpc-url "$pub" 2>"$WORK/mktx.err") ||
          die "guard probe $name: could not sign ($(head -c 200 "$WORK/mktx.err"))"
        out=$(cast publish --rpc-url "$pub" "$raw" 2>&1 || true)
        grep -qi 'playground guard' <<<"$out" || die "guard probe $name: not rejected by rpc-guard: $(head -c 200 <<<"$out")"
        log "guard probe $name rejected: $(grep -oi 'rejected by the playground guard[^"]*' <<<"$out" | head -1)"
      done
      ok "rpc-guard rejects dev key 0 and transactions to the reference"
    else log "guard probes: the rig has no rpc-guard (VM only)"; fi
    if [ "$skip_feed" = 0 ]; then
      # Cold long-tail market: warm it, wait for its first fresh round, open a ticket, watch it settle.
      sym=${RESEED_PROBE_SYMBOL:-$(comm -12 "$WORK/eligible.txt" "$WORK/listed.txt" | while read -r x; do case " $CORE " in *" $x "*) ;; *) echo "$x"; break ;; esac; done || true)}
      [ -n "$sym" ] || die "no long-tail symbol to probe"
      wc=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$BELL_URL/warm/$sym" -H 'content-type: application/json' -d '{"ttl":120}')
      [ "${wc:0:1}" = 2 ] || die "POST /warm/$sym answered HTTP $wc"
      fresh=false
      for _ in $(seq 1 60); do
        mk=$(curl -sf --max-time 10 "$BELL_URL/markets/$sym" || true)
        if [ -n "$mk" ]; then fresh=$(jq -r '.fresh // false' <<<"$mk" 2>/dev/null || echo false); fi
        [ "$fresh" = true ] && break; sleep 2
      done
      [ "$fresh" = true ] || die "cold market $sym did not get a fresh round within 120 s of POST /warm"
      line=$(bash "$ROOT/infra/ops/rig/open-ticket.sh" "$RPC" "$book" "$sym" 0 5000000 2 | tail -1) || die "ticket open on $sym failed: $line"
      tid=$(awk '{print $2}' <<<"$line")
      [ -n "$tid" ] || die "ticket open on $sym: no id ($line)"
      log "probe ticket $tid on $sym opened ($line)"
      if [ "${RESEED_SETTLE_PROBE:-1}" = 1 ]; then
        eta=$(jq -r '.etaWall.session // empty' <<<"$mk" | awk '{printf "%d", $1}')
        wait_s=$(( ${eta:-840} + 60 )); cap=${RESEED_SETTLE_WAIT_S:-900}; [ "$wait_s" -le "$cap" ] || wait_s=$cap
        log "waiting up to ${wait_s}s for ticket $tid to settle (session ETA ${eta:-unknown} s)"
        t0=$(date +%s); status=open
        while [ $(( $(date +%s) - t0 )) -lt "$wait_s" ]; do
          status=$(curl -sf --max-time 10 "$BELL_URL/tickets/$tid" | jq -r '.ticket.status // "unknown"' 2>/dev/null || echo unknown)
          [ "$status" = settled ] && break; sleep 5
        done
        [ "$status" = settled ] || die "probe ticket $tid on $sym not settled after ${wait_s}s (status $status)"
        ok "cold market $sym: fresh round after warm, ticket $tid opened and settled in $(( $(date +%s) - t0 )) s"
      else log "settlement probe skipped (RESEED_SETTLE_PROBE=0): ticket $tid stays open"; fi
    fi
    green=0
    for i in $(seq 1 6); do
      if [ "$MODE" = rig ]; then
        out=$(STATUS_DUMP_OPTIONAL=1 ANVIL_PORT="$APORT" BELL_URL="$BELL_URL" RIG_DIR="$RIG_DIR" bash "$ROOT/infra/ops/status.sh" --rig) && green=1
      else
        out=$(STATUS_DUMP_OPTIONAL=1 BELL_URL="$BELL_URL" bash "$ROOT/infra/ops/status.sh") && green=1
      fi
      echo "$out"
      [ "$green" = 1 ] && break
      log "status.sh not green (try $i of 6), again in 10 s"; sleep 10
    done
    [ "$green" = 1 ] || die "status.sh not green after 6 tries"
    if [ "$MODE" = vm ]; then
      rsh "docker image tag bellswap-play-bell:latest bellswap-play-bell:demo-good && docker image ls bellswap-play-bell --format '{{.Tag}} {{.ID}}'"
      log "bell image tagged :demo-good (rollback target)"
    fi
    if [ "$skip_feed" = 1 ]; then ok "checks passed WITHOUT the catalog checks and probes (bell without the feed module)"
    else ok "checks passed"; fi
  fi
  if [ "${STOP_RIG_BELL:-0}" = 1 ]; then
    p=$(bell_pid); [ -n "$p" ] && kill -TERM "$p"
    log "rig bell without the feed module stopped (RIG_BELL_SRC=<services/bell with src/feed> keeps it running)"
  fi
fi
log "done: steps $STEPS"
