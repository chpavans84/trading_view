# Replay Harness — Backtest Infrastructure

Status: **scaffolding in progress 2026-05-23**. Built while XNYS.PILLAR pull runs in background.

## Goal

Replay any strategy against historical minute-bar data from `databento_ohlcv_1m`. Compare its trades, win rate, Sharpe, and drawdown against benchmarks. Allow rule changes to be validated BEFORE shipping to live bots.

## What this is NOT

- Not a live trading engine. Read-only against historical data.
- Not the existing `scorecard.js` / `what-if.js` — those analyze already-logged decisions. This SIMULATES new decisions against frozen history.
- Not coupled to `src/core/bot-engine.js`. Designed to be runnable independently — if the live bot breaks, the harness still works.

## Architecture

```
                                tests/bot-engine/
                                ├── replay-harness.js          ← CLI: `npm run replay -- --strategy sma --from 2024-01-01`
                                ├── replay-engine.js           ← Core: load data, iterate days, simulate fills, track positions
                                ├── strategies/
                                │   ├── buy-and-hold.js        ← Baseline: long SPY from start
                                │   ├── sma-cross.js           ← 50/200 SMA crossover (long-only)
                                │   ├── b37-subset.js          ← B-3.7 composite (signals we have history for only)
                                │   └── regime-gated.js        ← SMA primary + Markov regime gate
                                ├── analytics/
                                │   ├── metrics.js             ← Sharpe, MDD, CAGR, Calmar, win rate
                                │   └── reporter.js            ← Markdown output with equity curves
                                └── README.md                  ← This file
```

Each strategy is a pure function `(day, marketState, portfolio) → orders[]`. The engine handles position tracking, slippage simulation, P&L accounting.

## Data sources

| Need | Source | Available? |
|---|---|---|
| Minute OHLCV (prices, partial volume) | `databento_ohlcv_1m` table | After XNYS pull completes |
| Daily OHLCV (consolidated volume) | `backtest_prices` table | ✓ already there |
| Conviction scores | `conviction_scores` table | ✓ have history (limited) |
| Predictor outputs | `stock_predictions` table | ✓ have some history |
| UW flow, news, GEX, insider | various tables | ⚠ limited history — backtest uses 0 for these signals |

**Lookahead bias prevention:** every query in the strategy filters by `WHERE event_time < current_day` so the strategy can only see data it would have had at decision time.

## Execution model

- **Fill:** at NEXT minute bar's open after signal fires. Captures the realistic delay between scanner decision and order execution.
- **Slippage:** 5 bps one-side (adverse). Configurable per backtest.
- **Commissions:** 0 (Alpaca paper is commission-free; if testing live execution add per-share).
- **Stops:** checked at each minute bar. If intraday low touches stop, fill at stop price + slippage.
- **Trailing stops:** updated at each new high. Same exit logic as B-3.7's `_manageOpenPosition`.

## Universe

Default: 116 instruments (SP100 + 15 ETFs). Can be narrowed via `--symbols` CLI flag for faster runs.

## Output

Each backtest run produces `reports/replay-<strategy>-<timestamp>.md` with:

1. Top-line stats — total return, CAGR, Sharpe, MDD, # trades, win rate
2. Equity curve (markdown table — ASCII-art chart for at-a-glance)
3. Trade ledger — every trade with entry/exit/PnL
4. Comparison row — vs buy-and-hold SPY benchmark
5. Configuration used (rules, slippage, costs)

## How to use (once shipped)

```bash
# Buy-and-hold baseline
npm run replay -- --strategy buy-and-hold --from 2023-04-01 --to 2026-05-22

# Simple SMA crossover
npm run replay -- --strategy sma-cross --from 2023-04-01 --to 2026-05-22 --symbols SPY,QQQ,AAPL,NVDA

# B-3.7 subset (only the signals we have history for)
npm run replay -- --strategy b37-subset --from 2024-01-01 --to 2026-05-22

# Regime-gated (SMA + Markov bull-only gate)
npm run replay -- --strategy regime-gated --from 2023-04-01 --to 2026-05-22
```

## Honest limitations to document up-front

1. **No UW / news / GEX / insider in backtest** — we lack history. Strategies that depend heavily on these (B-3.7) will under-perform their live equivalent. Use the harness for RELATIVE comparison between strategies, not absolute predictions.
2. **Partial volume from Databento XNAS+XNYS** (~30-50% per stock) — affects volume ratio signals. Daily Yahoo volume used as fallback for absolute thresholds.
3. **No corporate actions handling** — `backtest_prices` has split-adjusted closes but Databento's raw OHLCV may not be fully adjusted. Manual verification needed for stocks that split during the window.
4. **No survivorship bias correction** — only trades stocks that exist today. Inflates returns by 1-3% annually (the Lehman/Enron problem). Acceptable for v1; would need Norgate to fix.
5. **Simple slippage model** — fixed 5 bps. Real-world slippage varies with size, liquidity, time of day, regime. Good enough for relative comparison.

## Status

| File | Status | Notes |
|---|---|---|
| README.md | ✅ this file | |
| replay-engine.js | 🔨 in progress | Core simulator |
| strategies/buy-and-hold.js | 🔨 in progress | Baseline |
| strategies/sma-cross.js | 🔨 in progress | Simple long-only |
| analytics/metrics.js | 🔨 in progress | Sharpe / MDD / etc. |
| replay-harness.js | 🔨 in progress | CLI entry |
| strategies/b37-subset.js | ⏸ later | After data verified |
| strategies/regime-gated.js | ⏸ later | After Markov integrated |
| replay.test.js | ⏸ later | Unit tests |
