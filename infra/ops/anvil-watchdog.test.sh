#!/usr/bin/env bash
# shellcheck disable=SC2329 # the fakes are invoked by the watchdog through export -f
# Dry-run tests for anvil-watchdog.sh with fake docker, sudo and flock (exported functions survive the script's PATH
# reset; no docker or VM needed). A stopped anvil reads "0B / 0B" in docker stats and State.Running false in docker
# inspect: the watchdog must log one NOREAD line, exit 2 and never call docker compose, also when the dump rule and
# the cooldown would allow a restart. The last case checks that the fakes drive a real restart decision.
#
#   infra/ops/anvil-watchdog.test.sh   prints one line per case; exit 0 when all pass
set -uo pipefail
WD="$(cd "$(dirname "$0")" && pwd)/anvil-watchdog.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/anvil-watchdog-test.XXXXXX")

docker() {
  case "$1" in
    stats) [ -n "${FAKE_STATS:-}" ] && echo "$FAKE_STATS" ;;
    inspect) [ -n "${FAKE_RUNNING:-}" ] && echo "$FAKE_RUNNING" ;;
    exec) echo "${FAKE_DUMP_BYTES:-1000000}" ;;
    compose) echo "compose $*" >>"$FAKE_CALLS" ;;
  esac
  return 0
}
sudo() { return 1; }
flock() { return 0; }
export -f docker sudo flock

fail=0
# case <name> <want exit> <want log tag> <stats> <running> <dump bytes> [watchdog args]
case_() {
  local name=$1 want_rc=$2 want_tag=$3 dir="$TMP/$1" rc lines calls
  mkdir -p "$dir"
  FAKE_STATS=$4 FAKE_RUNNING=$5 FAKE_DUMP_BYTES=$6 FAKE_CALLS="$dir/calls" HOME="$dir" \
    ANVIL_WATCHDOG_LOG="$dir/log" ANVIL_WATCHDOG_STATE="$dir/last" ANVIL_WATCHDOG_COOLDOWN_S=0 \
    bash "$WD" "${@:7}" >/dev/null 2>&1
  rc=$?
  lines=$(wc -l <"$dir/log" | tr -d ' ')
  calls=$(cat "$dir/calls" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$rc" = "$want_rc" ] && [ "$lines" = 1 ] && grep -q " $want_tag " "$dir/log" && [ "$calls" = 0 ]; then
    echo "PASS $name rc=$rc compose_calls=$calls | $(cat "$dir/log")"
  else
    echo "FAIL $name rc=$rc (want $want_rc) log_lines=$lines compose_calls=$calls | $(cat "$dir/log" 2>/dev/null)"
    fail=1
  fi
}

case_ stopped-dry-run       2 NOREAD  "0B / 0B"            false ""         --dry-run
case_ stopped-dump-over     2 NOREAD  "0B / 0B"            false 4000000000
case_ not-running-with-mem  2 NOREAD  "964.9MiB / 14.55GiB" false 4000000000
case_ running-zero-mem      2 NOREAD  "0B / 0B"            true  4000000000
case_ no-container          2 NOREAD  ""                   ""    ""         --dry-run
case_ running-over-dry-run  0 DRY-RUN "9500MiB / 14.55GiB" true  1000000    --dry-run
exit "$fail"
