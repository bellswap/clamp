# Infrastructure

The playground runs on one Debian 12 VM with Docker. The VM, DNS and hosting details are kept in a private ops doc.

## Public endpoints

| URL | What |
| --- | --- |
| https://rpc-play.bellswap.fun | eRPC, chain id 46633 (JSON-RPC at the root path; also /play/evm/46633) |
| https://api-play.bellswap.fun | bell v2 service |
| https://play.bellswap.fun | the app (Pages project bellswap-play) |
| https://v2.bellswap.fun | the landing (Pages project bellswap-v2-landing) |

## Services ([docker-compose.yml](docker-compose.yml), compose project bellswap-play)

| Service | What | Reached by |
| --- | --- | --- |
| proxy | python:3.12-slim running fork/upstream-proxy.py 8672 with PROXY_UPSTREAM=$ANVIL_UPSTREAM (keyed dRPC URL from infra/.env, passed as an environment variable, logged as scheme and host only; retries drpc's "Unknown state" answers) | anvil |
| anvil | ghcr.io/foundry-rs/foundry:v1.7.1, anvil/entrypoint.sh: fork of Robinhood Chain at ANVIL_FORK_BLOCK through the proxy, chain id 46633, cancun, state /data/anvil.json every 600 s (ANVIL_STATE_INTERVAL) on the anvil-data volume, restart loop, SIGTERM writes the dump | erpc, bell; the VM's 127.0.0.1:8545 for the deploy tunnel |
| erpc | ghcr.io/erpc/erpc:0.3.0 (pinned digest), erpc/erpc.yaml: the demo's public method allowlist (signed transactions only; anvil_*, evm_*, eth_sendTransaction, eth_sign*, eth_accounts, debug_* answer -32016), per-IP budgets, CORS for play.bellswap.fun, bellswap-play.pages.dev and its previews, localhost:5173 | caddy |
| bell | services/bell (its Dockerfile when present, else bell/Dockerfile here), env from infra/.env: BELL_RPC_URL http://anvil:8545, BELL_SIGNER_KEY anvil dev key 1, BELL_ADMIN_TOKEN, book at /data/book.json on the bell-data volume; compose profile "bell" | caddy |
| caddy | caddy:2, caddy/Caddyfile: Let's Encrypt for rpc-play and api-play; the only service with public ports (80, 443) | the internet |

## Deploy

`infra/deploy.sh` from a workstation (idempotent; VM_IP and SSH_KEY are required; header comment lists the switches SKIP_CONTRACTS, FORCE_CONTRACTS,
BELL=0, VM_IP, SSH_KEY, TUNNEL_PORT):

1. rsync the repo to /opt/bellswap-v2 (no node_modules, .git, .trash, dist, secrets, deploy/, forge output; no
   --delete).
2. First run: infra/.env on the VM from .env.example with a fresh admin token (openssl rand -hex 24); the token is
   copied to deploy/.admin-token (mode 600, gitignored) and never printed.
3. `docker compose up -d --build` (bell profile when services/bell/src/index.ts exists).
4. Wait for anvil (chain id 46633) and for eRPC behind Caddy.
5. SSH tunnel 127.0.0.1:18545 to the VM's anvil; when deployments/book.json does not point at live contracts:
   fund anvil dev account 0 with the vault seed from the impersonated USDG holder (fork only), then
   `forge script script/Deploy.s.sol` with dev key 0, chain 46633, DEMO_SIGNER = dev account 1.
6. deployments/46633.json to deployments/book.json, to the VM, into the bell volume; bell restarted.
7. POST https://api-play.bellswap.fun/replay with the admin token (fallback through Caddy on the VM).

After a contracts change, run `FORCE_CONTRACTS=1 infra/deploy.sh` (the book check only asks whether the recorded
vault, book and reference have code on the fork).

## Rotate the fork upstream

The proxy forwards to ANVIL_UPSTREAM from /opt/bellswap-v2/infra/.env on the VM (a keyed dRPC URL since 2026-10-18).
To change it without printing it:

1. On the VM: `cd /opt/bellswap-v2/infra && cp -p .env .env.bak-$(date +%H%M%S)`, then edit .env (mode 600) and replace
   the ANVIL_UPSTREAM value in place (an editor, or a script that reads the new URL from stdin). Do not use `cat`,
   `echo` or `docker compose config`, which print it.
2. `docker compose up -d proxy` (recreates the proxy with the new value; anvil keeps its state and its fork). The
   proxy logs the upstream as scheme and host only, and gets it as the environment variable PROXY_UPSTREAM (not on
   its command line, so `ps` does not show it). `docker inspect` and `docker compose config` still show the
   environment; do not run them on the proxy.
3. Check: `curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545`
   must answer 0xb629 (46633).

The key is kept outside the repo; the local rig reads it from DRPC_KEY (infra/ops/rig/proxy-up.sh).

## Reset the fork

1. On the VM: `cd /opt/bellswap-v2/infra && docker compose stop anvil`.
2. Move the dump aside on the volume (never delete):
   `sudo mv /var/lib/docker/volumes/bellswap-play_anvil-data/_data/anvil.json /var/lib/docker/volumes/bellswap-play_anvil-data/_data/anvil.json.<date>`.
3. Optional: set ANVIL_FORK_BLOCK in /opt/bellswap-v2/infra/.env to a recent block (`cast block-number --rpc-url
   https://robinhood.drpc.org` minus 20); a recent block keeps drpc's pruned nodes answering.
4. From the workstation: `FORCE_CONTRACTS=1 infra/deploy.sh`, then rebuild and deploy the site (check the book addresses; a replay of the deployer nonces can give the same ones).

anvil runs with `--prune-history 8` (ANVIL_PRUNE_HISTORY): no block state history on disk. Without it, every mined
block's full state went to /root/.foundry/anvil/tmp in the container layer and filled the 23 GB disk on 2026-10-18.
Watch the disk with `df -h /` on the VM.

Self-heal: before each start, infra/anvil/entrypoint.sh moves a dump whose last non-blank byte is not `}` (and, after any anvil exit whose stderr holds clap's `--state` parse error, the dump it failed on; a plain exit 2 from a bad flag or .env value leaves the dump alone) to `/data/anvil.json.corrupt-<UTC time>` and starts a fresh fork; then run step 4 (on 2026-10-22 the redeploy gave the same addresses because the deployer nonces replay).
The dump interval is 600 s (ANVIL_STATE_INTERVAL, compose and entrypoint): a 2.5 GB dump every 60 s got anvil OOM-killed 261 times on 2026-10-20 and the last kill truncated the dump; move `corrupt-*` and `*.bak` files off the volume when the disk runs low.

## Files

- fork/upstream-proxy.py: taken from the first Bellswap demo; the listen host is PROXY_HOST (default 127.0.0.1, 0.0.0.0 in the compose network).
- .env.example: the template of the VM's infra/.env (fork block 91940072, signer key of anvil dev account 1).

Secrets (hosting API key, DNS token, bell admin token, SSH key) are read from their files at run time and never
printed or committed; .gitignore covers .env, .env.*, .admin-token, *.pem and key (infra/.env.example is added
with `git add -f`).
