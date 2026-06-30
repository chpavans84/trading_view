CREATE OR REPLACE TABLE spy AS
WITH base AS (
  SELECT d, close, ln(close / LAG(close) OVER (ORDER BY d)) AS lr
  FROM read_parquet('/Volumes/Archive/silver/market_bars_daily_adj/**/*.parquet')
  WHERE symbol = 'SPY'
)
SELECT d, close,
  AVG(close)  OVER (ORDER BY d ROWS BETWEEN 199 PRECEDING AND CURRENT ROW) AS sma200,
  STDDEV(lr)  OVER (ORDER BY d ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) * sqrt(252) AS rvol20,
  LEAD(close, 5)  OVER (ORDER BY d) / close - 1 AS spy_fwd_5d,
  LEAD(close, 10) OVER (ORDER BY d) / close - 1 AS spy_fwd_10d
FROM base ORDER BY d;

CREATE OR REPLACE TABLE regimes AS
SELECT d, close, sma200, rvol20, spy_fwd_5d, spy_fwd_10d,
  CASE
    WHEN close >= sma200 AND rvol20 < 0.20 THEN 'R1_up_calm'
    WHEN close >= sma200 AND rvol20 >= 0.20 THEN 'R2_up_vol'
    WHEN close <  sma200 AND rvol20 < 0.25 THEN 'R3_down_calm'
    ELSE 'R4_down_vol'
  END AS regime
FROM spy WHERE sma200 IS NOT NULL;

COPY regimes TO 'regimes_daily.csv' (HEADER);

SELECT strftime(d, '%Y-%m') AS month, regime, COUNT(*) AS days,
       ROUND(100 * AVG(spy_fwd_5d), 2) AS avg_spy_fwd5_pct
FROM regimes
WHERE strftime(d, '%Y-%m') IN ('2026-04','2026-05','2026-06','2022-04','2022-09','2020-03','2020-04')
GROUP BY 1, 2 ORDER BY 1, 2;

SELECT regime, COUNT(*) AS days, ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct_decade,
       ROUND(100 * AVG(spy_fwd_5d), 3) AS avg_spy_fwd5_pct,
       ROUND(100 * AVG(CASE WHEN spy_fwd_5d > 0 THEN 1 ELSE 0 END), 1) AS spy_up_pct
FROM regimes GROUP BY 1 ORDER BY 1;
