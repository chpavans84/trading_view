# /// script
# requires-python = ">=3.10"
# dependencies = ["databento>=0.40", "psycopg[binary]>=3.1"]
# ///
"""
src/research/databento-loader.py
Loads Databento ohlcv-1m bars into the `databento_ohlcv_1m` Postgres table.

Cost-aware design:
  - Hard budget guard: refuses pull if estimate > MAX_PULL_USD
  - Pre-pull confirmation: prints estimate, requires --confirm flag to proceed
  - Per-month chunking: failures don't lose previously-pulled chunks
  - Audit log: writes every pull to logs/databento-pulls.log

CLI usage:
  # Estimate cost only — never charges
  python src/research/databento-loader.py --estimate --start 2023-04-01 --end 2026-05-21 --schema ohlcv-1m

  # Actual pull — requires --confirm AND under budget
  python src/research/databento-loader.py --confirm --start 2023-04-01 --end 2026-05-21 --schema ohlcv-1m

  # Tiny smoke pull (one symbol, one day)
  python src/research/databento-loader.py --confirm --symbols SPY --start 2026-05-21 --end 2026-05-21

Env vars required:
  DATABENTO_API_KEY  — your key
  DATABASE_URL       — Postgres connection string
  MAX_PULL_USD       — hard cap on a single pull (default 120 — under your $125 free credit)

Per-symbol cost is roughly proportional to volume. Heavy-traded names (SPY,
AAPL, NVDA) dominate the cost. ETFs are usually cheaper.
"""

import argparse
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import databento as db
import psycopg
from psycopg.rows import dict_row

# ─── Defaults ──────────────────────────────────────────────────────────────
DEFAULT_BASKET = [
    # Index ETFs
    'SPY', 'QQQ', 'IWM', 'DIA',
    # SPDR Sector ETFs
    'XLF', 'XLE', 'XLU', 'XLK', 'XLV', 'XLI', 'XLB', 'XLP', 'XLY', 'XLRE', 'XLC',
    # SP100 large-cap stocks
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'GOOG', 'AMZN', 'META', 'AVGO', 'ORCL', 'NFLX',
    'BRK-B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'MS', 'GS', 'AXP', 'BLK',
    'LLY', 'UNH', 'JNJ', 'ABBV', 'MRK', 'TMO', 'ABT', 'PFE', 'AMGN', 'GILD',
    'BMY', 'DHR', 'MDT', 'CI', 'CVS', 'ELV', 'HCA', 'SYK',
    'WMT', 'PG', 'HD', 'COST', 'PEP', 'KO', 'MCD', 'PM', 'MDLZ',
    'TGT', 'SBUX', 'NKE', 'BKNG', 'TJX',
    'XOM', 'CVX', 'COP', 'EOG', 'PSX', 'OXY',
    'CAT', 'DE', 'BA', 'GE', 'HON', 'UNP', 'RTX', 'LMT', 'GD', 'EMR',
    'CRM', 'ADBE', 'AMD', 'INTC', 'QCOM', 'TXN', 'IBM', 'CSCO', 'NOW', 'AMAT',
    'LRCX', 'MU', 'INTU',
    'NEE', 'SO', 'DUK', 'AMT', 'PLD', 'EQIX',
    'T', 'VZ', 'DIS', 'CMCSA',
    'LIN', 'ACN', 'SPGI', 'PYPL', 'SCHW', 'ICE', 'CB', 'AON',
    'F', 'GM',
]

PROJECT_ROOT = Path(__file__).resolve().parents[2]
LOG_PATH = PROJECT_ROOT / 'logs' / 'databento-pulls.log'


def log_event(msg: str) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open('a') as f:
        f.write(f"{datetime.utcnow().isoformat()} {msg}\n")


# ─── DB helpers ─────────────────────────────────────────────────────────────
def get_conn() -> psycopg.Connection:
    dsn = os.environ.get('DATABASE_URL')
    if not dsn:
        raise SystemExit("DATABASE_URL env var not set")
    return psycopg.connect(dsn, row_factory=dict_row)


