#!/usr/bin/env bash
# Daily incremental: pull yesterday's S3 files + run REST refresh + news.
# Designed to be cron'd at 09:00 SGT (= 21:00 ET previous day).
# Cron entry:
#   0 9 * * * cd /Users/pavan/Documents/Claude_Projects/trading_view/tradingview-mcp && scripts/polygon-daily-incremental.sh >> /Volumes/Archive/polygon-flatfiles/logs/daily-cron.log 2>&1
set -uo pipefail

cd "$(dirname "$0")/.."

LOG=/Volumes/Archive/polygon-flatfiles/logs/incremental_$(date +%Y%m%d).log
mkdir -p "$(dirname "$LOG")"

echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] daily incremental START" >> "$LOG"

# Yesterday's date in ET (markets closed at 16:00 ET previous day)
YDAY=$(TZ=America/New_York date -v-1d +%Y-%m-%d 2>/dev/null || date -d 'yesterday' +%Y-%m-%d)
YDAY_YEAR=$(echo "$YDAY" | cut -c1-4)
YDAY_MONTH=$(echo "$YDAY" | cut -c6-7)

echo "  Target: $YDAY  ($YDAY_YEAR/$YDAY_MONTH/$YDAY.csv.gz)" >> "$LOG"

# --- 1. Pull yesterday's stock files ---
for stream in minute_aggs_v1 day_aggs_v1 trades_v1; do
  src="polygon:flatfiles/us_stocks_sip/$stream/$YDAY_YEAR/$YDAY_MONTH/$YDAY.csv.gz"
  dst="/Volumes/Archive/polygon-flatfiles/us_stocks_sip/$stream/$YDAY_YEAR/$YDAY_MONTH/"
  mkdir -p "$dst"
  if rclone copy "$src" "$dst" --log-file="$LOG" --log-level NOTICE 2>>"$LOG"; then
    echo "  ✓ $stream: ok" >> "$LOG"
  else
    echo "  ✗ $stream: failed" >> "$LOG"
  fi
done

# --- 2. Pull yesterday's news ---
FROM=$YDAY TO=$YDAY RPS=5 node scripts/benzinga-news-bulk.mjs >> "$LOG" 2>&1

# --- 3. Refresh REST: tickers list + reference (cheap, weekly-ish freshness) ---
PHASES=reference,tickers RPS=5 FRESHNESS_DAYS=1 node scripts/polygon-rest-snapshot.mjs >> "$LOG" 2>&1

# --- 4. Optional: refresh per-symbol REST for ACTIVE tickers only (skip stale-ok)
#    Comment in if you want corporate-actions kept hot:
# PHASES=splits,dividends RPS=5 FRESHNESS_DAYS=30 ONLY=$(psql tradingbot -At -c "SELECT string_agg(DISTINCT UPPER(symbol),',') FROM trades WHERE opened_at > NOW() - INTERVAL '30 days'") \
#   node scripts/polygon-rest-snapshot.mjs >> "$LOG" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] daily incremental END" >> "$LOG"

# Telegram summary (best-effort)
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  SIZE=$(du -sh /Volumes/Archive/polygon-flatfiles/us_stocks_sip/*/$YDAY_YEAR/$YDAY_MONTH/$YDAY.csv.gz 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
  curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "text=📦 Polygon daily incremental complete for $YDAY ($SIZE)" \
    > /dev/null 2>&1 || true
fi
