#!/usr/bin/env bash
# Daily incremental with CATCH-UP: pulls every missing trading day since the last
# file on disk (per stream) through yesterday ET — so a missed run self-heals.
# Idempotent: skips days already present. Sources .env for API keys.
#
# Scheduled via LaunchAgent ~/Library/LaunchAgents/com.pavan.polygon-daily.plist
# (launchd runs a missed StartCalendarInterval job when the Mac next wakes —
#  unlike cron, which silently skips missed runs and needs Full Disk Access).
set -uo pipefail

cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@18/bin:/usr/bin:/bin"

# NOTE: do NOT `source .env` — it shell-expands values (e.g. DASHBOARD_PASSWORD contains a
# $-sequence) and aborts under `set -u`. The node child scripts load .env themselves via
# dotenv (cwd = project root). We only need the two Telegram vars here; read them literally:
get_env() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | sed -E "s/^[\"']//; s/[\"']$//"; }
TELEGRAM_BOT_TOKEN=$(get_env TELEGRAM_BOT_TOKEN)
TELEGRAM_CHAT_ID=$(get_env TELEGRAM_CHAT_ID)

ARCHIVE=/Volumes/Archive/polygon-flatfiles
NEWSDIR=/Volumes/Archive/benzinga-news
LOGDIR="$HOME/Library/Logs"          # home, not the external volume (TCC-safe + survives unmount)
mkdir -p "$LOGDIR" 2>/dev/null
LOG="$LOGDIR/polygon-incremental_$(date +%Y%m%d_%H%M%S).log"
exec >>"$LOG" 2>&1

echo "[$(date '+%F %T %Z')] catch-up incremental START"

# Guard: external archive volume must be mounted
if [ ! -d "$ARCHIVE/us_stocks_sip" ]; then
  echo "FATAL: $ARCHIVE not mounted — aborting"; exit 1
fi

# Last fully-published ET trading day = yesterday ET
YDAY=$(TZ=America/New_York date -v-1d +%Y-%m-%d)
echo "  target through (yesterday ET) = $YDAY"

# NOTE: -v MUST precede -f on this macOS (Darwin 25 / Mac Studio). With -v after -f,
# date silently ignores both the adjustment AND the output format → next_day returned
# a long-format string → lexical compare failed → every stream said "up to date".
# This froze ALL daily pulls at 2026-06-08 (migration day). Fixed 2026-06-11.
next_day() { date -j -v+1d -f %Y-%m-%d "$1" +%Y-%m-%d; }

backfill_stream() {
  local stream=$1
  local base="$ARCHIVE/us_stocks_sip/$stream"
  local last
  last=$(ls "$base"/*/*/*.csv.gz 2>/dev/null | tail -1 | sed -E 's#.*/([0-9]{4}-[0-9]{2}-[0-9]{2})\.csv\.gz#\1#')
  [ -z "$last" ] && last=$(date -v-7d +%Y-%m-%d)
  echo "  $stream: last on disk=$last"
  local d; d=$(next_day "$last")
  while [[ "$d" < "$YDAY" || "$d" == "$YDAY" ]]; do
    local yr=${d:0:4} mo=${d:5:2} dst="$base/${d:0:4}/${d:5:2}/"
    mkdir -p "$dst"
    if [ -f "$dst$d.csv.gz" ]; then
      echo "    $d present, skip"
    elif rclone copy "polygon:flatfiles/us_stocks_sip/$stream/$yr/$mo/$d.csv.gz" "$dst" 2>/dev/null && [ -f "$dst$d.csv.gz" ]; then
      echo "    OK $d ($(ls -lh "$dst$d.csv.gz" | awk '{print $5}'))"
    else
      echo "    -- $d unavailable (weekend/holiday/not-yet-published)"
    fi
    d=$(next_day "$d")
  done
}

for s in minute_aggs_v1 day_aggs_v1 trades_v1; do backfill_stream "$s"; done

# --- News catch-up ---
last_news=$(ls "$NEWSDIR"/*/*/*.jsonl.gz 2>/dev/null | tail -1 | sed -E 's#.*/([0-9]{4}-[0-9]{2}-[0-9]{2})\.jsonl\.gz#\1#')
[ -z "$last_news" ] && last_news=$(date -v-7d +%Y-%m-%d)
news_from=$(next_day "$last_news")
if [[ "$news_from" < "$YDAY" || "$news_from" == "$YDAY" ]]; then
  echo "  news: pulling $news_from -> $YDAY"
  FROM=$news_from TO=$YDAY RPS=5 node scripts/benzinga-news-bulk.mjs
else
  echo "  news: up to date (last=$last_news)"
fi

# --- Refresh REST tickers list + reference (cheap, keeps universe current) ---
PHASES=reference,tickers RPS=5 FRESHNESS_DAYS=1 node scripts/polygon-rest-snapshot.mjs

