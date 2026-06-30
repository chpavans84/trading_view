-- HOLD-vs-SELL exit rule accuracy, per stock. NDX100 + S&P500, lake consolidated 2021-2026.
-- Rule: after UP breakout (new 20d high, level=hi20) HOLD while close>=level, SELL first close<level.
--       after DOWN breakout (new 20d low, level=lo20) mirror (short: cover first close>level).
-- Horizon 10 trading days. "rule_correct" = rule beat naive hold-to-10 (when it sold) OR held to profit.
INSTALL postgres; LOAD postgres; ATTACH '__DBURL__' AS pg (TYPE POSTGRES);

CREATE TEMP TABLE base AS
SELECT m.symbol, m.d, m.close::double AS close, m.volume::double AS volume
FROM read_parquet('/Volumes/Archive/silver/market_bars_daily/**/*.parquet') m
JOIN (SELECT symbol FROM pg.public.index_membership WHERE in_sp500 OR in_ndx100) ix USING(symbol)
WHERE m.d >= DATE '2021-01-01' AND m.close IS NOT NULL AND m.volume IS NOT NULL;

CREATE TEMP TABLE feat AS
SELECT *,
  MAX(close) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS hi20,
  MIN(close) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS lo20,
  (close > MAX(close) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)) AS nh,
  (close < MIN(close) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)) AS nl,
  list(close) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN 1 FOLLOWING AND 10 FOLLOWING) AS fwd
FROM base;

CREATE TEMP TABLE marked AS
SELECT *, LAG(nh) OVER (PARTITION BY symbol ORDER BY d) AS prev_nh,
          LAG(nl) OVER (PARTITION BY symbol ORDER BY d) AS prev_nl
FROM feat;

CREATE TEMP TABLE ev AS
WITH e AS (
  SELECT symbol, d, close AS c0,
    CASE WHEN nh THEN 'UP' ELSE 'DOWN' END AS dir,
    CASE WHEN nh THEN hi20 ELSE lo20 END   AS lvl,
    nh, fwd,
    fwd[10] AS f10,
    CASE WHEN nh THEN list_filter(fwd, x -> x < hi20)
                 ELSE list_filter(fwd, x -> x > lo20) END AS reclaim
  FROM marked
  WHERE (nh AND NOT COALESCE(prev_nh,false)) OR (nl AND NOT COALESCE(prev_nl,false))
    AND len(fwd) = 10
)
SELECT symbol, d, dir, c0, lvl, f10,
  (len(reclaim) > 0) AS broke,
  CASE WHEN len(reclaim) > 0 THEN reclaim[1] ELSE f10 END AS exit_px,
  -- directional returns (DOWN = short)
  CASE WHEN dir='UP' THEN 100.0*((CASE WHEN len(reclaim)>0 THEN reclaim[1] ELSE f10 END)-c0)/c0
       ELSE              100.0*(c0-(CASE WHEN len(reclaim)>0 THEN reclaim[1] ELSE f10 END))/c0 END AS rule_ret,
  CASE WHEN dir='UP' THEN 100.0*(f10-c0)/c0 ELSE 100.0*(c0-f10)/c0 END AS hold_ret
FROM e;

CREATE TEMP TABLE scored AS
SELECT *,
  CASE WHEN broke THEN (rule_ret >= hold_ret)   -- the sell beat (or matched) holding
       ELSE (hold_ret > 0) END AS rule_correct   -- held to profit
FROM ev;

.print '\n===== (1) AGGREGATE: exit-rule accuracy + realized returns, by direction ====='
SELECT dir, count(*) AS events,
  round(100.0*avg(broke::int),0)         AS pct_broke_level,
  round(100.0*avg(rule_correct::int),1)  AS rule_accuracy_pct,
  round(avg(rule_ret),2)                 AS avg_rule_ret,
  round(avg(hold_ret),2)                 AS avg_hold_ret
FROM scored GROUP BY dir ORDER BY dir;

.print '\n===== (2) PER-STOCK accuracy distribution (>=30 events), UP breakouts ====='
WITH ps AS (
  SELECT symbol, count(*) n, 100.0*avg(rule_correct::int) acc
  FROM scored WHERE dir='UP' GROUP BY symbol HAVING count(*) >= 30)
SELECT CASE WHEN acc>=90 THEN 'a) >=90%' WHEN acc>=80 THEN 'b) 80-90%'
            WHEN acc>=70 THEN 'c) 70-80%' WHEN acc>=60 THEN 'd) 60-70%'
            ELSE 'e) <60%' END AS accuracy_band,
       count(*) AS num_stocks
FROM ps GROUP BY 1 ORDER BY 1;

.print '\n===== (3) Stocks where the UP exit-rule is MOST accurate (>=30 events) ====='
SELECT symbol, count(*) n, round(100.0*avg(rule_correct::int),1) accuracy_pct,
       round(avg(rule_ret),2) avg_rule_ret, round(avg(hold_ret),2) avg_hold_ret
FROM scored WHERE dir='UP' GROUP BY symbol HAVING count(*)>=30
ORDER BY accuracy_pct DESC LIMIT 15;

.print '\n===== (4) NVDA / MSFT / big-tech: exit-rule accuracy at stock level ====='
SELECT symbol, dir, count(*) n, round(100.0*avg(rule_correct::int),1) accuracy_pct,
       round(100.0*avg(broke::int),0) pct_broke, round(avg(rule_ret),2) avg_rule_ret,
       round(avg(hold_ret),2) avg_hold_ret
FROM scored WHERE symbol IN ('NVDA','MSFT','AAPL','TSLA','META','AMZN','GOOGL','AMD','AVGO')
GROUP BY symbol, dir ORDER BY symbol, dir;
