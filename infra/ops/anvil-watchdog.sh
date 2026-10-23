#!/usr/bin/env bash
# Anvil memory watchdog for the playground VM. Runs as debian every 5 minutes
# from the systemd timer anvil-watchdog.timer (the VM has no cron). Reads the anvil container's memory (docker stats)
# and the size of its dump (/data/anvil.json on the anvil volume). Memory over ANVIL_WATCHDOG_MEM_MB or the dump over
# ANVIL_WATCHDOG_DUMP_MB: a graceful `docker compose restart -t 180 anvil` (anvil writes its dump on SIGTERM; the
# entrypoint restores the clock on start). Otherwise one log line (WARN when memory is over ANVIL_WATCHDOG_WARN_MB).
#
#   infra/ops/anvil-watchdog.sh             check; restart when a limit is crossed
#   infra/ops/anvil-watchdog.sh --dry-run   check and log the decision; never restart
#
# Units as in status.sh: memory in MiB (docker's MemUsage), dump in MB (1e6 bytes).
# No reading (memory empty or 0 MiB, or State.Running not true: anvil stopped, docker down): NOREAD, exit 2, no restart.
# Cooldown: no second restart within ANVIL_WATCHDOG_COOLDOWN_S (3600) of the last one. A dump over the limit does not
# shrink on a restart, so without the cooldown the dump rule would restart anvil on every run.
# Exit 0 ok, WARN or restarted; 1 limit crossed but no restart (cooldown) or the restart failed; 2 no reading.
# Env: ANVIL_WATCHDOG_MEM_MB (9000), ANVIL_WATCHDOG_DUMP_MB (3000), ANVIL_WATCHDOG_WARN_MB (6000),
# ANVIL_WATCHDOG_COOLDOWN_S (3600), ANVIL_WATCHDOG_LOG (/var/log/anvil-watchdog.log, else $HOME/anvil-watchdog.log
# when that is not writable), ANVIL_WATCHDOG_STATE (last restart, epoch seconds), ANVIL_WATCHDOG_COMPOSE,
# ANVIL_CONTAINER, ANVIL_DUMP.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n 2,21p "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 64 ;;
  esac
done

MEM_MAX=${ANVIL_WATCHDOG_MEM_MB:-9000}
DUMP_MAX=${ANVIL_WATCHDOG_DUMP_MB:-3000}
WARN_MB=${ANVIL_WATCHDOG_WARN_MB:-6000}
COOLDOWN=${ANVIL_WATCHDOG_COOLDOWN_S:-3600}
HOME_DIR=${HOME:-/home/debian}
LOG=${ANVIL_WATCHDOG_LOG:-/var/log/anvil-watchdog.log}
STATE=${ANVIL_WATCHDOG_STATE:-$HOME_DIR/.anvil-watchdog.last-restart}
COMPOSE=${ANVIL_WATCHDOG_COMPOSE:-/opt/bellswap-v2/infra/docker-compose.yml}
CTR=${ANVIL_CONTAINER:-bellswap-play-anvil-1}
DUMP=${ANVIL_DUMP:-/var/lib/docker/volumes/bellswap-play_anvil-data/_data/anvil.json}

if ! { [ -e "$LOG" ] && [ -w "$LOG" ]; } && ! { [ ! -e "$LOG" ] && [ -w "$(dirname "$LOG")" ]; }; then
  LOG=$HOME_DIR/anvil-watchdog.log
fi
log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) anvil-watchdog$([ "$DRY" = 1 ] && echo ' dry-run') $*"
  echo "$line"
  echo "$line" >>"$LOG"
}

# One run at a time (a restart plus the health wait can outlast the 5-minute period when run by hand).
exec 9>"$HOME_DIR/.anvil-watchdog.lock"
if ! flock -n 9; then
  log "SKIP another run holds the lock"
  exit 0
fi

mem_mb() { # MemUsage "964.9MiB / 14.55GiB" -> 964 (MiB); empty when docker stats gives nothing usable
  docker stats --no-stream --format '{{.MemUsage}}' "$CTR" 2>/dev/null | head -1 | awk '{
    s = $1; n = s; sub(/[A-Za-z]+$/, "", n); u = substr(s, length(n) + 1)
    f["B"] = 1 / 1048576; f["KiB"] = 1 / 1024; f["MiB"] = 1; f["GiB"] = 1024; f["TiB"] = 1048576
    f["kB"] = 1e3 / 1048576; f["MB"] = 1e6 / 1048576; f["GB"] = 1e9 / 1048576; f["TB"] = 1e12 / 1048576
    if (n == "" || !(u in f)) exit
    printf "%d\n", n * f[u]
  }'
}
dump_mb() { # bytes of the dump / 1e6; host path first (sudo -n stat, as status.sh), else inside the container
  local b
  b=$(sudo -n stat -c %s "$DUMP" 2>/dev/null || docker exec "$CTR" stat -c %s /data/anvil.json 2>/dev/null || true)
  [[ "$b" =~ ^[0-9]+$ ]] && echo $((b / 1000000))
}

mem=$(mem_mb)
dump=$(dump_mb)
running=$(docker inspect -f '{{.State.Running}}' "$CTR" 2>/dev/null | head -1)
figs="mem_mb=${mem:-None} dump_mb=${dump:-None} limits=mem:${MEM_MAX},dump:${DUMP_MAX},warn:${WARN_MB}"
# A stopped container reads "0B / 0B" in docker stats (0 MiB), so 0 and State.Running != true count as no reading.
if [ "$running" != true ] || ! [[ "$mem" =~ ^[0-9]+$ ]] || [ "$mem" -eq 0 ]; then
  log "NOREAD $figs running=${running:-None} action=none (no live memory reading for $CTR; a stopped anvil is never restarted here)"
  exit 2
fi

reason=""
[ "$mem" -gt "$MEM_MAX" ] && reason="mem>${MEM_MAX}"
if [[ "$dump" =~ ^[0-9]+$ ]] && [ "$dump" -gt "$DUMP_MAX" ]; then reason="${reason:+$reason,}dump>${DUMP_MAX}"; fi

if [ -z "$reason" ]; then
  if [ "$mem" -gt "$WARN_MB" ]; then
    log "WARN $figs action=none (memory over ${WARN_MB}: halve the bot rate, reseed in a quiet window)"
  else
    log "OK $figs action=none"
  fi
  exit 0
fi

now=$(date +%s)
last=$(cat "$STATE" 2>/dev/null || echo 0)
[[ "$last" =~ ^[0-9]+$ ]] || last=0
if [ $((now - last)) -lt "$COOLDOWN" ]; then
  log "ALERT $figs reason=$reason action=none (cooldown: last restart $((now - last)) s ago, window ${COOLDOWN} s)"
  exit 1
fi
if [ "$DRY" = 1 ]; then
  log "DRY-RUN $figs reason=$reason action=would-restart"
  exit 0
fi

log "RESTART $figs reason=$reason action=docker compose restart -t 180 anvil"
echo "$now" >"$STATE"
docker compose -f "$COMPOSE" restart -t 180 anvil >>"$LOG" 2>&1
rc=$?
health=""
for _ in $(seq 1 30); do # up to 300 s for the healthcheck (dump load plus clock restore)
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CTR" 2>/dev/null)
  [ "$health" = healthy ] && break
  sleep 10
done
after=$(mem_mb)
log "RESTARTED rc=$rc health=${health:-None} mem_mb_after=${after:-None} (check clock_ok with status.sh)"
[ "$rc" = 0 ] && [ "$health" = healthy ] && exit 0
exit 1
