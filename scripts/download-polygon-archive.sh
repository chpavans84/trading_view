#!/usr/bin/env bash
# Full Polygon flat-files archive sync to /Volumes/Archive
# Pavan, 2026-06-02: "we should never be blind again for back testing"
# Scope: all us_stocks_sip streams + us_indices/minute_aggs, 10-year window.
# Each stream runs in its own background rclone process; logs per-stream.

set -uo pipefail

DEST_ROOT="/Volumes/Archive/polygon-flatfiles"
LOG_DIR="$DEST_ROOT/logs"
mkdir -p "$LOG_DIR"

YEARS_10="{2016,2017,2018,2019,2020,2021,2022,2023,2024,2025,2026}"
YEARS_INDICES="{2023,2024,2025,2026}"   # us_indices only goes back 3yr
STAMP=$(date +%Y%m%d_%H%M%S)

run_sync() {
  local name="$1" src="$2" dest="$3" filter="$4" transfers="${5:-32}"
  local log="$LOG_DIR/${name}_${STAMP}.log"
  echo "[$(date +%H:%M:%S)] STARTING $name → $log"
  nohup rclone sync "polygon:flatfiles/$src" "$DEST_ROOT/$dest" \
      --include "$filter" \
      --transfers $transfers --checkers 64 \
      --s3-chunk-size 64M --s3-upload-concurrency 8 \
      --stats=1m --stats-one-line --log-level INFO --log-file="$log" \
      > /dev/null 2>&1 &
  echo "$name pid=$!"
}

echo "=== Polygon flat-files archive sync — start $(date) ==="
echo "Free space: $(df -h /Volumes/Archive | tail -1 | awk '{print $4}')"
echo ""

# A. Stocks minute aggs (10yr, ~62 GB, finishes first)
run_sync stocks_minute_aggs us_stocks_sip/minute_aggs_v1/ us_stocks_sip/minute_aggs_v1/ "$YEARS_10/**" 32

# B. Stocks day aggs (10yr, ~0.7 GB, instant)
run_sync stocks_day_aggs us_stocks_sip/day_aggs_v1/ us_stocks_sip/day_aggs_v1/ "$YEARS_10/**" 32

# C. Indices minute aggs (3yr only available, ~100 GB)
run_sync indices_minute_aggs us_indices/minute_aggs_v1/ us_indices/minute_aggs_v1/ "$YEARS_INDICES/**" 32

# D. Indices day aggs (small, all of it)
run_sync indices_day_aggs us_indices/day_aggs_v1/ us_indices/day_aggs_v1/ "**" 16

# E. Stocks TRADES (10yr, ~5.8 TB) — longest
run_sync stocks_trades us_stocks_sip/trades_v1/ us_stocks_sip/trades_v1/ "$YEARS_10/**" 24

# F. Stocks QUOTES (10yr, ~13.3 TB) — biggest
run_sync stocks_quotes us_stocks_sip/quotes_v1/ us_stocks_sip/quotes_v1/ "$YEARS_10/**" 24

echo ""
echo "All 6 streams launched. Monitor with:"
echo "  tail -f $LOG_DIR/*_${STAMP}.log"
echo "  df -h /Volumes/Archive  # disk fill"
echo "  ps aux | grep rclone   # processes"
echo ""
echo "Stamp: $STAMP"
