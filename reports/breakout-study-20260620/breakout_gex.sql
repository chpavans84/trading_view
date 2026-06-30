-- Breakout × dealer GEX. Does dealer gamma positioning predict real vs false breakouts?
-- Hypothesis: SHORT-gamma days (dealers amplify moves) -> breakouts sustain; LONG-gamma
-- (dealers suppress/mean-revert) -> breakouts fail. Window = GEX coverage (~1yr).
INSTALL postgres; LOAD postgres; ATTACH '__DBURL__' AS pg (TYPE POSTGRES);

CREATE TEMP TABLE base AS
SELECT m.symbol,m.d,m.close::double AS px,m.volume::double AS vol
FROM read_parquet('/Volumes/Archive/silver/market_bars_daily/**/*.parquet') m
JOIN (SELECT symbol FROM pg.public.index_membership WHERE in_sp500 OR in_ndx100) ix USING(symbol)
WHERE m.d >= DATE '2025-04-01' AND m.close IS NOT NULL AND m.volume IS NOT NULL;

CREATE TEMP TABLE feat AS SELECT *,
 MAX(px) OVER(PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) hi20,
 (px>MAX(px) OVER(PARTITION BY symbol ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)) nh,
 vol/NULLIF(AVG(vol) OVER(PARTITION BY symbol ORDER BY d ROWS BETWEEN 50 PRECEDING AND 1 PRECEDING),0) rvol,
 MIN(px) OVER(PARTITION BY symbol ORDER BY d ROWS BETWEEN 1 FOLLOWING AND 5 FOLLOWING) minf5,
 list(px) OVER(PARTITION BY symbol ORDER BY d ROWS BETWEEN 1 FOLLOWING AND 10 FOLLOWING) fwd
FROM base;
CREATE TEMP TABLE mk AS SELECT *, LAG(nh) OVER(PARTITION BY symbol ORDER BY d) pnh FROM feat;

-- per-ticker gamma percentile across its full 1yr GEX history
CREATE TEMP TABLE gexpct AS
SELECT symbol, date, net_gamma, net_delta,
  percent_rank() OVER (PARTITION BY symbol ORDER BY net_gamma) AS gamma_pct
FROM pg.public.uw_gex_history;

CREATE TEMP TABLE ev AS
SELECT k.symbol, k.d, k.px c0, k.hi20,
  (k.minf5 < k.hi20) AS is_trap,
  100.0*(k.fwd[10]-k.px)/k.px AS fwd10,
  k.rvol, g.net_gamma, g.gamma_pct
FROM mk k
JOIN gexpct g ON g.symbol=k.symbol AND g.date=k.d
WHERE k.nh AND NOT COALESCE(k.pnh,false) AND k.d >= DATE '2025-06-23' AND len(k.fwd)=10;

.print '===== (0) coverage ====='
SELECT count(*) up_breakouts_with_gex, round(100.0*avg(is_trap::int),0) overall_false_pct FROM ev;

.print '\n===== (1) FALSE-breakout rate by dealer GAMMA regime (per-ticker percentile) ====='
SELECT CASE WHEN gamma_pct < 0.33 THEN 'a) LOW gamma (short-gamma, amplify)'
            WHEN gamma_pct < 0.67 THEN 'b) mid'
            ELSE                       'c) HIGH gamma (long-gamma, suppress)' END AS gamma_regime,
  count(*) n, round(100.0*avg(is_trap::int),0) pct_false_trap,
  round(avg(fwd10),2) avg_fwd10
FROM ev GROUP BY 1 ORDER BY 1;

.print '\n===== (2) by net_gamma SIGN (dealers net long vs short gamma) ====='
SELECT CASE WHEN net_gamma < 0 THEN 'short gamma (net_gamma<0)' ELSE 'long gamma (net_gamma>=0)' END regime,
  count(*) n, round(100.0*avg(is_trap::int),0) pct_false_trap, round(avg(fwd10),2) avg_fwd10
FROM ev GROUP BY 1 ORDER BY 1;

.print '\n===== (3) GAMMA regime x breakout-day VOLUME (does GEX add beyond volume?) ====='
SELECT CASE WHEN gamma_pct<0.33 THEN 'low-gamma' WHEN gamma_pct<0.67 THEN 'mid' ELSE 'high-gamma' END gamma,
  CASE WHEN rvol>=1.5 THEN 'vol>=1.5x' ELSE 'vol<1.5x' END vol,
  count(*) n, round(100.0*avg(is_trap::int),0) pct_false_trap
FROM ev GROUP BY 1,2 ORDER BY 1,2;
