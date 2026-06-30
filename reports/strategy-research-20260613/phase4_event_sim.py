"""Event-level backtest: Setup A vs random-control, exit-geometry grid, walk-forward.
Entry: signal at close of day d (features known), fill next bar OPEN +5bps.
Exits: gap-aware hard stop / trailing stop / time stop. Costs 10bps round trip.
"""
import duckdb, numpy as np, sys

con = duckdb.connect('research.duckdb')
con.execute("SET TimeZone='America/New_York'")

# ── events: Setup A (uptrend pullback) in R1/R2 + random control, 2017-2026 ──
con.execute("""
CREATE OR REPLACE TABLE ev AS
WITH a AS (
  SELECT symbol, d, regime, 'setupA' AS cohort
  FROM u
  WHERE regime IN ('R1_up_calm','R2_up_vol')
    AND dist_sma200 > 0 AND dist_52whigh > -0.15
    AND ret_5d BETWEEN -0.08 AND -0.02 AND rvol < 2
),
rnd AS (
  SELECT symbol, d, regime, 'random' AS cohort
  FROM u WHERE regime IN ('R1_up_calm','R2_up_vol')
)
SELECT * FROM (SELECT * FROM a USING SAMPLE reservoir(60000) REPEATABLE (42))
UNION ALL
SELECT * FROM (SELECT * FROM rnd USING SAMPLE reservoir(60000) REPEATABLE (42))
""")

# ── attach next 16 trading bars per event ──
rows = con.execute("""
WITH bars AS (
  SELECT symbol, d, open, high, low, close
  FROM read_parquet('/Volumes/Archive/silver/market_bars_daily_adj/**/*.parquet')
  WHERE symbol IN (SELECT DISTINCT symbol FROM ev)
)
SELECT e.cohort, e.regime, e.symbol, e.d AS sig_d,
       list(b.open  ORDER BY b.d) AS o,
       list(b.high  ORDER BY b.d) AS h,
       list(b.low   ORDER BY b.d) AS l,
       list(b.close ORDER BY b.d) AS c
FROM ev e
JOIN bars b ON b.symbol = e.symbol AND b.d > e.d AND b.d <= e.d + INTERVAL 30 DAY
GROUP BY 1,2,3,4
HAVING COUNT(*) >= 11
""").fetchall()
print(f"events with full bar windows: {len(rows)}", file=sys.stderr)

SLIP = 0.0005
CONFIGS = [
    ('no_stop_t5',   None, None, 5),
    ('no_stop_t10',  None, None, 10),
    ('hard5_t10',    0.05, None, 10),
    ('hard8_t10',    0.08, None, 10),
    ('hard12_t10',   0.12, None, 10),
    ('trail8_t10',   None, 0.08, 10),
    ('trail12_t10',  None, 0.12, 10),
    ('h8_trail10_t10', 0.08, 0.10, 10),
]

def simulate(o, h, l, c, hard, trail, tstop):
    entry = o[0] * (1 + SLIP)
    stop_px  = entry * (1 - hard) if hard else None
    peak = h[0]
    trail_px = peak * (1 - trail) if trail else None
    n = min(tstop, len(c) - 1)
    for i in range(len(c)):
        if i > 0:
            # gap-aware: stop checks vs today's open first
            if stop_px is not None and l[i] <= stop_px:
                return (min(o[i], stop_px) / entry) - 1 - SLIP, 'hard', i
            if trail_px is not None and l[i] <= trail_px:
                return (min(o[i], trail_px) / entry) - 1 - SLIP, 'trail', i
        if trail is not None:
            peak = max(peak, h[i])
            trail_px = peak * (1 - trail)
        if i == n:
            return (c[i] / entry) - 1 - SLIP, 'time', i
    return (c[-1] / entry) - 1 - SLIP, 'time', len(c) - 1

import collections
res = collections.defaultdict(list)
for cohort, regime, sym, sig_d, o, h, l, c in rows:
    o, h, l, c = map(np.asarray, (o, h, l, c))
    if o[0] <= 0: continue
    half = 'H1_2017-21' if str(sig_d) < '2022-01-01' else 'H2_2022-26'
    for name, hard, trail, tstop in CONFIGS:
        r, why, days = simulate(o, h, l, c, hard, trail, tstop)
        if -0.95 < r < 3.0:
            res[(cohort, regime, half, name)].append(r)

print('cohort,regime,half,config,n,win_pct,avg_pct,med_pct,p10_pct,expectancy_bp')
for k in sorted(res):
    a = np.array(res[k])
    print(f"{k[0]},{k[1]},{k[2]},{k[3]},{len(a)},{100*(a>0).mean():.1f},{100*a.mean():.3f},{100*np.median(a):.3f},{100*np.percentile(a,10):.2f},{10000*a.mean():.0f}")
