#!/usr/bin/env bash
# ============================================================================
# BOT_SIM data loader — populates the sim.* replay tables from the lake +
# read-only production reference tables. Run as the DB OWNER (one-time per
# window). The engine (sim_runner) only ever READS these.
#
# Sources:
#   sim.universe       <- public.index_membership (S&P500 ∪ NDX100, 516 names)
#   sim.minute_bars    <- lake silver/market_bars_minute  (RTH, window)
#   sim.daily_features <- lake gold/features_daily         (BACKWARD cols only)
#   sim.regime         <- lake SPY daily, computed backward-only
#   sim.events_uw      <- public.uw_flow_alerts            (known_at=alerted_at)
#   sim.events_news    <- public.benzinga_news             (known_at=published_at)
#
# No forward-looking column (fwd_ret_*) is ever loaded.
# ============================================================================
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/../../.."   # repo root

DBURL="$(node --input-type=module -e "import 'dotenv/config'; process.stdout.write(process.env.DATABASE_URL||'')")"
DUCK=/opt/homebrew/bin/duckdb
SILVER=/Volumes/Archive/silver
GOLD=/Volumes/Archive/gold
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Window is parametric: WINDOW_FROM / WINDOW_TO env vars (default = the 2026 R1 window).
WINDOW_FROM="${WINDOW_FROM:-2026-05-11}"
WINDOW_TO="${WINDOW_TO:-2026-06-12}"
# head-room: a few sessions of minute bars before the window; features/regime ~3wk prior
FROM_MIN="$(date -j -v-5d -f %Y-%m-%d "$WINDOW_FROM" +%Y-%m-%d)"
TO_MIN="$WINDOW_TO"
FROM_FEAT="$(date -j -v-21d -f %Y-%m-%d "$WINDOW_FROM" +%Y-%m-%d)"
echo "[etl] window $WINDOW_FROM .. $WINDOW_TO  (minute from $FROM_MIN, features from $FROM_FEAT)"

echo "[etl] 0/6 truncate sim data tables"
psql "$DBURL" -q -c "TRUNCATE sim.universe, sim.minute_bars, sim.daily_features, sim.regime, sim.events_uw, sim.events_news;"

# SIM_UNIVERSE=index (default) → current S&P500∪NDX100 (has survivorship bias on old windows).
# SIM_UNIVERSE=liquidity     → top-N by adv20 AS-OF the window start (point-in-time, survivorship-FREE).
if [ "${SIM_UNIVERSE:-index}" = "liquidity" ]; then
  echo "[etl] 1/6 universe (survivorship-FREE: top ${SIM_UNIVERSE_N:-500} by adv20 as-of $FROM_FEAT)"
  $DUCK -c "
  COPY (
    WITH liq AS (
      SELECT symbol, adv20, row_number() OVER (PARTITION BY symbol ORDER BY d DESC) rn
      FROM read_parquet('$GOLD/features_daily/**/*.parquet')
      WHERE d <= DATE '$FROM_FEAT' AND adv20 IS NOT NULL
    )
    SELECT symbol FROM liq WHERE rn = 1 ORDER BY adv20 DESC LIMIT ${SIM_UNIVERSE_N:-500}
  ) TO '$TMP/uni_sel.csv' (HEADER false);"
  psql "$DBURL" -q -c "\copy sim.universe(symbol) FROM '$TMP/uni_sel.csv' CSV"
  psql "$DBURL" -q -c "UPDATE sim.universe SET in_sp500=true WHERE in_sp500 IS NULL;"
else
  echo "[etl] 1/6 universe (S&P500 ∪ NDX100, current membership)"
  psql "$DBURL" -q -c "INSERT INTO sim.universe(symbol,in_sp500,in_ndx100)
    SELECT symbol, in_sp500, in_ndx100 FROM index_membership WHERE in_sp500 OR in_ndx100;"
fi
# Tradable universe (excludes SPY); minute-bar filter additionally pulls SPY as the
# market-bounce reference so the feed has its intraday bars without it being a candidate.
psql "$DBURL" -tc "COPY (SELECT symbol FROM sim.universe) TO STDOUT" > "$TMP/uni.txt"
cp "$TMP/uni.txt" "$TMP/uni_bars.txt"
echo "SPY" >> "$TMP/uni_bars.txt"

echo "[etl] 2/6 minute bars (lake → csv → copy)"
$DUCK -c "
SET TimeZone='UTC';
COPY (
  SELECT b.symbol, b.ts_utc AS ts, b.open, b.high, b.low, b.close, b.volume
  FROM read_parquet('$SILVER/market_bars_minute/**/*.parquet') b
  SEMI JOIN read_csv('$TMP/uni_bars.txt', header=false) u ON b.symbol = u.column0
  WHERE b.ts_utc >= TIMESTAMP '$FROM_MIN' AND b.ts_utc < TIMESTAMP '$TO_MIN'
    AND CAST(b.ts_utc AT TIME ZONE 'UTC' AS TIME) >= TIME '13:30'
    AND CAST(b.ts_utc AT TIME ZONE 'UTC' AS TIME) <  TIME '20:00'   -- RTH (EDT = UTC-4)
) TO '$TMP/minute.csv' (HEADER, FORMAT csv);"
psql "$DBURL" -q -c "\copy sim.minute_bars(symbol,ts,open,high,low,close,volume) FROM '$TMP/minute.csv' CSV HEADER"

