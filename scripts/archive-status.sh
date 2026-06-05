#!/usr/bin/env bash
# Archive-download status: one-command "where are we" report.
# Usage: scripts/archive-status.sh

ROOT=/Volumes/Archive
cd "$(dirname "$0")/.."

echo "========================================================================"
echo "  POLYGON / BENZINGA ARCHIVE STATUS  —  $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "========================================================================"

# Disk free
echo ""
echo "## Disk"
df -h "$ROOT" | tail -1 | awk '{printf "   Used: %s  Free: %s  Capacity: %s\n", $3, $4, $5}'

# Running processes
echo ""
echo "## Active downloads"
RCLONE=$(ps aux | grep "[r]clone sync" | wc -l | tr -d ' ')
NODE_REST=$(ps aux | grep "[n]ode.*polygon-rest-snapshot" | wc -l | tr -d ' ')
NODE_NEWS=$(ps aux | grep "[n]ode.*benzinga-news-bulk" | wc -l | tr -d ' ')
echo "   rclone procs (S3 flat-files):    $RCLONE"
echo "   REST snapshot procs:              $NODE_REST"
echo "   News bulk procs:                  $NODE_NEWS"

# Per-stream stats (S3 flat-files)
echo ""
echo "## S3 flat-files (polygon-flatfiles/)"
if [ -d "$ROOT/polygon-flatfiles" ]; then
  for d in "$ROOT/polygon-flatfiles/us_stocks_sip"/*/; do
    if [ -d "$d" ]; then
      name=$(basename "$d")
      count=$(find "$d" -name "*.csv.gz" 2>/dev/null | wc -l | tr -d ' ')
      size=$(du -sh "$d" 2>/dev/null | awk '{print $1}')
      earliest=$(find "$d" -name "*.csv.gz" 2>/dev/null | sort | head -1 | xargs basename 2>/dev/null | sed 's/.csv.gz//')
      latest=$(find "$d" -name "*.csv.gz" 2>/dev/null | sort | tail -1 | xargs basename 2>/dev/null | sed 's/.csv.gz//')
      printf "   %-18s %5s files  %7s  range=%s..%s\n" "$name" "$count" "$size" "${earliest:-—}" "${latest:-—}"
    fi
  done
fi

# REST snapshot
echo ""
echo "## REST snapshot (polygon-rest/)"
if [ -d "$ROOT/polygon-rest" ]; then
  for sub in tickers/details corporate_actions/splits corporate_actions/dividends financials; do
    d="$ROOT/polygon-rest/$sub"
    if [ -d "$d" ]; then
      count=$(find "$d" -name "*.json.gz" 2>/dev/null | wc -l | tr -d ' ')
      printf "   %-30s %5s symbols\n" "$sub" "$count"
    fi
  done
  refdir="$ROOT/polygon-rest/reference"
  if [ -d "$refdir" ]; then
    refn=$(find "$refdir" -name "*.json.gz" 2>/dev/null | wc -l | tr -d ' ')
    printf "   %-30s %5s files\n" "reference" "$refn"
  fi
fi

# News bulk
echo ""
echo "## Benzinga news (benzinga-news/)"
if [ -d "$ROOT/benzinga-news" ]; then
  count=$(find "$ROOT/benzinga-news" -name "*.jsonl.gz" 2>/dev/null | wc -l | tr -d ' ')
  size=$(du -sh "$ROOT/benzinga-news" 2>/dev/null | awk '{print $1}')
  earliest=$(find "$ROOT/benzinga-news" -name "*.jsonl.gz" 2>/dev/null | sort | head -1 | xargs basename 2>/dev/null | sed 's/.jsonl.gz//')
  latest=$(find "$ROOT/benzinga-news" -name "*.jsonl.gz" 2>/dev/null | sort | tail -1 | xargs basename 2>/dev/null | sed 's/.jsonl.gz//')
  printf "   %-18s %5s days   %7s  range=%s..%s\n" "news" "$count" "$size" "${earliest:-—}" "${latest:-—}"
fi

# Tail latest log lines
echo ""
echo "## Recent log activity (last 1 line each)"
for log in "$ROOT"/polygon-flatfiles/logs/*.log /tmp/polygon-rest-snapshot.log /tmp/benzinga-news-bulk.log; do
  if [ -f "$log" ]; then
    last=$(tail -1 "$log" 2>/dev/null | head -c 120)
    printf "   %s\n   →  %s\n" "$(basename "$log")" "$last"
  fi
done

echo ""
echo "========================================================================"