# --- T1 Bronze: append yesterday's OLTP partitions (all tables, schema-flexible) ---
# Read-only on Postgres; DuckDB Postgres scanner → /Volumes/Archive/bronze/oltp/<table>/dt=YDAY/.
# Heavy/redundant market tables deferred (backfilled separately on Mac Studio).
BRONZE_DEFER="intraday_bars_1m,databento_ohlcv_1m,backtest_scores,backtest_prices,backtest_returns"
if command -v duckdb >/dev/null 2>&1; then
  BRONZE_ROOT=/Volumes/Archive/bronze/oltp MODE=daily EXCLUDE="$BRONZE_DEFER" \
    node scripts/dump-oltp-to-bronze.mjs || echo "  ⚠️ bronze daily append exited non-zero (check ~/Library/Logs)"
else
  echo "  ⚠️ duckdb not on PATH — skipping bronze daily append"
fi

# --- T2 Silver: sync ALL OLTP tables Bronze→Silver (validated, lossless) + append market day ---
# Aborts loud on any Bronze→Silver row-count mismatch (data-integrity gate).
if [ -x ./.venv-lake/bin/python ]; then
  ./.venv-lake/bin/python -m lake.sync_daily || echo "  ⚠️ silver sync exited non-zero (check log)"
else
  echo "  ⚠️ .venv-lake missing — skipping silver sync"
fi
# sync_daily does the full Bronze→Silver→Gold: signals (validated) + market append + GOLD rebuild
# (market_bars_daily_adj + features_daily). Gold is a full rebuild (~10min) — runs daily here.

# --- Refresh screener_volume (30d avg vol + day vol + close/chg) FROM THE LAKE ---
# MUST use the lake (Polygon CONSOLIDATED volume), NOT backtest_prices: the 5 PM refresh-prices
# cron fills backtest_prices.volume from Alpaca's free IEX feed = only ~3% of consolidated volume
# (NVDA shows 5M instead of ~150M). The lake's market_bars_daily is the correct full-tape volume.
# The 📊 Ownership screener reads volume from screener_volume. sync_daily above already appended
# yesterday's market day to the lake, so this is fresh.
# ⚠️ POLYGON-EXIT FOLLOW-UP: once Polygon stops, market_bars_daily stops updating → this goes
#    stale. Replace the volume source with Yahoo (regularMarketVolume + averageDailyVolume3Month
#    in scripts/etl/ingest-ownership.mjs). See docs/POLYGON_EXIT_PLAN.md.
DBURL=$(get_env DATABASE_URL)
if [ -n "$DBURL" ] && command -v duckdb >/dev/null 2>&1; then
  duckdb -c "
    INSTALL postgres; LOAD postgres;
    ATTACH '${DBURL}' AS pg (TYPE POSTGRES);
    DELETE FROM pg.public.screener_volume;
    INSERT INTO pg.public.screener_volume (symbol, avg_vol_30d, day_vol, close, prev_close, chg_pct, updated_at)
    WITH r AS (SELECT symbol, volume, close, row_number() OVER(PARTITION BY symbol ORDER BY d DESC) rn
               FROM read_parquet('/Volumes/Archive/silver/market_bars_daily/**/*.parquet'))
    SELECT symbol, round(avg(volume) FILTER(WHERE rn<=30))::bigint, round(max(volume) FILTER(WHERE rn=1))::bigint,
      max(close) FILTER(WHERE rn=1), max(close) FILTER(WHERE rn=2),
      round(100.0*(max(close) FILTER(WHERE rn=1)-max(close) FILTER(WHERE rn=2))/NULLIF(max(close) FILTER(WHERE rn=2),0),2), now()
    FROM r WHERE rn<=30 GROUP BY symbol;" \
    && echo "  ✅ screener_volume refreshed from lake" || echo "  ⚠️ screener_volume refresh failed"
fi

# --- Sync backtest_prices.volume FROM THE LAKE (Polygon CONSOLIDATED volume) ---------
# The 5 PM refresh-prices cron writes OHLC/close only and leaves volume NULL (its Alpaca
# feed is IEX-only ≈3% of tape — it used to 30×-deflate the bot's ADV/rvol features and
# wrongly trip the ≥$5M liquidity gate). The lake's market_bars_daily holds the correct
# full-tape volume; sync_daily above already appended yesterday's market day. We patch the
# trailing window so the bot's getLiquidityProfile() / setup-classifier read true volume.
# Bounded to last 15 calendar days = cheap + self-healing (a missed run catches up).
# ⚠️ POLYGON-EXIT FOLLOW-UP: when Polygon stops, market_bars_daily stops → volume goes NULL.
#    Replace source with Yahoo regularMarketVolume (see docs/POLYGON_EXIT_PLAN.md).
if [ -n "${DBURL:-}" ] && command -v duckdb >/dev/null 2>&1; then
  duckdb -c "
    INSTALL postgres; LOAD postgres;
    ATTACH '${DBURL}' AS pg (TYPE POSTGRES);
    CREATE TEMP TABLE volfix AS
      SELECT symbol, d::DATE AS price_date, volume
      FROM read_parquet('/Volumes/Archive/silver/market_bars_daily/**/*.parquet')
      WHERE d >= (current_date - INTERVAL 15 DAY) AND volume IS NOT NULL;
    UPDATE pg.public.backtest_prices b
      SET volume = v.volume
      FROM volfix v
      WHERE b.symbol = v.symbol AND b.price_date = v.price_date
        AND b.volume IS DISTINCT FROM v.volume;" \
    && echo "  ✅ backtest_prices.volume synced from lake (15d window)" \
    || echo "  ⚠️ backtest_prices volume sync failed"