echo "[etl] 3/6 daily features (BACKWARD cols only)"
$DUCK -c "
COPY (
  SELECT f.symbol, f.d, f.close, f.ret_5d, f.rvol, f.dist_sma50, f.dist_sma200,
         f.dist_52whigh, f.rs_spy_20, f.adv20
  FROM read_parquet('$GOLD/features_daily/**/*.parquet') f
  SEMI JOIN read_csv('$TMP/uni.txt', header=false) u ON f.symbol = u.column0
  WHERE f.d >= DATE '$FROM_FEAT'
) TO '$TMP/feat.csv' (HEADER, FORMAT csv);"
psql "$DBURL" -q -c "\copy sim.daily_features(symbol,d,close,ret_5d,rvol,dist_sma50,dist_sma200,dist_52whigh,rs_spy_20,adv20) FROM '$TMP/feat.csv' CSV HEADER"
# dist_20dhigh = close / prior-20d-high − 1 (>0 = a 20-day breakout), point-in-time (prior rows only).
# Derived from the loaded close series — used by the `breakout` strategy. See reports/breakout-study-20260620.
psql "$DBURL" -q -c "
  WITH h AS (
    SELECT symbol, d,
      close / NULLIF(MAX(close) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING),0) - 1.0 AS dist_20dhigh
    FROM sim.daily_features)
  UPDATE sim.daily_features f SET dist_20dhigh = h.dist_20dhigh
  FROM h WHERE f.symbol=h.symbol AND f.d=h.d;"

echo "[etl] 4/6 regime (SPY, backward-only)"
$DUCK -c "
COPY (
  WITH base AS (
    SELECT d, close, ln(close / LAG(close) OVER (ORDER BY d)) AS lr
    FROM read_parquet('$SILVER/market_bars_daily_adj/**/*.parquet') WHERE symbol='SPY'
  ),
  feat AS (
    SELECT d, close,
      AVG(close) OVER (ORDER BY d ROWS BETWEEN 199 PRECEDING AND CURRENT ROW) AS sma200,
      STDDEV(lr) OVER (ORDER BY d ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) * sqrt(252) AS rvol20
    FROM base
  )
  SELECT d, close AS spy_close, sma200, rvol20,
    CASE WHEN close >= sma200 AND rvol20 < 0.20 THEN 'R1_up_calm'
         WHEN close >= sma200 AND rvol20 >= 0.20 THEN 'R2_up_vol'
         WHEN close <  sma200 AND rvol20 < 0.25 THEN 'R3_down_calm'
         ELSE 'R4_down_vol' END AS regime
  FROM feat WHERE d >= DATE '$FROM_FEAT' AND sma200 IS NOT NULL
) TO '$TMP/regime.csv' (HEADER, FORMAT csv);"
psql "$DBURL" -q -c "\copy sim.regime(d,spy_close,sma200,rvol20,regime) FROM '$TMP/regime.csv' CSV HEADER"

echo "[etl] 5/6 UW flow events (point-in-time, known_at=alerted_at)"
psql "$DBURL" -q -c "INSERT INTO sim.events_uw(ticker,known_at,bull_prem,bear_prem,premium,sentiment)
  SELECT a.ticker, a.alerted_at,
    CASE WHEN a.sentiment IN ('bullish','strong_bullish') THEN a.premium ELSE 0 END,
    CASE WHEN a.sentiment IN ('bearish','strong_bearish') THEN a.premium ELSE 0 END,
    a.premium, a.sentiment
  FROM uw_flow_alerts a
  JOIN sim.universe u ON u.symbol = a.ticker
  WHERE a.alerted_at >= '2026-05-08' AND a.premium IS NOT NULL;"

echo "[etl] 6/6 Benzinga news events (point-in-time, known_at=published_at)"
psql "$DBURL" -q -c "INSERT INTO sim.events_news(symbol,known_at,title,sentiment)
  SELECT t.tk, n.published_at, n.title, n.sentiment
  FROM benzinga_news n
  CROSS JOIN LATERAL jsonb_array_elements_text(n.tickers) AS t(tk)
  JOIN sim.universe u ON u.symbol = t.tk
  WHERE n.published_at >= '2026-05-08';"

echo "[etl] done. row counts:"
psql "$DBURL" -tc "SELECT 'universe', count(*) FROM sim.universe
  UNION ALL SELECT 'minute_bars', count(*) FROM sim.minute_bars
  UNION ALL SELECT 'daily_features', count(*) FROM sim.daily_features
  UNION ALL SELECT 'regime', count(*) FROM sim.regime
  UNION ALL SELECT 'events_uw', count(*) FROM sim.events_uw
  UNION ALL SELECT 'events_news', count(*) FROM sim.events_news;"
