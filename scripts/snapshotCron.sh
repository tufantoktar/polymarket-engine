#!/usr/bin/env bash
# Daily price-history capture.
#
# cron has no nvm on PATH and node's absence would be silent, so every
# nvm bin is prepended and the exit code is recorded. The same omission
# made the collector watchdog log successes it never achieved.
set -uo pipefail
for d in /root/.nvm/versions/node/*/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH
cd /root/polymarket-engine || exit 1
LOG=data/pricehistory/cron.log
if node scripts/snapshotPriceHistory.js --days=10 >> "$LOG" 2>&1; then
  echo "$(date -Is) OK" >> "$LOG"
else
  echo "$(date -Is) FAILED rc=$?" >> "$LOG"
fi
