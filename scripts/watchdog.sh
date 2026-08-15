#!/usr/bin/env bash
# Collector watchdog.
#
# pm2 gives up after 16 unstable restarts and stops for good. Nothing
# else is watching, so a silent stop costs days of data before anyone
# notices. File freshness is the ground truth: if new rows are landing,
# the collector is healthy regardless of what pm2 reports.
#
# The collector is read-only and places no orders, so an automatic
# restart is safe.
#
# cron runs with a bare environment. bash supplies a default PATH that
# covers coreutils but NOT nvm, so pm2 -- whose shebang is `env node` --
# fails with "node: No such file or directory". Every nvm bin directory
# is prepended below, and the restart's exit code is checked, because a
# watchdog that logs success it did not achieve is worse than none.
set -uo pipefail
for d in /root/.nvm/versions/node/*/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH

DIR=/root/polymarket-engine/data/recordings
LOG=/root/polymarket-engine/data/watchdog.log
COOLDOWN=/tmp/.watchdog_last_restart
STALE_MIN=${STALE_MIN:-90}

log() { echo "$(date -Is) $*" >> "$LOG"; }

now=$(date +%s)
newest=$(ls -t "$DIR"/*.ndjson 2>/dev/null | head -1)

if [ -z "$newest" ]; then
  log "STALE reason=no-files"
else
  age=$(( (now - $(stat -c %Y "$newest")) / 60 ))
  [ "$age" -le "$STALE_MIN" ] && exit 0
  log "STALE age=${age}min file=$(basename "$newest")"
fi

if ! command -v pm2 >/dev/null 2>&1; then
  log "CANNOT RESTART: pm2 not on PATH"; exit 1
fi

# At most one restart per hour, so a genuinely broken collector is not
# hammered into a loop that hides the real fault.
last=0; [ -f "$COOLDOWN" ] && last=$(cat "$COOLDOWN")
if [ $(( now - last )) -lt 3600 ]; then
  log "restart suppressed (cooldown)"; exit 0
fi
echo "$now" > "$COOLDOWN"

if pm2 restart polymarket-collect >> "$LOG" 2>&1; then
  log "restart OK"
else
  log "restart FAILED rc=$?"
fi
