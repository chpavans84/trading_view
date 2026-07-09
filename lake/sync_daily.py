"""Daily Bronze→Silver→Gold sync — keeps the whole lake CURRENT after the Bronze OLTP append.

Runs AFTER scripts/dump-oltp-to-bronze.mjs (which appends yesterday's OLTP → Bronze).

STEP 1 — SILVER signals (ALL proprietary OLTP tables): rebuild silver/signals/<table> from Bronze,
  then VALIDATE row count Silver == Bronze per table (data-integrity gate; aborts loud on mismatch).
  Full rebuild = cheap (proprietary tables ~100MB) and guarantees exact consistency, no drift.
STEP 2  — SILVER market: append the latest archive trading day to market_bars_daily (+ split-adj).
STEP 2b — SILVER market: forward-fill market_bars_daily from OLTP backtest_prices (Yahoo) for days
  PAST the last Polygon flat-file — this keeps the lake current after the Polygon sub is cancelled.
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


def _database_url():
    """DATABASE_URL from env, falling back to the project-root .env (the daily shell wrapper
    does not export it into this process). Returns None if unavailable."""
    v = os.environ.get("DATABASE_URL")
    if v:
        return v
    envp = os.path.join(os.path.dirname(__file__), "..", ".env")
    try:
        with open(envp) as f:
            for line in f:
                if line.startswith("DATABASE_URL="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None

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


def sync_market_daily_from_oltp(con):
    """Forward-fill market_bars_daily from OLTP `backtest_prices` for trading days STRICTLY AFTER
    the last Polygon flat-file on disk.

    This is what makes the lake self-sustaining once the Polygon subscription is cancelled:
    Polygon stays authoritative for every historical day it has, and OLTP (Yahoo-fed, free,
    current to yesterday) covers everything beyond the last archive day. Yahoo only stores
    trading days, so no separate holiday calendar is needed. Idempotent; fails OPEN (a missing
    DATABASE_URL / attach error just skips — never aborts the daily sync).

    NOTE: volume comes from backtest_prices.volume, which must be populated from Yahoo
    (scripts/etl/refresh-volume-yahoo.mjs) — Alpaca's IEX volume is ~3% of tape. Rows still
    NULL at sync time are appended NULL and reported; the next run refills them.
    OVERLAP CAVEAT: while still subscribed, a day Yahoo publishes before Polygon's T+1 file lands
    is filled from OLTP and NOT later upgraded to the Polygon version. Harmless (one day's volume
    source) and vanishes entirely once Polygon is cancelled."""
    print("STEP 2b — SILVER market_bars_daily (OLTP forward-fill past the Polygon boundary):")
    db = _database_url()
    if not db:
        print("  ⚠️ skipped: DATABASE_URL not available"); return 0
    raw_days = sorted(os.path.basename(f)[:-7] for f in glob.glob(f"{FLATFILES}/day_aggs_v1/*/*/*.csv.gz"))
    have = set(os.path.basename(p)[2:] for p in glob.glob(f"{SILVER}/market_bars_daily/d=*"))
    boundary = raw_days[-1] if raw_days else (max(have) if have else "1900-01-01")
    try:
        con.execute("INSTALL postgres; LOAD postgres")
        con.execute(f"ATTACH '{db}' AS pg (TYPE POSTGRES, READ_ONLY)")
    except Exception as e:
        print(f"  ⚠️ skipped: postgres attach failed ({e})"); return 0
    try:
        rows = con.execute(
            "SELECT DISTINCT strftime(price_date, '%Y-%m-%d') AS d FROM pg.public.backtest_prices "
            f"WHERE price_date > DATE '{boundary}' ORDER BY d").fetchall()
        todo = [r[0] for r in rows if r[0] not in have]
        if not todo:
            print(f"  up to date (Polygon boundary = {boundary})."); return 0
        print(f"  {len(todo)} candidate day(s) after boundary {boundary}: {todo}")
        # A real US trading day has thousands of symbols. Guard against holiday stray-rows
        # (e.g. 2026-07-03 had 1 symbol) and partial-feed days polluting the lake.
        MIN_SYMBOLS = int(os.environ.get("OLTP_MIN_SYMBOLS", "500"))
        appended = 0
        for d in todo:
            n = con.execute(
                f"SELECT count(*) FROM pg.public.backtest_prices "
                f"WHERE price_date = DATE '{d}' AND close IS NOT NULL").fetchone()[0]
            if n < MIN_SYMBOLS:
                print(f"  skip d={d}: only {n} symbols (< {MIN_SYMBOLS}) — non-trading day / partial feed")
                continue
            dest = f"{SILVER}/market_bars_daily/d={d}"
            shutil.rmtree(dest, ignore_errors=True); os.makedirs(dest)
            con.execute(f"""COPY (
                SELECT UPPER(symbol) AS symbol, (price_date::TIMESTAMPTZ) AS ts_utc,
                       open::DOUBLE AS open, high::DOUBLE AS high, low::DOUBLE AS low, close::DOUBLE AS close,
                       volume::DOUBLE AS volume, NULL::BIGINT AS transactions, 'yahoo_oltp' AS source
                FROM pg.public.backtest_prices
                WHERE price_date = DATE '{d}' AND close IS NOT NULL
            ) TO '{dest}/data.parquet' (FORMAT PARQUET)""")
            cnt = con.execute(f"SELECT count(*) FROM read_parquet('{dest}/data.parquet')").fetchone()[0]
            nullvol = con.execute(
                f"SELECT count(*) FROM read_parquet('{dest}/data.parquet') WHERE volume IS NULL").fetchone()[0]
            warn = f" ⚠️ {nullvol} NULL volume (run refresh-volume-yahoo)" if nullvol else ""
            print(f"  appended d={d} from OLTP — {cnt} symbols{warn}")
            appended += 1
        return appended
    finally:
        try:
            con.execute("DETACH pg")
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--signals-only', action='store_true')
    args = ap.parse_args()
    con = connect()
    sync_signals(con)
    if not args.signals_only:
        sync_market_daily(con)          # Polygon flat-files → authoritative for archived days
        sync_market_daily_from_oltp(con)  # OLTP (Yahoo) → forward days past the Polygon boundary
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