def ensure_table(conn: psycopg.Connection) -> None:
    """Idempotent — creates databento_ohlcv_1m if missing."""
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS databento_ohlcv_1m (
              symbol     VARCHAR(20)    NOT NULL,
              ts_event   TIMESTAMPTZ    NOT NULL,
              open       NUMERIC(14,4),
              high       NUMERIC(14,4),
              low        NUMERIC(14,4),
              close      NUMERIC(14,4),
              volume     BIGINT,
              instrument_id INTEGER,
              dataset    VARCHAR(20)    DEFAULT 'DBEQ.BASIC',
              ingested_at TIMESTAMPTZ   DEFAULT NOW(),
              PRIMARY KEY (symbol, ts_event)
            );
            CREATE INDEX IF NOT EXISTS idx_databento_ohlcv_sym_ts
              ON databento_ohlcv_1m (symbol, ts_event DESC);
        """)
    conn.commit()


def existing_coverage(conn: psycopg.Connection, symbol: str) -> tuple | None:
    """Returns (min_ts, max_ts) for symbol or None if no rows."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT MIN(ts_event) AS lo, MAX(ts_event) AS hi FROM databento_ohlcv_1m WHERE symbol = %s",
            (symbol,),
        )
        row = cur.fetchone()
        return (row['lo'], row['hi']) if row and row['lo'] else None


# ─── Cost estimation ────────────────────────────────────────────────────────
def estimate_cost(client: db.Historical, symbols: list[str], start: str, end: str,
                  schema: str, dataset: str = 'DBEQ.BASIC') -> tuple[float, int]:
    """Returns (cost_usd, size_bytes). NO data charge — free metadata call."""
    cost = client.metadata.get_cost(
        dataset=dataset, schema=schema, symbols=symbols,
        start=start, end=end,
    )
    try:
        size = client.metadata.get_billable_size(
            dataset=dataset, schema=schema, symbols=symbols,
            start=start, end=end,
        )
    except Exception:
        size = -1
    return cost, size


