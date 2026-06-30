"""T3 · GOLD — analytics marts built from Silver (Python + DuckDB).

Gold marts are purpose-built business logic (recomputable from Silver). One example mart is
implemented as a working pattern; add more as features/backtests/regime sets are needed.

Run:
  python -m lake.gold --sample
"""
import argparse
from .common import connect, write_file, SILVER, GOLD


def build_signal_forward_returns(con):
    """Example mart: bot high-conviction signals × Polygon daily bars → next-day return.

    Joins silver/signals/conviction_scores to silver/market_bars_daily, computing the
    1-day-forward % move after each high-conviction (score>=70) signal. The kind of
    analytics that was slow/impossible on OLTP and is trivial on the lake.
    """
    sql = f"""
        WITH conv AS (
            SELECT UPPER(symbol) AS symbol, CAST(scored_at AS DATE) AS d, score
            FROM read_parquet('{SILVER}/signals/conviction_scores/data.parquet')
            WHERE score >= 70
        ),
        bars AS (
            SELECT symbol, d, close,
                   LEAD(close) OVER (PARTITION BY symbol ORDER BY d) AS next_close
            FROM read_parquet('{SILVER}/market_bars_daily/**/*.parquet')
        )
        SELECT c.symbol,
               count(*)                                              AS signals,
               round(avg(c.score), 1)                                AS avg_score,
               round(avg((b.next_close - b.close) / b.close * 100), 3) AS avg_fwd_1d_pct
        FROM conv c
        JOIN bars b ON b.symbol = c.symbol AND b.d = c.d
        WHERE b.next_close IS NOT NULL
        GROUP BY 1
        HAVING count(*) >= 3
        ORDER BY avg_fwd_1d_pct DESC
    """
    n = write_file(con, sql, f"{GOLD}/signal_forward_returns/data.parquet")
    print(f"  gold/signal_forward_returns: {n:,} rows")
    # show a peek
    rows = con.execute(
        f"SELECT * FROM read_parquet('{GOLD}/signal_forward_returns/data.parquet') "
        f"ORDER BY signals DESC LIMIT 8"
    ).fetchall()
    print("  sample:", *[f"{r[0]}(n={r[1]},fwd={r[3]}%)" for r in rows], sep="\n    ")
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", action="store_true")
    args = ap.parse_args()
    con = connect()
    print(f"GOLD build → {GOLD}")
    build_signal_forward_returns(con)
    print("GOLD done.")


if __name__ == "__main__":
    main()
