#!/usr/bin/env bash
# Archive download watchdog — Pavan asleep, autonomous mode.
# Every 5 min: ps-check each known download. If dead AND not complete, restart.
# Telegram on stream completions + final summary.
# Compatible with bash 3.2 (no associative arrays).

set -o pipefail
cd "$(dirname "$0")/.."

WATCHDOG_LOG=/Volumes/Archive/polygon-flatfiles/logs/watchdog_$(date +%Y%m%d_%H%M%S).log
STOP_FILE=/tmp/archive-watchdog-stop
DEADLINE=$(($(date +%s) + 12*3600))

# Load only telegram env vars (avoid sourcing whole .env — line 39 is malformed)
export TELEGRAM_BOT_TOKEN=$(grep "^TELEGRAM_BOT_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2-)
export TELEGRAM_CHAT_ID=$(grep "^TELEGRAM_CHAT_ID=" .env 2>/dev/null | head -1 | cut -d= -f2-)

# Completion tracking files (filesystem flags, bash-3-compatible)
DONE_DIR=/tmp/archive-watchdog-done
mkdir -p "$DONE_DIR"

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*"
  echo "$msg"
  echo "$msg" >> "$WATCHDOG_LOG"
}

tg() {
  [ -z "${TELEGRAM_BOT_TOKEN:-}" ] && return
  [ -z "${TELEGRAM_CHAT_ID:-}" ] && return
  curl -sS --max-time 8 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "parse_mode=HTML" \
    --data-urlencode "text=$1" > /dev/null 2>&1 || true
}

# Completion checks
is_minute_aggs_done() {
  local n=$(find /Volumes/Archive/polygon-flatfiles/us_stocks_sip/minute_aggs_v1 -name "*.csv.gz" 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -ge 2400 ]
}
is_day_aggs_done() {
  local n=$(find /Volumes/Archive/polygon-flatfiles/us_stocks_sip/day_aggs_v1 -name "*.csv.gz" 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -ge 2400 ]
}
is_trades_done() {
  local n=$(find /Volumes/Archive/polygon-flatfiles/us_stocks_sip/trades_v1 -name "*.csv.gz" 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -ge 2400 ]
}
is_rest_done() {
  local d=$(find /Volumes/Archive/polygon-rest/tickers/details -name "*.json.gz" 2>/dev/null | wc -l | tr -d ' ')
  local s=$(find /Volumes/Archive/polygon-rest/corporate_actions/splits -name "*.json.gz" 2>/dev/null | wc -l | tr -d ' ')
  local v=$(find /Volumes/Archive/polygon-rest/corporate_actions/dividends -name "*.json.gz" 2>/dev/null | wc -l | tr -d ' ')
  local f=$(find /Volumes/Archive/polygon-rest/financials -name "*.json.gz" 2>/dev/null | wc -l | tr -d ' ')
  [ "$d" -ge 12500 ] && [ "$s" -ge 12500 ] && [ "$v" -ge 12500 ] && [ "$f" -ge 12500 ]
}
is_news_done() {
  local n=$(find /Volumes/Archive/benzinga-news -name "*.jsonl.gz" 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -ge 1240 ]
}

is_alive() {
  pgrep -f "$1" > /dev/null 2>&1
}

