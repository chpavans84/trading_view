INSTALL postgres; LOAD postgres; ATTACH '__DBURL__' AS pg (TYPE POSTGRES);
CREATE TEMP TABLE base AS
SELECT m.symbol,m.d,m.close::double AS px,m.volume::double AS vol
FROM read_parquet('/Volumes/Archive/silver/market_bars_daily/**/*.parquet') m
JOIN (SELECT symbol FROM pg.public.index_membership WHERE in_sp500 OR in_ndx100) ix USING(symbol)
WHERE m.d>=DATE '2021-01-01' AND m.close IS NOT NULL AND m.volume IS NOT NULL;
CREATE TEMP TABLE feat AS SELECT *,
 MAX(px) OVER(PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) hi20,
 (px>MAX(px) OVER(PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)) nh,
 vol/NULLIF(AVG(vol) OVER(PARTITION BY symbol ORDER BY d ROWS BETWEEN 50 PRECEDING AND 1 PRECEDING),0) rvol_day,
 list(px) OVER(PARTITION BY symbol ORDER BY d ROWS BETWEEN 1 FOLLOWING AND 10 FOLLOWING) fwd
FROM base;
CREATE TEMP TABLE ev AS
SELECT symbol, EXTRACT(year FROM d) yr, px AS c0, hi20 AS L, rvol_day, fwd, fwd[10] f10,
 list_position(list_transform(fwd, lambda x: x<hi20), true)                                  AS i_base,
 list_position(list_transform(fwd, lambda x,i: i>1 AND x<hi20 AND fwd[i-1]<hi20), true)       AS i_conf2,
 list_position(list_transform(fwd, lambda x: x<hi20*0.98), true)                             AS i_buf2,
 list_position(list_transform(fwd, lambda x: x<hi20*0.97), true)                             AS i_buf3
FROM feat
WHERE nh AND NOT COALESCE(LAG(nh) OVER(PARTITION BY symbol ORDER BY d),false) AND len(fwd)=10;

.print '===== (1) HOLD reliability by YEAR (UP) — does 91% survive the 2022 bear? ====='
SELECT yr,
  count(*) FILTER(WHERE i_base IS NULL) AS hold_signals,
  round(100.0*avg(CASE WHEN i_base IS NULL THEN (100.0*(f10-c0)/c0>0)::int END),1) AS hold_reliability_pct
FROM ev GROUP BY yr ORDER BY yr;

.print '\n===== (2) SELL-trigger variants (UP, all years) — can we beat the 65% / improve return? ====='
WITH x AS (
 SELECT *,
   100.0*(f10-c0)/c0 AS hold_ret,
   100.0*((CASE WHEN i_base  IS NULL THEN f10 ELSE fwd[i_base]  END)-c0)/c0 AS ret_base,
   100.0*((CASE WHEN i_conf2 IS NULL THEN f10 ELSE fwd[i_conf2] END)-c0)/c0 AS ret_conf2,
   100.0*((CASE WHEN i_buf2  IS NULL THEN f10 ELSE fwd[i_buf2]  END)-c0)/c0 AS ret_buf2,
   100.0*((CASE WHEN i_buf3  IS NULL THEN f10 ELSE fwd[i_buf3]  END)-c0)/c0 AS ret_buf3
 FROM ev)
SELECT 'baseline: first close < level' variant,
  count(*) FILTER(WHERE i_base IS NOT NULL) fired,
  round(100.0*avg(CASE WHEN i_base IS NOT NULL THEN ( (CASE WHEN i_base IS NULL THEN f10 ELSE fwd[i_base] END) > f10)::int END),1) sell_reliab_pct,
  round(avg(ret_base),3) avg_rule_ret, round(avg(hold_ret),3) avg_hold_ret FROM x
UNION ALL SELECT '2-day confirmation (2 closes < level)',
  count(*) FILTER(WHERE i_conf2 IS NOT NULL),
  round(100.0*avg(CASE WHEN i_conf2 IS NOT NULL THEN ((CASE WHEN i_conf2 IS NULL THEN f10 ELSE fwd[i_conf2] END) > f10)::int END),1),
  round(avg(ret_conf2),3), round(avg(hold_ret),3) FROM x
UNION ALL SELECT 'buffer 2% (close < level*0.98)',
  count(*) FILTER(WHERE i_buf2 IS NOT NULL),
  round(100.0*avg(CASE WHEN i_buf2 IS NOT NULL THEN ((CASE WHEN i_buf2 IS NULL THEN f10 ELSE fwd[i_buf2] END) > f10)::int END),1),
  round(avg(ret_buf2),3), round(avg(hold_ret),3) FROM x
UNION ALL SELECT 'buffer 3% (close < level*0.97)',
  count(*) FILTER(WHERE i_buf3 IS NOT NULL),
  round(100.0*avg(CASE WHEN i_buf3 IS NOT NULL THEN ((CASE WHEN i_buf3 IS NULL THEN f10 ELSE fwd[i_buf3] END) > f10)::int END),1),
  round(avg(ret_buf3),3), round(avg(hold_ret),3) FROM x;

.print '\n===== (3) Entry filtered to breakout-day RVOL >= 2.5x (UP) — cleaner hold/sell? ====='
SELECT CASE WHEN rvol_day>=2.5 THEN 'b) heavy-vol breakout (>=2.5x)' ELSE 'a) all breakouts' END grp,
  count(*) n,
  round(100.0*avg(CASE WHEN i_base IS NULL THEN (100.0*(f10-c0)/c0>0)::int END) FILTER(WHERE i_base IS NULL),1) hold_reliab_pct,
  round(100.0*avg(CASE WHEN i_base IS NOT NULL THEN (100.0*(f10-c0)/c0<0)::int END) FILTER(WHERE i_base IS NOT NULL),1) sell_loser_pct
FROM ev GROUP BY ROLLUP(1) HAVING grp IS NOT NULL ORDER BY 1;
