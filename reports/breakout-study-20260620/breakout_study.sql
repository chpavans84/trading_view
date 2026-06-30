-- BREAKOUT / FALSE-BREAKOUT volume study. NDX100 + S&P500. Lake consolidated volume 2021-2026.
-- Breakout = first close above prior-20d-high (UP) or below prior-20d-low (DOWN).
-- FALSE breakout (trap) = within next 5 days price closes back INSIDE the broken range.
-- Volume measured at the breakout day + trend over 1wk/2wk/1mo/2mo before it.
INSTALL postgres; LOAD postgres; ATTACH '__DBURL__' AS pg (TYPE POSTGRES);

CREATE TEMP TABLE base AS
SELECT m.symbol, m.d, m.close::double AS close, m.volume::double AS volume
FROM read_parquet('/Volumes/Archive/silver/market_bars_daily/**/*.parquet') m
JOIN (SELECT symbol FROM pg.public.index_membership WHERE in_sp500 OR in_ndx100) ix USING(symbol)
WHERE m.d >= DATE '2021-01-01' AND m.volume IS NOT NULL AND m.close IS NOT NULL;

CREATE TEMP TABLE feat AS
SELECT *,
  MAX(close) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS hi20,
  MIN(close) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS lo20,
  AVG(volume) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN 50 PRECEDING AND 1 PRECEDING) AS base50,
  AVG(volume) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN  5 PRECEDING AND 1 PRECEDING) AS v5,
  AVG(volume) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING) AS v10,
  AVG(volume) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN 21 PRECEDING AND 1 PRECEDING) AS v21,
  AVG(volume) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN 42 PRECEDING AND 1 PRECEDING) AS v42,
  MIN(close) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN 1 FOLLOWING AND 5 FOLLOWING) AS min_fwd5,
  MAX(close) OVER (PARTITION BY symbol ORDER BY d ROWS BETWEEN 1 FOLLOWING AND 5 FOLLOWING) AS max_fwd5,
  LEAD(close,10) OVER (PARTITION BY symbol ORDER BY d) AS c_f10,
  EXTRACT(year FROM d) AS yr
FROM base;

-- mark new-high / new-low + dedup to the FIRST day of each thrust (transition into breakout)
CREATE TEMP TABLE marked AS
SELECT *,
  (close > hi20) AS nh,
  (close < lo20) AS nl,
  LAG(close > hi20) OVER (PARTITION BY symbol ORDER BY d) AS prev_nh,
  LAG(close < lo20) OVER (PARTITION BY symbol ORDER BY d) AS prev_nl
FROM feat;

CREATE TEMP TABLE ev AS
SELECT symbol, d, yr, close,
  CASE WHEN nh AND NOT COALESCE(prev_nh,false) THEN 'UP'
       WHEN nl AND NOT COALESCE(prev_nl,false) THEN 'DOWN' END AS dir,
  CASE WHEN nh THEN hi20 ELSE lo20 END AS level,
  volume/NULLIF(base50,0) AS rvol_day,
  v5 /NULLIF(base50,0)    AS r_1wk,
  v10/NULLIF(base50,0)    AS r_2wk,
  v21/NULLIF(base50,0)    AS r_1mo,
  v42/NULLIF(base50,0)    AS r_2mo,
  100.0*(c_f10-close)/close AS fwd10,
  -- TRAP flag: broke out then closed back inside the range within 5 days
  CASE WHEN nh AND min_fwd5 < hi20 THEN true
       WHEN nl AND max_fwd5 > lo20 THEN true ELSE false END AS is_trap
FROM marked
WHERE (nh AND NOT COALESCE(prev_nh,false) OR nl AND NOT COALESCE(prev_nl,false))
  AND base50 IS NOT NULL AND c_f10 IS NOT NULL AND v42 IS NOT NULL;

.print '\n===== (1) BASE RATES: how often do breakouts fail (turn into traps)? ====='
SELECT dir, count(*) AS events,
       round(100.0*avg(is_trap::int),0) AS pct_false_trap,
       round(avg(fwd10),2) AS avg_fwd10,
       round(avg(CASE WHEN dir='UP' THEN fwd10 ELSE -fwd10 END),2) AS avg_directional_followthru
FROM ev GROUP BY dir ORDER BY dir;

.print '\n===== (2) VOLUME SIGNATURE — real vs FALSE breakout (avg relative volume) ====='
SELECT dir, CASE WHEN is_trap THEN 'FALSE (trap)' ELSE 'real' END AS kind, count(*) n,
  round(avg(rvol_day),2) AS breakout_day_rvol,
  round(avg(r_1wk),2) AS vol_1wk, round(avg(r_2wk),2) AS vol_2wk,
  round(avg(r_1mo),2) AS vol_1mo, round(avg(r_2mo),2) AS vol_2mo
FROM ev GROUP BY dir, is_trap ORDER BY dir, is_trap;

.print '\n===== (3) FALSE-BREAKOUT RATE by BREAKOUT-DAY volume (does volume confirm?) ====='
SELECT dir,
  CASE WHEN rvol_day < 1.0 THEN 'a) <1x (below avg)'
       WHEN rvol_day < 1.5 THEN 'b) 1-1.5x'
       WHEN rvol_day < 2.5 THEN 'c) 1.5-2.5x'
       ELSE                     'd) >=2.5x (heavy)' END AS breakout_vol,
  count(*) n, round(100.0*avg(is_trap::int),0) AS pct_false_trap,
  round(avg(CASE WHEN dir='UP' THEN fwd10 ELSE -fwd10 END),2) AS avg_followthru
FROM ev GROUP BY dir, breakout_vol ORDER BY dir, breakout_vol;

.print '\n===== (4) FALSE-BREAKOUT RATE by PRE-breakout volume TREND (1wk vs 2mo, rising into it?) ====='
SELECT dir,
  CASE WHEN r_1wk/NULLIF(r_2mo,0) < 0.85 THEN 'a) volume FALLING into breakout'
       WHEN r_1wk/NULLIF(r_2mo,0) < 1.15 THEN 'b) flat'
       ELSE                                   'c) volume RISING into breakout' END AS pre_vol_trend,
  count(*) n, round(100.0*avg(is_trap::int),0) AS pct_false_trap,
  round(avg(CASE WHEN dir='UP' THEN fwd10 ELSE -fwd10 END),2) AS avg_followthru
FROM ev GROUP BY dir, pre_vol_trend ORDER BY dir, pre_vol_trend;

.print '\n===== (5) REGIME CHECK: false-breakout rate by year (is the signal stable?) ====='
SELECT yr,
  round(100.0*avg(is_trap::int) FILTER (WHERE dir='UP'),0)   AS up_pct_false,
  round(100.0*avg(is_trap::int) FILTER (WHERE dir='DOWN'),0) AS down_pct_false,
  count(*) FILTER (WHERE dir='UP') AS up_n, count(*) FILTER (WHERE dir='DOWN') AS down_n
FROM ev GROUP BY yr ORDER BY yr;
