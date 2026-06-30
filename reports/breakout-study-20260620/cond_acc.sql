INSTALL postgres; LOAD postgres; ATTACH 'postgresql://localhost/tradingbot' AS pg (TYPE POSTGRES);
CREATE TEMP TABLE base AS
SELECT m.symbol,m.d,m.close::double AS px FROM read_parquet('/Volumes/Archive/silver/market_bars_daily/**/*.parquet') m
JOIN (SELECT symbol FROM pg.public.index_membership WHERE in_sp500 OR in_ndx100) ix USING(symbol)
WHERE m.d>=DATE '2021-01-01' AND m.close IS NOT NULL;
CREATE TEMP TABLE feat AS SELECT *,
 MAX(px) OVER(PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) hi20,
 MIN(px) OVER(PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) lo20,
 (px>MAX(px) OVER(PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)) nh,
 (px<MIN(px) OVER(PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)) nl,
 list(px) OVER(PARTITION BY symbol ORDER BY d ROWS BETWEEN 1 FOLLOWING AND 10 FOLLOWING) fwd
FROM base;
CREATE TEMP TABLE mk AS SELECT *, LAG(nh) OVER(PARTITION BY symbol ORDER BY d) pnh, LAG(nl) OVER(PARTITION BY symbol ORDER BY d) pnl FROM feat;
CREATE TEMP TABLE ev AS
SELECT symbol, CASE WHEN nh THEN 'UP' ELSE 'DOWN' END dir, px AS c0, fwd[10] f10,
 (CASE WHEN nh THEN len(list_filter(fwd, lambda x: x<hi20)) ELSE len(list_filter(fwd, lambda x: x>lo20)) END)>0 AS broke,
 CASE WHEN nh THEN 100.0*(fwd[10]-px)/px ELSE 100.0*(px-fwd[10])/px END AS hold_ret
FROM mk WHERE ((nh AND NOT COALESCE(pnh,false)) OR (nl AND NOT COALESCE(pnl,false))) AND len(fwd)=10;

.print '===== HOLD-signal vs SELL-signal reliability (aggregate) ====='
SELECT dir,
  count(*) FILTER(WHERE NOT broke) AS hold_signals,
  round(100.0*avg(CASE WHEN NOT broke THEN (hold_ret>0)::int END),1) AS hold_reliability_pct,
  count(*) FILTER(WHERE broke) AS sell_signals,
  round(100.0*avg(CASE WHEN broke THEN (hold_ret<0)::int END),1) AS sell_reliability_pct
FROM ev GROUP BY dir ORDER BY dir;

.print '\n===== Per-stock: how many reach >=90% on each side (UP, >=30 signals) ====='
WITH h AS (SELECT symbol, 100.0*avg((hold_ret>0)::int) acc FROM ev WHERE dir='UP' AND NOT broke GROUP BY symbol HAVING count(*)>=30),
     s AS (SELECT symbol, 100.0*avg((hold_ret<0)::int) acc FROM ev WHERE dir='UP' AND broke GROUP BY symbol HAVING count(*)>=30)
SELECT 'HOLD side' side, count(*) FILTER(WHERE acc>=90) stocks_ge90, count(*) FILTER(WHERE acc>=80) stocks_ge80, count(*) total FROM h
UNION ALL SELECT 'SELL side', count(*) FILTER(WHERE acc>=90), count(*) FILTER(WHERE acc>=80), count(*) FROM s;

.print '\n===== Top HOLD-reliable stocks (UP): when they hold the level 10d, they end positive ====='
SELECT symbol, count(*) hold_signals, round(100.0*avg((hold_ret>0)::int),1) hold_reliability_pct
FROM ev WHERE dir='UP' AND NOT broke GROUP BY symbol HAVING count(*)>=30 ORDER BY 3 DESC LIMIT 12;
