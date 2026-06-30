-- Candidate setups, evaluated per regime with dispersion (p10/p90) for risk design
CREATE OR REPLACE TABLE setups AS
SELECT regime,
  CASE
    WHEN dist_sma200 > 0 AND dist_52whigh > -0.15 AND ret_5d BETWEEN -0.08 AND -0.02
         AND rvol < 2 THEN 'A_uptrend_pullback'
    WHEN dist_52whigh >= -0.02 AND ret_5d BETWEEN 0.02 AND 0.06 AND rvol BETWEEN 1 AND 2.5
         THEN 'B_orderly_breakout'
    WHEN ret_5d < -0.10 AND dist_sma200 > -0.10 AND vol_20d < 0.80
         THEN 'C_crash_rebound'
    WHEN rvol >= 3 AND ret_5d > 0.05 THEN 'X_bot_spike_chase'
    ELSE NULL END AS setup,
  fwd_ret_5d, fwd_ret_10d, ex5, ex10
FROM u WHERE setup IS NOT NULL;

SELECT setup, regime, COUNT(*) n,
  ROUND(100*AVG(CASE WHEN fwd_ret_5d>0 THEN 1 ELSE 0 END),1) win5,
  ROUND(100*AVG(ex5),2)  avg_ex5,
  ROUND(100*MEDIAN(ex5),2) med_ex5,
  ROUND(100*QUANTILE_CONT(fwd_ret_5d, 0.10),2) p10_fwd5,
  ROUND(100*QUANTILE_CONT(fwd_ret_5d, 0.90),2) p90_fwd5,
  ROUND(100*AVG(ex10),2) avg_ex10
FROM setups GROUP BY 1,2 HAVING COUNT(*) >= 300 ORDER BY 1,2;
