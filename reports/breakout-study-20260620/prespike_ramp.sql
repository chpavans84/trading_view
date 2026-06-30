\set ON_ERROR_STOP on
-- PRE-SPIKE RAMP: for each >=5% spike (NDX100+SP500, UW window), look at the 5 trading
-- days BEFORE the spike. Does volume building + bullish flow accumulating BEFORE the move
-- predict which spikes sustain vs fade? Outcome = 3-day fwd return after the spike.

-- Daily panel: every trading day per index symbol, with volume + UW directional premium.
CREATE TEMP TABLE panel AS
SELECT bp.symbol, bp.price_date, bp.close::float AS close, bp.volume::float AS volume,
       COALESCE(u.bull_prem,0) AS bull_prem,
       COALESCE(u.dir_prem,0)  AS dir_prem
FROM backtest_prices bp
JOIN index_membership ix ON ix.symbol=bp.symbol AND (ix.in_sp500 OR ix.in_ndx100)
LEFT JOIN (
  SELECT ticker AS symbol, alerted_at::date AS d,
         SUM(premium) FILTER (WHERE sentiment='bullish')                AS bull_prem,
         SUM(premium) FILTER (WHERE sentiment IN ('bullish','bearish')) AS dir_prem
  FROM uw_flow_alerts GROUP BY 1,2
) u ON u.symbol=bp.symbol AND u.d=bp.price_date
WHERE bp.price_date >= DATE '2026-04-01';

-- Window features per symbol over trading-day rows.
CREATE TEMP TABLE feat AS
SELECT symbol, price_date, close, volume,
       LAG(close,1) OVER w AS c_prev,
       LAG(close,6) OVER w AS c_t6,
       LEAD(close,3) OVER w AS c_p3,
       AVG(volume) OVER (PARTITION BY symbol ORDER BY price_date ROWS BETWEEN  5 PRECEDING AND 1 PRECEDING) AS pre5_vol,
       AVG(volume) OVER (PARTITION BY symbol ORDER BY price_date ROWS BETWEEN 30 PRECEDING AND 6 PRECEDING) AS base_vol,
       SUM(bull_prem) OVER (PARTITION BY symbol ORDER BY price_date ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) AS pre5_bull,
       SUM(dir_prem)  OVER (PARTITION BY symbol ORDER BY price_date ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) AS pre5_dir
FROM panel
WINDOW w AS (PARTITION BY symbol ORDER BY price_date);

CREATE TEMP TABLE ev AS
SELECT symbol, price_date,
       100.0*(close-c_prev)/c_prev                  AS day_chg,
       100.0*(c_p3-close)/close                     AS ret_p3,
       pre5_vol/NULLIF(base_vol,0)                  AS vol_ramp,   -- >1 = volume building IN
       100.0*(c_prev-c_t6)/NULLIF(c_t6,0)           AS pre5_drift, -- price move the 5d before spike
       100.0*pre5_bull/NULLIF(pre5_dir,0)           AS pre5_bull_pct,
       pre5_dir
FROM feat
WHERE price_date >= DATE '2026-05-19'
  AND c_prev IS NOT NULL AND base_vol IS NOT NULL
  AND 100.0*(close-c_prev)/c_prev >= 5.0;

\echo '\n===== coverage ====='
SELECT count(*) AS spikes, count(*) FILTER (WHERE ret_p3 IS NOT NULL) AS with_fwd3,
       count(*) FILTER (WHERE pre5_dir >= 50000) AS with_real_preflow
FROM ev;

\echo '\n===== (A) PRE-SPIKE VOLUME RAMP vs outcome (was volume already building before the spike?) ====='
SELECT CASE WHEN vol_ramp IS NULL THEN 'n/a'
            WHEN vol_ramp < 0.9 THEN 'a) <0.9x (quiet/declining into spike)'
            WHEN vol_ramp < 1.3 THEN 'b) 0.9-1.3x (flat)'
            ELSE                     'c) >=1.3x (volume building in)' END AS pre_vol_ramp,
       count(*) n, round(avg(day_chg)::numeric,1) avg_spike,
       round(avg(ret_p3)::numeric,2) avg_ret_3d,
       round(100.0*avg((ret_p3<0)::int)::numeric,0) pct_faded
FROM ev WHERE ret_p3 IS NOT NULL GROUP BY 1 ORDER BY 1;

\echo '\n===== (B) PRE-SPIKE BULLISH FLOW vs outcome (smart-money positioning BEFORE the move) ====='
\echo '      (only spikes with real pre-spike directional flow: pre5_dir >= $50k)'
SELECT CASE WHEN pre5_bull_pct < 40 THEN 'a) <40% (flow NOT bullish pre-spike)'
            WHEN pre5_bull_pct < 60 THEN 'b) 40-60% (mixed)'
            WHEN pre5_bull_pct < 80 THEN 'c) 60-80% (bullish)'
            ELSE                       'd) >=80% (very bullish pre-spike)' END AS pre_bull_bucket,
       count(*) n, round(avg(day_chg)::numeric,1) avg_spike,
       round(avg(ret_p3)::numeric,2) avg_ret_3d,
       round(100.0*avg((ret_p3<0)::int)::numeric,0) pct_faded
FROM ev WHERE ret_p3 IS NOT NULL AND pre5_dir >= 50000 GROUP BY 1 ORDER BY 1;

\echo '\n===== (C) PRE-SPIKE PRICE DRIFT vs outcome (did it climb in quietly, or spike from flat?) ====='
SELECT CASE WHEN pre5_drift < -3 THEN 'a) <-3% (fell into spike)'
            WHEN pre5_drift <  3 THEN 'b) -3..+3% (flat base)'
            WHEN pre5_drift < 8  THEN 'c) +3..+8% (already climbing)'
            ELSE                     'd) >=+8% (already extended)' END AS pre_drift_bucket,
       count(*) n, round(avg(day_chg)::numeric,1) avg_spike,
       round(avg(ret_p3)::numeric,2) avg_ret_3d,
       round(100.0*avg((ret_p3<0)::int)::numeric,0) pct_faded
FROM ev WHERE ret_p3 IS NOT NULL GROUP BY 1 ORDER BY 1;

\echo '\n===== (D) BEST COMBO: volume building IN  +  bullish flow pre-spike ====='
SELECT (vol_ramp >= 1.3)                       AS vol_building_in,
       (pre5_bull_pct >= 60 AND pre5_dir>=50000) AS bullish_preflow,
       count(*) n, round(avg(ret_p3)::numeric,2) avg_ret_3d,
       round(100.0*avg((ret_p3<0)::int)::numeric,0) pct_faded
FROM ev WHERE ret_p3 IS NOT NULL GROUP BY 1,2 ORDER BY 1 DESC,2 DESC;

\echo '\n===== (E) NVDA/MSFT/big-tech: pre-spike setup vs outcome ====='
SELECT symbol, price_date, round(day_chg::numeric,1) spike,
       round(vol_ramp::numeric,2) pre_vol_ramp,
       round(pre5_drift::numeric,1) pre5_drift,
       round(pre5_bull_pct::numeric,0) pre5_bull_pct,
       round(ret_p3::numeric,1) ret_3d
FROM ev WHERE symbol IN ('NVDA','MSFT','AAPL','TSLA','META','AMZN','GOOGL','AMD','AVGO')
ORDER BY symbol, price_date;