fi

# ═══ DATA-GAP GUARDS (added 2026-06-12 after the freshness audit) ═════════════════════
# These tables were populated by one-shot scripts during build sessions and silently froze
# when nobody re-ran them (earnings 12d stale, intraday/features/sector_rotation 11d, …).
# Every former one-shot now runs here daily, incrementally. See GOTCHAS.md.

# Earnings calendar — bot earnings-gates + Calendar tab + Sentinel + Ownership screener.
node scripts/build-earnings-calendar.mjs --liquid-only --refresh-stale 7 \
  || echo "  ⚠️ earnings refresh failed"

# Sector rotation — feeds v_ml_training_set + sector context. (Writer was lost; rebuilt.)
node scripts/refresh-sector-rotation.mjs --days 10 || echo "  ⚠️ sector-rotation refresh failed"

# Minute bars → OLTP (intraday_bars_1m) + daily intraday features (RVOL/VWAP/OR for ML).
# NOTE --root: default points at the old Intel-Mac path (~/polygon-data) — burned us once.
# ⚠️ POLYGON-EXIT: this reads polygon flatfiles; needs an OLTP-source rewrite when Polygon stops.
node scripts/ingest-polygon-minute.mjs --days 5 --resume \
  --root /Volumes/Archive/polygon-flatfiles/us_stocks_sip/minute_aggs_v1 \
  || echo "  ⚠️ minute ingest failed"
node scripts/build-daily-intraday-features.mjs --days 5 || echo "  ⚠️ intraday features failed"

# Mover retrospective — cheap daily catch-up.
node scripts/backfill-mover-retrospective.mjs --days 3 --resume || echo "  ⚠️ mover-retro failed"

# Weekly (Sundays): stock correlations + fundamentals (quarterly-ish data, weekly check is plenty).
if [ "$(date +%u)" = "7" ]; then
  node scripts/build-stock-correlations.mjs || echo "  ⚠️ correlations failed"
  node --env-file=.env src/research/download-fundamentals.js || echo "  ⚠️ fundamentals failed"
fi

# --- Index membership (S&P 500 + NASDAQ-100) — the screener universe. Cheap; refresh daily so
#     index reconstitutions are picked up automatically. Keeps last list if the fetch fails. ---
node scripts/etl/ingest-index-membership.mjs || echo "  ⚠️ index-membership refresh failed (keeping prior list)"

# --- Moomoo fundamentals (trailing PE / EPS / market cap) — PRIMARY PE source for the screener ---
# From OpenD (broker, free, local). Only runs if OpenD is up; Yahoo/universe are the fallbacks
# baked into the API COALESCE, so a down OpenD degrades gracefully (just slightly staler PE).
# NOTE: OpenD has trailing PE only — forward PE stays Yahoo-sourced.
if nc -z -w2 127.0.0.1 "${MOOMOO_OPEND_PORT:-11111}" 2>/dev/null; then
  LIMIT=3000 node scripts/etl/ingest-moomoo-fundamentals.mjs || echo "  ⚠️ moomoo fundamentals ingest exited non-zero"
else
  echo "  -- OpenD not reachable; skipping Moomoo fundamentals (Yahoo/universe PE fallback stays in effect)"
fi

# --- Ownership snapshot (float + institutional, from Yahoo) for the 📊 Ownership screener tab ---
# Scoped to top-liquid names to bound Yahoo load; daily snapshot powers the inst-change columns.
LIMIT=3000 node scripts/etl/ingest-ownership.mjs || echo "  ⚠️ ownership ingest exited non-zero (check log)"

echo "[$(date '+%F %T %Z')] catch-up incremental END"

# Telegram summary (best-effort)
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "text=📦 Polygon catch-up complete through $YDAY" >/dev/null 2>&1 || true
fi

# --- Log hygiene (2026-06-12 audit): keep 14 days of dated incremental logs ---
find "$HOME/Library/Logs" -maxdepth 1 -name 'polygon-incremental_*.log' -mtime +14 -delete 2>/dev/null || true
