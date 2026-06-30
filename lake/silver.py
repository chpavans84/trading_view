"""T2 · SILVER — conform Bronze + Polygon archive to canonical schema (Python + DuckDB).

Two cases (docs/ARCHITECTURE.md §4):
  • MARKET DATA  → Polygon schema (silver/market_bars_daily, ...): the canonical target.
  • PROPRIETARY  → internal canonical schema, default PASSTHROUGH (schema-flexible) so a new
                   OLTP/Bronze table flows to silver/signals/<table> with no new code.

Run:
  python -m lake.silver --sample           # quick proof: 2026 market bars + 3 signal tables
  python -m lake.silver                     # full build (heavy — Mac Studio)
  python -m lake.silver --only trades,bot_decisions
"""
import argparse
from .common import (connect, bronze_tables, columns, write_partitioned, write_file,
                     BRONZE, SILVER, FLATFILES)

# Bronze tables that are market/derived (NOT proprietary signals) — excluded from signal passthrough.
MARKET_OR_DERIVED = {
    "intraday_bars_1m", "databento_ohlcv_1m", "backtest_prices", "backtest_scores",
    "backtest_returns", "daily_intraday_features",
}
# Explicit conform rules can be registered here; everything else uses default passthrough.
EXPLICIT_CONFORMS: dict = {}


def build_market_bars_daily(con, date_glob="*/*"):
    """Polygon day_aggs CSV.gz → silver/market_bars_daily (Polygon schema, ns→ts, +source)."""
    src = f"{FLATFILES}/day_aggs_v1/{date_glob}/*.csv.gz"
    sql = f"""
        SELECT ticker AS symbol,
               CAST(to_timestamp(window_start/1e9) AS DATE) AS d,
               to_timestamp(window_start/1e9)               AS ts_utc,
               open, high, low, close, volume, transactions,
               'polygon' AS source
        FROM read_csv('{src}', header=true, union_by_name=true)
    """
    n = write_partitioned(con, sql, f"{SILVER}/market_bars_daily", "d")
    print(f"  silver/market_bars_daily: {n:,} rows  (glob={date_glob})")
    return n


def build_signal_passthrough(con, tables):
    """Default conform for proprietary tables: passthrough + normalize symbol→UPPER if present."""
    for t in tables:
        if t in MARKET_OR_DERIVED:
            continue
        src = f"{BRONZE}/{t}/**/*.parquet"
        cols = columns(con, src)
        sel = ", ".join(
            (f"UPPER({c}) AS {c}" if c == "symbol" else c) for c in cols
        )
        sql = f"SELECT {sel} FROM read_parquet('{src}', union_by_name=true)"
        n = write_file(con, sql, f"{SILVER}/signals/{t}/data.parquet")
        print(f"  silver/signals/{t}: {n:,} rows")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", action="store_true", help="quick proof subset")
    ap.add_argument("--only", default="", help="comma list of proprietary tables")
    args = ap.parse_args()

    con = connect()
    print(f"SILVER build → {SILVER}")

    # 1. market data
    build_market_bars_daily(con, date_glob="2026/*" if args.sample else "*/*")

    # 2. proprietary signals (auto-discovered, schema-flexible)
    tables = [t.strip() for t in args.only.split(",") if t.strip()] or [
        t for t in bronze_tables() if t not in MARKET_OR_DERIVED
    ]
    if args.sample and not args.only:
        tables = ["bot_decisions", "conviction_scores", "trades"]
    build_signal_passthrough(con, tables)
    print("SILVER done.")


if __name__ == "__main__":
    main()