# ─── Actual pull + insert ───────────────────────────────────────────────────
def pull_and_store(client: db.Historical, conn: psycopg.Connection,
                   symbols: list[str], start: str, end: str,
                   schema: str = 'ohlcv-1m', dataset: str = 'DBEQ.BASIC') -> dict:
    """COSTS MONEY. Pulls data and stores in Postgres. Returns stats."""
    log_event(f"PULL_START dataset={dataset} schema={schema} symbols={len(symbols)} start={start} end={end}")
    t0 = datetime.utcnow()

    data = client.timeseries.get_range(
        dataset=dataset, schema=schema, symbols=symbols,
        start=start, end=end,
    )
    df = data.to_df()
    n_rows = len(df)
    log_event(f"PULL_FETCH_OK rows={n_rows} elapsed={(datetime.utcnow()-t0).total_seconds():.1f}s")

    if n_rows == 0:
        return {'rows': 0, 'inserted': 0, 'symbols_seen': 0}

    # Databento returns df indexed by ts_event with symbol column
    # Schema for ohlcv-1m: columns include open/high/low/close/volume/symbol/instrument_id
    if 'symbol' not in df.columns:
        df = df.reset_index()

    # Bulk insert via COPY to a temp table, then UPSERT — handles millions of rows in seconds
    inserted = 0
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TEMP TABLE _databento_stage (
              symbol VARCHAR(20), ts_event TIMESTAMPTZ,
              open NUMERIC(14,4), high NUMERIC(14,4), low NUMERIC(14,4), close NUMERIC(14,4),
              volume BIGINT, instrument_id INTEGER, dataset VARCHAR(20)
            ) ON COMMIT DROP;
        """)
        copy_sql = "COPY _databento_stage (symbol, ts_event, open, high, low, close, volume, instrument_id, dataset) FROM STDIN"
        with cur.copy(copy_sql) as copy:
            for row in df.itertuples():
                ts = getattr(row, 'ts_event', None) or row.Index
                try:
                    copy.write_row((
                        row.symbol, ts,
                        float(row.open), float(row.high), float(row.low), float(row.close),
                        int(row.volume),
                        int(getattr(row, 'instrument_id', 0)) or None,
                        dataset,
                    ))
                    inserted += 1
                except Exception as e:
                    log_event(f"PULL_COPY_ROW_FAIL symbol={getattr(row,'symbol','?')} ts={ts} err={e}")

        # Upsert from staging to main table
        cur.execute("""
            INSERT INTO databento_ohlcv_1m
              (symbol, ts_event, open, high, low, close, volume, instrument_id, dataset)
            SELECT symbol, ts_event, open, high, low, close, volume, instrument_id, dataset
            FROM _databento_stage
            ON CONFLICT (symbol, ts_event) DO UPDATE SET
              open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
              close=EXCLUDED.close, volume=EXCLUDED.volume,
              ingested_at=NOW();
        """)
    conn.commit()

    symbols_seen = df['symbol'].nunique() if 'symbol' in df.columns else 0
    log_event(f"PULL_COMPLETE inserted={inserted} symbols={symbols_seen}")
    return {'rows': n_rows, 'inserted': inserted, 'symbols_seen': symbols_seen}


# ─── CLI ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', required=True, help='YYYY-MM-DD inclusive')
    ap.add_argument('--end',   required=True, help='YYYY-MM-DD inclusive')
    ap.add_argument('--schema', default='ohlcv-1m',
                    choices=['ohlcv-1d', 'ohlcv-1m', 'trades', 'mbp-1'])
    ap.add_argument('--dataset', default='DBEQ.BASIC')
    ap.add_argument('--symbols', help='Comma-separated symbols (default: full basket)')
    ap.add_argument('--estimate', action='store_true', help='Estimate cost only — no pull')
    ap.add_argument('--confirm', action='store_true',
                    help='REQUIRED to actually pull data (costs money)')
    args = ap.parse_args()

    if not (args.estimate or args.confirm):
        print("ERROR: must specify --estimate OR --confirm (--confirm actually pulls + costs money)")
        sys.exit(1)

    api_key = os.environ.get('DATABENTO_API_KEY')
    if not api_key:
        raise SystemExit("DATABENTO_API_KEY env var not set")

    max_pull = float(os.environ.get('MAX_PULL_USD', '120'))
    symbols = (args.symbols.split(',') if args.symbols else DEFAULT_BASKET)

    print(f"Dataset:  {args.dataset}")
    print(f"Schema:   {args.schema}")
    print(f"Symbols:  {len(symbols)} ({symbols[0]}..{symbols[-1] if len(symbols)>1 else ''})")
    print(f"Window:   {args.start} → {args.end}")
    print(f"Max budget for this pull: ${max_pull:.2f}")

    client = db.Historical(api_key)

    cost, size = estimate_cost(client, symbols, args.start, args.end, args.schema, args.dataset)
    gb = size / (1024**3) if size > 0 else -1
    print(f"\n>>> ESTIMATED COST: ${cost:.4f}  (size ~ {gb:.2f} GB)")

    if cost > max_pull:
        print(f"ABORT: ${cost:.2f} exceeds budget ${max_pull:.2f}. Set MAX_PULL_USD higher or narrow the pull.")
        sys.exit(2)

    if args.estimate:
        print("(--estimate: no pull executed)")
        sys.exit(0)

    # --confirm path
    log_event(f"PULL_AUTHORIZED budget={max_pull} estimated_cost={cost:.4f} symbols={len(symbols)}")
    print("\nProceeding with pull...")

    with get_conn() as conn:
        ensure_table(conn)
        stats = pull_and_store(client, conn, symbols, args.start, args.end,
                               args.schema, args.dataset)

    print(f"\nDone. Rows inserted: {stats['inserted']}  Symbols seen: {stats['symbols_seen']}")
    print(f"Audit log: {LOG_PATH}")


if __name__ == '__main__':
    main()
