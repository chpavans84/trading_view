-- Universe: bot-like liquidity (ADV >= $5M, price >= $5), joined to regime by date
CREATE OR REPLACE VIEW u AS
SELECT f.*, r.regime, r.spy_fwd_5d, r.spy_fwd_10d,
       f.fwd_ret_5d - r.spy_fwd_5d  AS ex5,
       f.fwd_ret_10d - r.spy_fwd_10d AS ex10
FROM read_parquet('/Volumes/Archive/gold/features_daily/**/*.parquet') f
JOIN regimes r ON f.d = r.d
WHERE f.adv20 >= 5e6 AND f.close >= 5
  AND f.fwd_ret_5d IS NOT NULL AND f.fwd_ret_5d BETWEEN -0.9 AND 3.0;  -- clip data errors

-- A. Distance from 52w high
CREATE OR REPLACE TABLE bkt_52w AS
SELECT regime,
  CASE WHEN dist_52whigh >= -0.02 THEN 'a_at_high(0..-2%)'
       WHEN dist_52whigh >= -0.05 THEN 'b_near(-2..-5%)'
       WHEN dist_52whigh >= -0.10 THEN 'c_(-5..-10%)'
       WHEN dist_52whigh >= -0.20 THEN 'd_(-10..-20%)'
       WHEN dist_52whigh >= -0.40 THEN 'e_(-20..-40%)'
       ELSE 'f_deep(<-40%)' END AS bucket,
  COUNT(*) n,
  ROUND(100*AVG(CASE WHEN fwd_ret_5d>0 THEN 1 ELSE 0 END),1) win5,
  ROUND(100*AVG(ex5),3)  avg_ex5,
  ROUND(100*MEDIAN(ex5),3) med_ex5,
  ROUND(100*AVG(ex10),3) avg_ex10
FROM u GROUP BY 1,2;
COPY bkt_52w TO 'bkt_52w.csv' (HEADER);

-- B. 5-day momentum at entry (the chasing test)
CREATE OR REPLACE TABLE bkt_mom AS
SELECT regime,
  CASE WHEN ret_5d < -0.10 THEN 'a_crash(<-10%)'
       WHEN ret_5d < -0.05 THEN 'b_down(-10..-5%)'
       WHEN ret_5d < -0.02 THEN 'c_dip(-5..-2%)'
       WHEN ret_5d <  0.02 THEN 'd_flat(±2%)'
       WHEN ret_5d <  0.05 THEN 'e_up(2..5%)'
       WHEN ret_5d <  0.10 THEN 'f_hot(5..10%)'
       ELSE 'g_parabolic(>10%)' END AS bucket,
  COUNT(*) n,
  ROUND(100*AVG(CASE WHEN fwd_ret_5d>0 THEN 1 ELSE 0 END),1) win5,
  ROUND(100*AVG(ex5),3) avg_ex5,
  ROUND(100*MEDIAN(ex5),3) med_ex5,
  ROUND(100*AVG(ex10),3) avg_ex10
FROM u GROUP BY 1,2;
COPY bkt_mom TO 'bkt_mom.csv' (HEADER);

-- C. RVOL x direction (high-volume chase test)
CREATE OR REPLACE TABLE bkt_rvol AS
SELECT regime,
  CASE WHEN rvol >= 3 AND ret_5d > 0.05  THEN 'spike_up'
       WHEN rvol >= 3 AND ret_5d < -0.05 THEN 'spike_down'
       WHEN rvol BETWEEN 1 AND 2 AND ABS(ret_5d) <= 0.02 THEN 'quiet_flat'
       ELSE 'other' END AS bucket,
  COUNT(*) n,
  ROUND(100*AVG(CASE WHEN fwd_ret_5d>0 THEN 1 ELSE 0 END),1) win5,
  ROUND(100*AVG(ex5),3) avg_ex5, ROUND(100*MEDIAN(ex5),3) med_ex5
FROM u GROUP BY 1,2;
COPY bkt_rvol TO 'bkt_rvol.csv' (HEADER);

-- D. Pullback vs extension (dist from SMA50, only uptrend stocks: above SMA200)
CREATE OR REPLACE TABLE bkt_pullback AS
SELECT regime,
  CASE WHEN dist_sma50 < -0.15 THEN 'a_broken(<-15%)'
       WHEN dist_sma50 < -0.08 THEN 'b_deep_pb(-15..-8%)'
       WHEN dist_sma50 < -0.03 THEN 'c_pullback(-8..-3%)'
       WHEN dist_sma50 <  0.03 THEN 'd_at_ma(±3%)'
       WHEN dist_sma50 <  0.08 THEN 'e_above(3..8%)'
       WHEN dist_sma50 <  0.15 THEN 'f_extended(8..15%)'
       ELSE 'g_parabolic(>15%)' END AS bucket,
  COUNT(*) n,
  ROUND(100*AVG(CASE WHEN fwd_ret_5d>0 THEN 1 ELSE 0 END),1) win5,
  ROUND(100*AVG(ex5),3) avg_ex5, ROUND(100*MEDIAN(ex5),3) med_ex5,
  ROUND(100*AVG(ex10),3) avg_ex10
FROM u WHERE dist_sma200 > 0 GROUP BY 1,2;
COPY bkt_pullback TO 'bkt_pullback.csv' (HEADER);

SELECT 'universe rows' k, COUNT(*) v FROM u;
