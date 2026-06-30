-- ============================================================================
-- SILVER LAYER — historic data validation / QA
-- Run in DBeaver's DUCKDB connection. Uses read_parquet() so it works whether or
-- not the catalog has named views. Queries are partition/metadata-aware → fast even
-- over the 3.68B-row minute set. Run statements one at a time (⌘+Enter) or all.
-- ============================================================================
-- IMPORTANT: view all timestamps in ET (minute bars are partitioned by ET trading day).
-- Without this, ts_utc displays in your system TZ and splits one session across two dates.
SET TimeZone='America/New_York';

SET VARIABLE daily     = '/Volumes/Archive/silver/market_bars_daily/**/*.parquet';
SET VARIABLE daily_adj = '/Volumes/Archive/silver/market_bars_daily_adj/**/*.parquet';
SET VARIABLE minute    = '/Volumes/Archive/silver/market_bars_minute/**/*.parquet';

-- 1. COVERAGE — daily streams (cheap full scan, ~24M rows)
SELECT 'daily_raw' AS stream, count(*) AS n_rows, count(DISTINCT symbol) AS syms,
       min(d) AS first_day, max(d) AS last_day
FROM read_parquet(getvariable('daily'))
UNION ALL
SELECT 'daily_adj', count(*), count(DISTINCT symbol), min(d), max(d)
FROM read_parquet(getvariable('daily_adj'));

-- 2. MINUTE total rows (instant — read from Parquet metadata, no full scan)
SELECT 'minute' AS stream, count(*) AS n_rows FROM read_parquet(getvariable('minute'));

-- 3. GAP CHECK — trading days per year (US market ≈ 252/yr; 2016 & 2026 partial)
SELECT year(d) AS yr, count(DISTINCT d) AS trading_days
FROM read_parquet(getvariable('daily')) GROUP BY 1 ORDER BY 1;

-- 4. OHLC INTEGRITY — should return 0 bad rows
SELECT count(*) AS bad_ohlc_rows
FROM read_parquet(getvariable('daily_adj'))
WHERE NOT (high >= low AND high >= greatest(open, close)
           AND low <= least(open, close) AND close > 0 AND volume >= 0);

-- 5. SPLIT-ADJUSTMENT — must be CONTINUOUS across splits (no ~Nx jump)
SELECT symbol, d, round(close,2) AS adj_close, round(split_factor,2) AS factor
FROM read_parquet(getvariable('daily_adj'))
WHERE (symbol='NVDA' AND d BETWEEN DATE '2024-06-05' AND DATE '2024-06-11')
   OR (symbol='AAPL' AND d BETWEEN DATE '2020-08-27' AND DATE '2020-09-01')
ORDER BY symbol, d;

-- 6. MINUTE GRANULARITY — bars per day for AAPL on a known trading day (partition-pruned, fast)
SELECT CAST(ts_utc AS DATE) AS d, count(*) AS bars,
       min(ts_utc) AS first_bar, max(ts_utc) AS last_bar
FROM read_parquet('/Volumes/Archive/silver/market_bars_minute/d=2026-06-05/*.parquet')
WHERE symbol='AAPL' GROUP BY 1;

-- 7. SPOT VALUE — eyeball recent AAPL daily closes (adjusted)
SELECT d, round(open,2) o, round(high,2) h, round(low,2) l, round(close,2) c, volume
FROM read_parquet(getvariable('daily_adj'))
WHERE symbol='AAPL' ORDER BY d DESC LIMIT 5;

-- 8. PER-YEAR breadth of the minute set (distinct symbols per year — scans, ~10-20s)
--    Uncomment if you want it; heavier than the above.
-- SELECT year(ts_utc) AS yr, count(DISTINCT symbol) AS syms, count(*) AS bars
-- FROM read_parquet(getvariable('minute')) GROUP BY 1 ORDER BY 1;
