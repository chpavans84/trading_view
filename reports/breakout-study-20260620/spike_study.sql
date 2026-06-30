\set ON_ERROR_STOP on
-- Spike study: NDX100 + S&P500, last month (UW coverage starts 2026-05-19).
-- Volume now clean (lake-synced). Question: do genuine RVOL surges + UW bullish flow
-- distinguish real (sustained) spikes from quick fades (NVDA/MSFT pattern)?

CREATE TEMP TABLE px AS
SELECT bp.symbol, bp.price_date, bp.close::float AS close, bp.volume::float AS volume,
       LAG(bp.close) OVER w AS prev_close,
       AVG(bp.volume) OVER (PARTITION BY bp.symbol ORDER BY bp.price_date
                            ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS avg_vol_30d_prior,
       LEAD(bp.close,3) OVER w AS close_p3,
       LEAD(bp.close,5) OVER w AS close_p5
FROM backtest_prices bp
JOIN index_membership u ON u.symbol = bp.symbol AND (u.in_sp500 OR u.in_ndx100)
WHERE bp.price_date >= DATE '2026-04-01'
WINDOW w AS (PARTITION BY bp.symbol ORDER BY bp.price_date);

CREATE TEMP TABLE uw AS
SELECT ticker AS symbol, alerted_at::date AS d,
       SUM(premium) FILTER (WHERE sentiment='bullish')                AS bull_prem,
       SUM(premium) FILTER (WHERE sentiment IN ('bullish','bearish')) AS dir_prem,
       COUNT(*)                                                       AS alert_cnt
FROM uw_flow_alerts
GROUP BY 1,2;

-- Spike events: >=5% up day, with clean volume + 30d avg available.
CREATE TEMP TABLE spikes AS
SELECT p.symbol, p.price_date,
       100.0*(p.close-p.prev_close)/p.prev_close                         AS day_chg_pct,
       p.volume/NULLIF(p.avg_vol_30d_prior,0)                            AS rvol,
       100.0*(p.close_p3-p.close)/p.close                               AS ret_p3,
       100.0*(p.close_p5-p.close)/p.close                               AS ret_p5,
       100.0*u.bull_prem/NULLIF(u.dir_prem,0)                           AS uw_bull_pct,
       u.dir_prem
FROM px p
LEFT JOIN uw u ON u.symbol=p.symbol AND u.d=p.price_date
WHERE p.price_date >= DATE '2026-05-19'
  AND p.prev_close IS NOT NULL AND p.volume IS NOT NULL
  AND p.avg_vol_30d_prior IS NOT NULL
  AND 100.0*(p.close-p.prev_close)/p.prev_close >= 5.0;

\echo '\n========== (1) HOW MANY SPIKE EVENTS =========='
SELECT count(*) AS spike_events,
       count(*) FILTER (WHERE ret_p3 IS NOT NULL) AS with_fwd3,
       count(*) FILTER (WHERE uw_bull_pct IS NOT NULL) AS with_uw,
       round(avg(day_chg_pct)::numeric,1) AS avg_spike_pct
FROM spikes;

\echo '\n========== (2) RVOL vs OUTCOME — does a real volume surge mean the spike sticks? =========='
SELECT CASE WHEN rvol IS NULL THEN 'n/a'
            WHEN rvol < 1.5 THEN 'a) <1.5x (no surge)'
            WHEN rvol < 3   THEN 'b) 1.5-3x'
            ELSE                 'c) >=3x (big surge)' END AS rvol_bucket,
       count(*) AS n,
       round(avg(day_chg_pct)::numeric,1)        AS avg_spike,
       round(avg(ret_p3)::numeric,2)             AS avg_ret_3d,
       round(avg(ret_p5)::numeric,2)             AS avg_ret_5d,
       round(100.0*avg((ret_p3<0)::int)::numeric,0) AS pct_faded_3d
FROM spikes WHERE ret_p3 IS NOT NULL
GROUP BY 1 ORDER BY 1;

\echo '\n========== (3) UW BULLISH % vs OUTCOME — is UW bullish flow accountable? =========='
SELECT CASE WHEN uw_bull_pct IS NULL THEN 'z) no UW flow'
            WHEN uw_bull_pct < 40 THEN 'a) <40% (bearish-leaning)'
            WHEN uw_bull_pct < 60 THEN 'b) 40-60% (mixed)'
            WHEN uw_bull_pct < 80 THEN 'c) 60-80% (bullish)'
            ELSE                       'd) >=80% (very bullish)' END AS uw_bucket,
       count(*) AS n,
       round(avg(day_chg_pct)::numeric,1)        AS avg_spike,
       round(avg(ret_p3)::numeric,2)             AS avg_ret_3d,
       round(100.0*avg((ret_p3<0)::int)::numeric,0) AS pct_faded_3d
FROM spikes WHERE ret_p3 IS NOT NULL
GROUP BY 1 ORDER BY 1;

\echo '\n========== (4) NVDA / MSFT / big-tech spike days specifically =========='
SELECT symbol, price_date, round(day_chg_pct::numeric,1) AS spike_pct,
       round(rvol::numeric,2) AS rvol,
       round(uw_bull_pct::numeric,0) AS uw_bull_pct,
       round(ret_p3::numeric,1) AS ret_3d,
       CASE WHEN ret_p3 < 0 THEN 'FADED' WHEN ret_p3 IS NULL THEN '(pending)' ELSE 'held' END AS outcome
FROM spikes
WHERE symbol IN ('NVDA','MSFT','AAPL','TSLA','META','AMZN','GOOGL','AMD','AVGO')
ORDER BY symbol, price_date;

\echo '\n========== (5) Top 15 biggest spikes — raw evidence =========='
SELECT symbol, price_date, round(day_chg_pct::numeric,1) AS spike_pct,
       round(rvol::numeric,2) AS rvol,
       round(uw_bull_pct::numeric,0) AS uw_bull_pct,
       round(ret_p3::numeric,1) AS ret_3d
FROM spikes ORDER BY day_chg_pct DESC LIMIT 15;