restart_minute_aggs() {
  log "  → restarting minute_aggs"
  local STAMP=$(date +%Y%m%d_%H%M%S)
  local LOG=/Volumes/Archive/polygon-flatfiles/logs/minute_aggs_${STAMP}.log
  nohup rclone sync polygon:flatfiles/us_stocks_sip/minute_aggs_v1/ /Volumes/Archive/polygon-flatfiles/us_stocks_sip/minute_aggs_v1/ \
      --include "{2016,2017,2018,2019,2020,2021,2022,2023,2024,2025,2026}/**" \
      --transfers 32 --checkers 64 --s3-chunk-size 64M --stats=2m --stats-one-line \
      --log-level NOTICE --log-file="$LOG" </dev/null > /dev/null 2>&1 &
  log "  → pid $!"
}
restart_day_aggs() {
  log "  → restarting day_aggs"
  local STAMP=$(date +%Y%m%d_%H%M%S)
  local LOG=/Volumes/Archive/polygon-flatfiles/logs/day_aggs_${STAMP}.log
  nohup rclone sync polygon:flatfiles/us_stocks_sip/day_aggs_v1/ /Volumes/Archive/polygon-flatfiles/us_stocks_sip/day_aggs_v1/ \
      --include "{2016,2017,2018,2019,2020,2021,2022,2023,2024,2025,2026}/**" \
      --transfers 32 --checkers 64 --s3-chunk-size 64M --stats=2m --stats-one-line \
      --log-level NOTICE --log-file="$LOG" </dev/null > /dev/null 2>&1 &
  log "  → pid $!"
}
restart_trades() {
  log "  → restarting trades"
  local STAMP=$(date +%Y%m%d_%H%M%S)
  local LOG=/Volumes/Archive/polygon-flatfiles/logs/trades_${STAMP}.log
  nohup rclone sync polygon:flatfiles/us_stocks_sip/trades_v1/ /Volumes/Archive/polygon-flatfiles/us_stocks_sip/trades_v1/ \
      --include "{2016,2017,2018,2019,2020,2021,2022,2023,2024,2025,2026}/**" \
      --transfers 24 --checkers 32 --s3-chunk-size 64M --stats=2m --stats-one-line \
      --log-level NOTICE --log-file="$LOG" </dev/null > /dev/null 2>&1 &
  log "  → pid $!"
}
restart_rest() {
  log "  → restarting polygon-rest snapshot"
  RPS=8 nohup node scripts/polygon-rest-snapshot.mjs > /tmp/polygon-rest-snapshot.log 2>&1 &
  log "  → pid $!"
}
restart_news() {
  log "  → restarting benzinga-news bulk"
  RPS=5 nohup node scripts/benzinga-news-bulk.mjs > /tmp/benzinga-news-bulk.log 2>&1 &
  log "  → pid $!"
}

check_and_restart() {
  # $1 name, $2 alive-pattern, $3 done-fn, $4 restart-fn
  local name="$1" alive_pattern="$2" done_fn="$3" restart_fn="$4"
  local notified_file="$DONE_DIR/$name"
  if $done_fn; then
    if [ ! -f "$notified_file" ]; then
      log "✅ $name COMPLETE"
      tg "✅ <b>$name COMPLETE</b>"
      touch "$notified_file"
      if is_alive "$alive_pattern"; then
        pgrep -f "$alive_pattern" | xargs -I{} kill {} 2>/dev/null || true
      fi
    fi
    return 0
  fi
  if ! is_alive "$alive_pattern"; then
    log "⚠️  $name died (not complete) — restarting"
    tg "⚠️ <b>$name died</b> — auto-restarting"
    $restart_fn
  fi
}

log "Watchdog START — autonomous mode (user sleeping, all approvals given)"
log "Deadline: $(date -r $DEADLINE '+%Y-%m-%d %H:%M:%S %Z')"
log "Stop file: $STOP_FILE (touch to exit early)"
tg "🌙 <b>Archive watchdog armed</b> — Pavan asleep. Will alert on stream completions and any restarts. Watchdog log: $WATCHDOG_LOG"

ITER=0
while true; do
  ITER=$((ITER + 1))
  NOW=$(date +%s)
  if [ "$NOW" -gt "$DEADLINE" ]; then
    log "⏰ deadline reached, exiting"
    tg "⏰ Watchdog deadline reached (12h)"
    break
  fi
  if [ -f "$STOP_FILE" ]; then
    log "🛑 stop file detected, exiting"
    tg "🛑 Watchdog stopped via stop file"
    break
  fi

  log "--- iter $ITER (disk used: $(df -h /Volumes/Archive | tail -1 | awk '{print $3}')) ---"

  check_and_restart "minute_aggs" "us_stocks_sip/minute_aggs_v1" is_minute_aggs_done restart_minute_aggs
  check_and_restart "day_aggs"    "us_stocks_sip/day_aggs_v1"    is_day_aggs_done    restart_day_aggs
  check_and_restart "trades"      "us_stocks_sip/trades_v1"      is_trades_done      restart_trades
  check_and_restart "rest"        "polygon-rest-snapshot"        is_rest_done        restart_rest
  check_and_restart "news"        "benzinga-news-bulk"           is_news_done        restart_news

  if is_minute_aggs_done && is_day_aggs_done && is_trades_done && is_rest_done && is_news_done; then
    log "🎉 ALL DOWNLOADS COMPLETE"
    SUMMARY=$(scripts/archive-status.sh 2>&1 | grep -E "^   (Used|news|day_aggs|minute_aggs|trades_v1|tickers|corporate|financials|reference)" | head -20)
    tg "🎉 <b>All archive downloads COMPLETE</b>
$SUMMARY"
    break
  fi

  sleep 300
done

log "Watchdog EXIT"
