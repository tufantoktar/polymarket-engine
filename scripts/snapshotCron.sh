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
  echo "$(date -Is) capture OK" >> "$LOG"
else
  echo "$(date -Is) capture FAILED rc=$?" >> "$LOG"
fi

# Push the archive offsite. This data cannot be refetched, so one disk
# holding the only copy is the entire risk. "Nothing to commit" is the
# normal case on a quiet day and must not be reported as a failure.
ABSLOG="$PWD/$LOG"
cd data/pricehistory || exit 1
git add -A
if git diff --cached --quiet; then
  echo "$(date -Is) backup: no change" >> "$ABSLOG"
elif git commit -q -m "archive: $(date -I) capture" && git push -q origin main; then
  echo "$(date -Is) backup OK" >> "$ABSLOG"
else
  echo "$(date -Is) backup FAILED rc=$?" >> "$ABSLOG"
fi
