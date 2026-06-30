"""T3 · GOLD — 10-year daily feature + forward-label set from the SPLIT-ADJUSTED lake.

Built on silver/market_bars_daily_adj (split-correct, survivorship-free, all regimes) — the
corrected foundation for an honest cross-regime backtest. Features are window-function friendly
(no recursive-indicator pain): trailing returns/momentum, realized vol, RVOL, SMA distance,
52-week-high distance, relative strength vs SPY. Labels: strictly-forward returns.

Then runs a CROSS-REGIME decile-lift backtest of momentum — does the signal hold out-of-regime?

Run: python -m lake.build_features
"""
import os
from .common import connect, SILVER, GOLD

ADV_MIN = 5_000_000     # $5M/day liquidity floor (tradeable universe; cuts penny noise)


def main():
    con = connect()
    import shutil
    dest = f"{GOLD}/features_daily"
    shutil.rmtree(dest, ignore_errors=True)        # clean full rebuild — no stale/dup partitions
    os.makedirs(dest, exist_ok=True)
    src = f"{SILVER}/market_bars_daily_adj/**/*.parquet"

    # SPY trailing 20d return, for relative strength
    con.execute(f"""
      CREATE OR REPLACE VIEW spy AS
        SELECT d, close / lag(close, 20) OVER (ORDER BY d) - 1 AS spy_ret20
        FROM read_parquet('{src}') WHERE symbol = 'SPY'
    """)

    print("building gold/features_daily …", flush=True)
    con.execute(f"""
      COPY (
        WITH r AS (    -- daily returns + price lags/leads (single-level windows)
          SELECT symbol, d, year(d) AS y, open, high, low, close, volume,
                 close / lag(close,1) OVER w - 1 AS ret1,
                 lag(close,5)   OVER w AS c5,
                 lag(close,20)  OVER w AS c20,
                 lag(close,60)  OVER w AS c60,
                 lead(close,5)  OVER w AS f5,
                 lead(close,10) OVER w AS f10
          FROM read_parquet('{src}')
          WINDOW w AS (PARTITION BY symbol ORDER BY d)
        ),
        b AS (         -- rolling aggregates (can now reference ret1, no nested windows)
          SELECT symbol, d, y, close, volume, c5, c20, c60, f5, f10,
                 avg(close*volume) OVER w20  AS adv20,
                 avg(volume)       OVER w20  AS avgvol20,
                 avg(close)        OVER w50  AS sma50,
                 avg(close)        OVER w200 AS sma200,
                 max(high)         OVER w252 AS hi252,
                 stddev_samp(ret1) OVER w20  AS vol20,
                 count(*)          OVER w252 AS hist
          FROM r
          WINDOW w20  AS (PARTITION BY symbol ORDER BY d ROWS 19 PRECEDING),
                 w50  AS (PARTITION BY symbol ORDER BY d ROWS 49 PRECEDING),
                 w200 AS (PARTITION BY symbol ORDER BY d ROWS 199 PRECEDING),
                 w252 AS (PARTITION BY symbol ORDER BY d ROWS 251 PRECEDING)
        )
        SELECT b.symbol, b.d, b.y, b.close,
               b.close/b.c5  - 1                      AS ret_5d,
               b.close/b.c20 - 1                      AS ret_20d,
               b.close/b.c60 - 1                      AS ret_60d,
               b.vol20                                AS vol_20d,
               b.volume / NULLIF(b.avgvol20,0)        AS rvol,
               b.close / NULLIF(b.sma50,0)  - 1       AS dist_sma50,
               b.close / NULLIF(b.sma200,0) - 1       AS dist_sma200,
               b.close / NULLIF(b.hi252,0)  - 1       AS dist_52whigh,
               (b.close/b.c20 - 1) - s.spy_ret20      AS rs_spy_20,
               b.adv20,
               b.f5  / b.close - 1                    AS fwd_ret_5d,
               b.f10 / b.close - 1                    AS fwd_ret_10d
        FROM b LEFT JOIN spy s ON s.d = b.d
        WHERE b.hist >= 200            -- enough history
          AND b.adv20 >= {ADV_MIN}     -- liquid/tradeable
          AND b.c20 IS NOT NULL
      ) TO '{dest}' (FORMAT PARQUET, PARTITION_BY (y), OVERWRITE_OR_IGNORE)
    """)

    n, syms, dmin, dmax = con.execute(f"""
      SELECT count(*), count(DISTINCT symbol), CAST(min(d) AS VARCHAR), CAST(max(d) AS VARCHAR)
      FROM read_parquet('{dest}/**/*.parquet')""").fetchone()
    print(f"features_daily: {n:,} rows  {syms:,} symbols  {dmin}..{dmax}")

    # ── CROSS-REGIME backtest: decile-lift of 20d momentum → avg forward 5d return ──
    print("\n=== CROSS-REGIME momentum decile-lift (avg fwd_ret_5d %, by ret_20d decile) ===")
    regimes = [
        ('COVID-crash/rec 2020', '2020-02-01', '2020-12-31'),
        ('2021 bull',            '2021-01-01', '2021-12-31'),
        ('2022 bear',            '2022-01-01', '2022-12-31'),
        ('AI bull 2023-24',      '2023-01-01', '2024-12-31'),
        ('recent 2025-26',       '2025-01-01', '2026-12-31'),
    ]
    for name, a, b in regimes:
        rows = con.execute(f"""
          WITH x AS (
            SELECT fwd_ret_5d, ntile(10) OVER (ORDER BY ret_20d) AS decile
            FROM read_parquet('{dest}/**/*.parquet')
            WHERE d BETWEEN DATE '{a}' AND DATE '{b}' AND fwd_ret_5d IS NOT NULL AND ret_20d IS NOT NULL
          )
          SELECT
            round(median(fwd_ret_5d) FILTER (WHERE decile=10)*100, 2) AS top_decile,
            round(median(fwd_ret_5d) FILTER (WHERE decile=1)*100, 2)  AS bot_decile,
            round((median(fwd_ret_5d) FILTER (WHERE decile=10) - median(fwd_ret_5d) FILTER (WHERE decile=1))*100, 2) AS spread,
            count(*) AS n
          FROM x
        """).fetchone()
        print(f"  {name:22s} top={str(rows[0]):>6}%  bottom={str(rows[1]):>6}%  spread={str(rows[2]):>6}pp  (n={rows[3]:,})")


if __name__ == "__main__":
    main()
