#!/usr/bin/env bash
# Master orchestrator for the 7-item OLTP backfill.
# Runs in dependency order. Each item is independently restartable.
#
# Pre-req: migration `1780780000000_oltp-backfill-schema.js` already applied via:
#   npx node-pg-migrate up
#   (or psql tradingbot < the SQL equivalent)
#
# Usage:
#   scripts/etl/run-all-backfills.sh           # full run, all 6 items in sequence
#   scripts/etl/run-all-backfills.sh --dry     # dry-run all
#   scripts/etl/run-all-backfills.sh fred      # single item by name
#   scripts/etl/run-all-backfills.sh financials corporate news
#
# Total runtime: ~6-8 hours sequential; ~3-4 hours if you fan out across cores.
# Recommended: run on a weekend / when bot quiet.

set -o pipefail
cd "$(dirname "$0")/../.."

DRY_FLAG=""
if [ "$1" = "--dry" ]; then DRY_FLAG="DRY=1"; shift; fi

ALL_ITEMS=(fred vix financials corporate news features)
ITEMS=("$@")
[ ${#ITEMS[@]} -eq 0 ] && ITEMS=("${ALL_ITEMS[@]}")

LOG_DIR=/Volumes/Archive/polygon-flatfiles/logs/etl
mkdir -p "$LOG_DIR"

run_one() {
  local name="$1" cmd="$2"
  local log="$LOG_DIR/${name}_$(date +%Y%m%d_%H%M%S).log"
  echo ""
  echo "════════════════════════════════════════════════════════════════════"
  echo "  [$name] START — log: $log"
  echo "════════════════════════════════════════════════════════════════════"
  eval "$DRY_FLAG $cmd" 2>&1 | tee "$log"
  echo "  [$name] DONE"
}

for item in "${ITEMS[@]}"; do
  case "$item" in
    fred)        run_one "fred-macro"        "node scripts/etl/load-fred-macro.mjs" ;;
    vix)         run_one "vix-history"       "node scripts/etl/load-vix-history.mjs" ;;
    financials)  run_one "polygon-financials" "node scripts/etl/load-polygon-financials.mjs" ;;
    corporate)   run_one "corporate-actions" "node scripts/etl/load-corporate-actions.mjs" ;;
    news)        run_one "benzinga-news"     "node scripts/etl/load-benzinga-news.mjs" ;;
    features)    run_one "daily-features"    "node scripts/etl/build-daily-features-from-hdd.mjs" ;;
    *)           echo "Unknown item: $item (valid: ${ALL_ITEMS[*]})" ;;
  esac
done

echo ""
echo "All requested ETLs complete. Log dir: $LOG_DIR"
