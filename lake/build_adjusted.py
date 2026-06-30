"""Build the SPLIT-ADJUSTED daily price layer — the canonical backtest price source.

Raw Polygon prices (silver/market_bars_daily) are unadjusted. This applies cumulative split
factors from the AUTHORITATIVE Polygon splits data (polygon-rest/corporate_actions/splits) so
cross-split returns are correct. Far more reliable than Yahoo's deprecated .historical() (which
gave inconsistent adjustment — see memory audit-backtest-correctness).

  adjusted(d) = raw(d) / product(ratio for splits with execution_date > d)
  volume_adj  = raw_volume * factor   (shares scale inversely to price)

Output: silver/market_bars_daily_adj/ (partitioned by year). split_factor kept for traceability.
Run: python -m lake.build_adjusted
"""
import os
import shutil
from .common import connect, SILVER, ARCHIVE

SPLITS_GLOB = f"{ARCHIVE}/polygon-rest/corporate_actions/splits/*.json.gz"


def main():
    con = connect()
    dest = f"{SILVER}/market_bars_daily_adj"
    shutil.rmtree(dest, ignore_errors=True)        # clean full rebuild — no stale/dup partitions
    os.makedirs(dest, exist_ok=True)

    con.execute(f"""
      CREATE OR REPLACE VIEW splits AS
        SELECT ticker AS symbol, CAST(execution_date AS DATE) AS xdate,
               split_to::DOUBLE / split_from::DOUBLE AS ratio
        FROM read_json('{SPLITS_GLOB}', union_by_name=true)
        WHERE split_from > 0 AND split_to > 0
    """)
    con.execute(f"""
      CREATE OR REPLACE VIEW bars AS
        SELECT * FROM read_parquet('{SILVER}/market_bars_daily/**/*.parquet')
        QUALIFY row_number() OVER (PARTITION BY symbol, d ORDER BY ts_utc) = 1  -- dedup source quirks
    """)
    print(f"splits: {con.execute('SELECT count(*) FROM splits').fetchone()[0]:,}  "
          f"bars: {con.execute('SELECT count(*) FROM bars').fetchone()[0]:,}")

    con.execute(f"""
      COPY (
        WITH factors AS (
          SELECT b.symbol, b.d,
                 COALESCE(exp(sum(ln(s.ratio)) FILTER (WHERE s.xdate > b.d)), 1.0) AS factor
          FROM bars b LEFT JOIN splits s ON s.symbol = b.symbol
          GROUP BY b.symbol, b.d
        )
        SELECT b.symbol, b.d, year(b.d) AS y, b.ts_utc,
               b.open  / f.factor              AS open,
               b.high  / f.factor              AS high,
               b.low   / f.factor              AS low,
               b.close / f.factor              AS close,
               CAST(b.volume * f.factor AS BIGINT) AS volume,
               b.transactions,
               f.factor                        AS split_factor,
               b.source
        FROM bars b JOIN factors f USING (symbol, d)
      ) TO '{dest}' (FORMAT PARQUET, PARTITION_BY (y), OVERWRITE_OR_IGNORE)
    """)

    n = con.execute(f"SELECT count(*) FROM read_parquet('{dest}/**/*.parquet')").fetchone()[0]
    print(f"market_bars_daily_adj: {n:,} rows → {dest}")

    # Proof: known splits should now be CONTINUOUS (no discontinuity)
    print("\n=== verification (should be continuous across each split) ===")
    checks = {
        'NVDA': ['2024-06-07', '2024-06-10'],   # 10:1
        'AAPL': ['2020-08-28', '2020-08-31'],   # 4:1
        'TSLA': ['2022-08-24', '2022-08-25'],   # 3:1
    }
    for sym, dates in checks.items():
        rows = con.execute(f"""
            SELECT CAST(d AS VARCHAR), round(close, 2), round(split_factor, 3)
            FROM read_parquet('{dest}/**/*.parquet')
            WHERE symbol = '{sym}' AND CAST(d AS VARCHAR) IN ('{dates[0]}', '{dates[1]}')
            ORDER BY d
        """).fetchall()
        print(f"  {sym}: {rows}")


if __name__ == "__main__":
    main()
