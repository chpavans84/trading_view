-- ============================================================================
-- DATA VALIDATION — OLTP (Postgres) vs Lake (DuckDB Parquet)
-- Run this in DBeaver's DUCKDB connection (catalog: /Volumes/Archive/lake.duckdb).
-- DuckDB ATTACHes Postgres so both sources are queryable together.
-- ============================================================================

-- 0. Attach the live Postgres OLTP (read-only)
INSTALL postgres; LOAD postgres;
ATTACH 'postgresql://localhost/tradingbot' AS pg (TYPE POSTGRES, READ_ONLY);

-- 1. ROW-COUNT PARITY: Bronze (lake) vs OLTP (pg).
--    delta = pg - lake. 0 = exact. Small POSITIVE = live tables grew since the Bronze
--    snapshot (expected for actively-written tables). NEGATIVE or large = investigate.
SELECT t AS table, pg_rows, lake_rows, pg_rows - lake_rows AS delta FROM (
  SELECT 'conviction_scores' t, (SELECT count(*) FROM pg.public.conviction_scores) pg_rows, (SELECT count(*) FROM oltp_conviction_scores) lake_rows
  UNION ALL SELECT 'trades',            (SELECT count(*) FROM pg.public.trades),            (SELECT count(*) FROM oltp_trades)
  UNION ALL SELECT 'bot_decisions',     (SELECT count(*) FROM pg.public.bot_decisions),     (SELECT count(*) FROM oltp_bot_decisions)
  UNION ALL SELECT 'uw_flow_alerts',    (SELECT count(*) FROM pg.public.uw_flow_alerts),    (SELECT count(*) FROM oltp_uw_flow_alerts)
  UNION ALL SELECT 'uw_insider_trades', (SELECT count(*) FROM pg.public.uw_insider_trades), (SELECT count(*) FROM oltp_uw_insider_trades)
  UNION ALL SELECT 'uw_top_movers',     (SELECT count(*) FROM pg.public.uw_top_movers),     (SELECT count(*) FROM oltp_uw_top_movers)
  UNION ALL SELECT 'signal_returns',    (SELECT count(*) FROM pg.public.signal_returns),    (SELECT count(*) FROM oltp_signal_returns)
  UNION ALL SELECT 'prediction_errors', (SELECT count(*) FROM pg.public.prediction_errors), (SELECT count(*) FROM oltp_prediction_errors)
) ORDER BY abs(pg_rows - lake_rows) DESC;

-- 2. SPLIT-ADJUSTMENT SANITY: prices must be CONTINUOUS across splits (no ~Nx jump).
--    NVDA 10:1 (2024-06-07), AAPL 4:1 (2020-08-31), TSLA 3:1 (2022-08-25).
SELECT symbol, d, round(close,2) AS adj_close, round(split_factor,2) AS factor
FROM market_bars_daily_adj
WHERE (symbol='NVDA' AND d BETWEEN DATE '2024-06-05' AND DATE '2024-06-11')
   OR (symbol='AAPL' AND d BETWEEN DATE '2020-08-27' AND DATE '2020-09-01')
   OR (symbol='TSLA' AND d BETWEEN DATE '2022-08-23' AND DATE '2022-08-26')
ORDER BY symbol, d;

-- 3. LAKE COVERAGE: full history + breadth.
SELECT 'market_bars_daily_adj' AS src, count(*) AS n_rows, count(DISTINCT symbol) AS syms, min(d) AS first_day, max(d) AS last_day FROM market_bars_daily_adj
UNION ALL
SELECT 'features_daily',            count(*),         count(DISTINCT symbol),         min(d),          max(d)          FROM features_daily;

-- 4. SURVIVORSHIP CHECK: delisted names must exist in price history (else biased backtests).
--    Count symbols in adjusted prices that are NOT in the current active universe.
SELECT count(DISTINCT symbol) AS delisted_symbols_in_history
FROM market_bars_daily_adj
WHERE symbol NOT IN (SELECT symbol FROM pg.public.tradable_universe);

-- 5. FRESHNESS: latest data per source (lake snapshot vs live OLTP).
SELECT 'lake conviction (Bronze)' src, max(scored_at)::date AS latest FROM oltp_conviction_scores
UNION ALL
SELECT 'pg conviction (live)',          max(scored_at)::date         FROM pg.public.conviction_scores;
