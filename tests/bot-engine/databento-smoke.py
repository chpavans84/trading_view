# /// script
# requires-python = ">=3.10"
# dependencies = ["databento>=0.40"]
# ///
"""
tests/bot-engine/databento-smoke.py — verify Databento access + cost model.

Run:  DATABENTO_API_KEY=$(grep DATABENTO_API_KEY .env | cut -d= -f2) \\
      uv run tests/bot-engine/databento-smoke.py

Does:
  1. Auth check (free metadata call)
  2. Lists datasets available (free)
  3. Estimates cost for 5y SP100+ETFs at DBEQ.BASIC trades level (free)
  4. Pulls 1 hour of SPY trades as a smoke test (~<$0.05)
  5. Reports row count, format, projected 5y cost

No data persisted. No DB writes. No commits. Pure exploration.
"""

import os
import sys
from datetime import datetime, timedelta

try:
    import databento as db
except ImportError:
    print("ERROR: databento package not installed. uv should auto-install via PEP 723.")
    sys.exit(1)

API_KEY = os.environ.get("DATABENTO_API_KEY")
if not API_KEY:
    print("ERROR: DATABENTO_API_KEY env var not set.")
    sys.exit(1)

print("=" * 60)
print("Databento smoke test")
print("=" * 60)

client = db.Historical(API_KEY)

# ─── 1. Auth + dataset list ────────────────────────────────────────────────
print("\n[1] Auth check — listing datasets")
try:
    datasets = client.metadata.list_datasets()
    print(f"    OK — {len(datasets)} datasets available")
    # Show the ones relevant for us
    relevant = [d for d in datasets if 'DBEQ' in d or 'XNAS' in d or 'XNYS' in d]
    for d in relevant[:5]:
        print(f"      - {d}")
except Exception as e:
    print(f"    FAIL: {e}")
    sys.exit(1)

# ─── 2. Cost estimate — 5y SP100+ETFs at DBEQ.BASIC trades ──────────────────
print("\n[2] Cost estimate for 5y backfill")
end = datetime(2026, 5, 21)  # last Thursday of data
start = end - timedelta(days=5 * 365)
basket = ["SPY", "QQQ", "IWM", "DIA", "XLF", "XLE", "XLK", "XLV", "XLI", "AAPL",
          "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO", "ORCL", "NFLX",
          "JPM", "V", "MA", "BAC", "WFC", "LLY", "UNH", "JNJ", "ABBV", "PFE"]
print(f"    Window: {start.date()} → {end.date()} ({(end-start).days} days)")
print(f"    Basket: {len(basket)} symbols (subset of full SP100+ETF for estimate)")

try:
    cost_trades = client.metadata.get_cost(
        dataset="DBEQ.BASIC", schema="trades",
        symbols=basket, start=start.strftime("%Y-%m-%d"),
        end=end.strftime("%Y-%m-%d"),
    )
    print(f"    DBEQ.BASIC trades: ${cost_trades:.2f}")
except Exception as e:
    print(f"    cost-trades FAIL: {e}")

try:
    cost_mbp1 = client.metadata.get_cost(
        dataset="DBEQ.BASIC", schema="mbp-1",
        symbols=basket, start=start.strftime("%Y-%m-%d"),
        end=end.strftime("%Y-%m-%d"),
    )
    print(f"    DBEQ.BASIC mbp-1 (NBBO every change): ${cost_mbp1:.2f}")
except Exception as e:
    print(f"    cost-mbp1 FAIL: {e}")

try:
    cost_ohlcv1m = client.metadata.get_cost(
        dataset="DBEQ.BASIC", schema="ohlcv-1m",
        symbols=basket, start=start.strftime("%Y-%m-%d"),
        end=end.strftime("%Y-%m-%d"),
    )
    print(f"    DBEQ.BASIC ohlcv-1m (1-minute bars): ${cost_ohlcv1m:.2f}  ← what most backtests need")
except Exception as e:
    print(f"    cost-ohlcv1m FAIL: {e}")

# Scale estimate to full 116 instruments
print(f"\n    Scaling to full 116 instruments (~4x the {len(basket)}-sample):")
try:
    print(f"      Full basket trades est:    ~${cost_trades * 4:.2f}")
    print(f"      Full basket mbp-1 est:     ~${cost_mbp1 * 4:.2f}")
    print(f"      Full basket ohlcv-1m est:  ~${cost_ohlcv1m * 4:.2f}")
except NameError:
    print("      (one of the cost queries failed — see above)")

# ─── 3. Actual tiny pull: 1 hour of SPY trades ──────────────────────────────
print("\n[3] Smoke pull — 1 hour of SPY trades (2026-05-21 14:30-15:30 UTC = 10:30-11:30 ET)")
try:
    data = client.timeseries.get_range(
        dataset="DBEQ.BASIC", schema="trades", symbols=["SPY"],
        start="2026-05-21T14:30:00Z", end="2026-05-21T15:30:00Z",
    )
    df = data.to_df()
    print(f"    OK — {len(df)} trades pulled")
    if len(df):
        print(f"    First trade: {df.iloc[0]['ts_event']}  price=${df.iloc[0]['price']:.2f}  size={df.iloc[0]['size']}")
        print(f"    Last trade:  {df.iloc[-1]['ts_event']}  price=${df.iloc[-1]['price']:.2f}  size={df.iloc[-1]['size']}")
        print(f"    Columns:     {list(df.columns)[:8]}{'...' if len(df.columns) > 8 else ''}")
except Exception as e:
    print(f"    FAIL: {e}")

# ─── 4. Account balance ─────────────────────────────────────────────────────
print("\n[4] Account balance after this smoke test")
try:
    balance = client.metadata.get_billable_size(
        dataset="DBEQ.BASIC", schema="trades", symbols=["SPY"],
        start="2026-05-21T14:30:00Z", end="2026-05-21T15:30:00Z",
    )
    print(f"    Billable size of last pull: {balance} bytes")
except Exception as e:
    print(f"    (balance check not supported in this SDK version: {e})")

print("\n" + "=" * 60)
print("Smoke test complete.")
print("=" * 60)
