"""Daily Bronze→Silver→Gold sync — keeps the whole lake CURRENT after the Bronze OLTP append.

Runs AFTER scripts/dump-oltp-to-bronze.mjs (which appends yesterday's OLTP → Bronze).

STEP 1 — SILVER signals (ALL proprietary OLTP tables): rebuild silver/signals/<table> from Bronze,
  then VALIDATE row count Silver == Bronze per table (data-integrity gate; aborts loud on mismatch).
  Full rebuild = cheap (proprietary tables ~100MB) and guarantees exact consistency, no drift.
STEP 2 — SILVER market: append the latest archive trading day to market_bars_daily (+ split-adj).
STEP 3 — GOLD: refresh features_daily from the adjusted bars.

Market-data COPIES in OLTP (intraday_bars_1m, databento_ohlcv_1m, backtest_*, daily_intraday_features)
are NOT duplicated here — their canonical Silver is market_bars_* / features_daily (from the archive).
Set INCLUDE_MARKET_COPIES=1 to mirror them too (literal 1:1; heavy).

Run:  python -m lake.sync_daily                 # full daily sync (signals + market + gold)
      python -m lake.sync_daily --signals-only  # just Bronze→Silver for all OLTP tables (validated)
"""
import os
import glob
import shutil
import argparse
import duckdb
from .common import connect, BRONZE, SILVER, GOLD, FLATFILES

MARKET_COPIES = {'intraday_bars_1m', 'databento_ohlcv_1m', 'backtest_prices',
                 'backtest_scores', 'backtest_returns', 'daily_intraday_features'}
INCLUDE_COPIES = os.environ.get('INCLUDE_MARKET_COPIES') == '1'


def bronze_tables():
    out = []
    for d in sorted(glob.glob(f"{BRONZE}/*/")):
        n = os.path.basename(d.rstrip('/'))
        if n in MARKET_COPIES and not INCLUDE_COPIES:
            continue
        if glob.glob(f"{d}**/*.parquet", recursive=True):
            out.append(n)
    return out


def sync_signals(con):
    """Bronze→Silver for every proprietary OLTP table, with per-table row-count validation."""
    print("STEP 1 — BRONZE→SILVER (all OLTP tables), with row-count validation:")
    tables = bronze_tables()
    fails, ok = [], 0
    for t in tables:
        src = f"{BRONZE}/{t}/**/*.parquet"
        cols = [r[0] for r in con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{src}', union_by_name=true)").fetchall()]
        sel = ", ".join(f"UPPER({c}) AS {c}" if c == 'symbol' else c for c in cols)
        dest = f"{SILVER}/signals/{t}"
        os.makedirs(dest, exist_ok=True)
        con.execute(f"COPY (SELECT {sel} FROM read_parquet('{src}', union_by_name=true)) "
                    f"TO '{dest}/data.parquet' (FORMAT PARQUET)")
        b = con.execute(f"SELECT count(*) FROM read_parquet('{src}', union_by_name=true)").fetchone()[0]
        s = con.execute(f"SELECT count(*) FROM read_parquet('{dest}/data.parquet')").fetchone()[0]
        if b != s:
            fails.append((t, b, s)); print(f"  ❌ {t}: bronze={b} silver={s} MISMATCH")
        else:
            ok += 1
    print(f"  → {ok}/{len(tables)} tables synced, row-counts MATCH; {len(fails)} mismatch")
    if fails:
        raise SystemExit(f"DATA-INTEGRITY ABORT: {len(fails)} table(s) lost rows Bronze→Silver: {fails}")
    return ok


def sync_market_daily(con):
    """Append the latest archive trading day(s) to silver/market_bars_daily (idempotent)."""
    print("STEP 2 — SILVER market_bars_daily (append latest archive day):")
    have = set(os.path.basename(p)[2:] for p in glob.glob(f"{SILVER}/market_bars_daily/d=*"))  # [2:] strips 'd='
    raw_days = sorted(os.path.basename(f)[:-7] for f in glob.glob(f"{FLATFILES}/day_aggs_v1/*/*/*.csv.gz"))
    todo = [d for d in raw_days if d not in have]
    if not todo:
        print("  up to date."); return 0
    for d in todo[-5:]:  # safety: a few most-recent missing days
        src = f"{FLATFILES}/day_aggs_v1/{d[:4]}/{d[5:7]}/{d}.csv.gz"
        dest = f"{SILVER}/market_bars_daily/d={d}"
        shutil.rmtree(dest, ignore_errors=True); os.makedirs(dest)   # clean partition replace (one file/day)
        con.execute(f"""COPY (SELECT ticker AS symbol, to_timestamp(window_start/1e9) AS ts_utc,
                                     open, high, low, close, volume, transactions, 'polygon' AS source
                              FROM read_csv('{src}', header=true)) TO '{dest}/data.parquet' (FORMAT PARQUET)""")
        print(f"  appended market_bars_daily d={d}")
    print("  NOTE: market_bars_daily_adj (split-adjusted) NOT incrementally updated here — run "
          "lake.build_adjusted after a split, or schedule a weekly full rebuild.")
    return len(todo)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--signals-only', action='store_true')
    args = ap.parse_args()
    con = connect()
    sync_signals(con)
    if not args.signals_only:
        sync_market_daily(con)
        con.close()
        # STEP 3 — GOLD: rebuild split-adjusted bars then features (full rebuild = correctness-safe).
        import subprocess, sys
        for mod in ('lake.build_adjusted', 'lake.build_features'):
            print(f"STEP 3 — GOLD: {mod}")
            if subprocess.run([sys.executable, '-m', mod]).returncode != 0:
                raise SystemExit(f"GOLD step {mod} FAILED")
        # STEP 4 — data-integrity gate: canonical layers must be free of duplicate (symbol,d)
        con2 = connect()
        for name, p in [('market_bars_daily_adj', f'{SILVER}/market_bars_daily_adj'),
                        ('features_daily', f'{GOLD}/features_daily')]:
            dup = con2.execute(f"SELECT count(*)-count(DISTINCT (symbol,d)) "
                               f"FROM read_parquet('{p}/**/*.parquet')").fetchone()[0]
            if dup != 0:
                raise SystemExit(f"DATA-INTEGRITY ABORT: {name} has {dup} duplicate (symbol,d) rows")
            print(f"  ✅ {name}: 0 duplicate rows")
        con2.close()
    print("sync_daily DONE.")


if __name__ == '__main__':
    main()
