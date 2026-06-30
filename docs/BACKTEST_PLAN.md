# Bot Retrospective + Virtual Backtest Environment — Plan

Status: PLAN (2026-06-10). No code changes yet. Companion to `docs/ARCHITECTURE.md` (the data lake)
and memory `audit_backtest_correctness.md`.

---

## Part 1 — Retrospective: why the bots bleed (evidence, read-only)

**All trading is PAPER/DEMO — no real money lost.** alpaca_paper −$10,730 (96), tiger_demo −$2,154 (46),
older/blank −$3,713 (51). Bots still active (2 bots_advance + 2 bots), last entry 2026-06-09.

**Realized P&L on closed trades:**

| Engine | Trades | Win rate | Total P&L | Profit factor | Avg winner | Avg loser | Hold |
|---|---|---|---|---|---|---|---|
| `trades` (Alpaca) | 112 | 14.3% | −$14,788 | **0.02** | +0.25% | −3.28% | 0.9d |
| `bot_advance` | 82 | 32.9% | −$1,809 | 0.13 | +1.07% | −3.96% | 0.6d |

**Five root causes:**
1. **Backwards risk asymmetry (the killer).** Winners cut to +0.25–1%, losers run to −3 to −4%; stops fire
   at −10.7% (`hard_stop`) and −21% (`stop_loss`), both 0% win. PF 0.02. Only `trail_stop` is positive
   (+$79, 67% win). → cutting winners, letting losers run.
2. **Entry signal has no edge.** 14–33% win. Conviction does NOT predict: 80-100→17%/−3.97%,
   70-79→13%/−5.26% (worst), <60→12%/−2.19%.
3. **Chases momentum in the reversal zone.** Holds <1d; corrected lake proves 20d momentum mean-reverts
   over 5–10d in every regime → buys tops.
4. **Validated on flawed data.** Split-adjustment was broken (fake cross-split returns) + ML trained on
   1yr bull (overfit). Backtests looked fine; live lost. (Both now fixed: lake split-adjusted + 10yr.)
5. **Execution/state bugs (ONGOING as of 2026-06-09):** 39 `alpaca_reconcile_phantom`, ~7 `live_quote_
   diverged` (cached price 5–17% off live), 8 `insufficient_capital`; slippage not tracked.

→ poor entries + backwards exits + validated-on-broken-data + execution drift = guaranteed loss.

### Fixes required NOW vs gated on the backtest
- **No emergency — it's all paper/demo.** Do NOT promote any bot to real capital until it passes the
  backtest gate (below).
- **Do NOT hot-fix the strategy** (entry scoring, exit asymmetry). That violates discipline (no
  faith-based changes) and could worsen it. The backtest environment IS the fix path. (The obvious
  first experiment: replace mechanical hard_stop/stop_loss with trail-only — but prove it in sim first.)
- **Worth fixing now (correctness, independent of strategy):**
  1. Root-cause the ongoing **phantom positions** (still created 2026-06-09 — drift-detector only
     *reconciles* them, doesn't stop creation) and **stale-price divergence** (decisions on prices
     5–17% off live). These corrupt data and would cause real losses if ever live.
  2. **Add slippage tracking** (currently null) so execution cost is measurable.
  3. Consider pausing the active bots to **shadow_mode only** until validated (it's paper, so low harm,
     but it stops generating more known-bad trades).

---

## Part 2 — Virtual Backtest / Paper-Trading Environment

**Goal:** replay the bot's REAL decision logic over the corrected historic lake with realistic
fills/costs, measure performance, and make passing it a GATE before any live change (fixes cause #4).

**Principles:** test the real bot code (not a reimplementation) · point-in-time, no look-ahead ·
realistic fills (next-open, slippage, commission, gap-through stops) · portfolio-level (sizing, max
positions, capital, cooldowns) · regime-segmented + vs-SPY benchmark.

**Architecture:**
| Component | Role |
|---|---|
| SimClock | iterate trading days over a window |
| HistoricDataProvider | serve point-in-time prices/features/signals from the lake (DuckDB) as-of each date — never future. Key adapter: live engine reads Yahoo/UW; sim injects historic. |
| **SimBroker** (the "virtual booking") | accept orders → fill next-open w/ slippage+commission, gap-aware stops, track cash/positions/equity |
| StrategyRunner | drive the actual engine (`diagnoseCandidate`/`scoring`/`entry-rules`/`bot-gates`/exits) against historic data |
| Accountant + Reporter | equity curve, CAGR, Sharpe, max DD, profit factor, win rate, avg win/loss, exposure, per-regime, vs SPY, trade blotter |

**Fidelity (crux — engine reads live data in `bot-advance/engine.js` + `scoring.js`):**
- Option A (gold): refactor engine data-access behind `LiveDataSource ↔ HistoricDataSource` → run the
  SAME production code in sim. True fidelity, more work (engine=Node, lake=DuckDB).
- Option B (fast): Python sim re-implementing rules on the lake — quick, but tests a copy.

**Phases:**
- Phase 0 — foundation: corrected lake (split-adj, survivorship-free) + features + regimes. ✅ done.
- Phase 1 — Python portfolio sim (~2–3d): event-driven, realistic fills/costs, portfolio + metrics.
  Measure real economics; fix asymmetry (#1) + entry (#2) before any live change.
- Phase 2 — production-fidelity (~3–5d): Node historic adapter → run the REAL engine via SimBroker;
  validate it reproduces actual past trades (else the sim lies). Leverages existing `shadow_mode`.
- Phase 3 — continuous shadow: run forward daily in paper mode; every change paper-proven.
- Phase 4 — hard gate: nothing goes live until it passes the sim (Sharpe/PF/DD thresholds) per regime.

**Risks:** look-ahead leakage (use point-in-time lake) · fill optimism (model gaps/slippage — current
exit backtest has none) · engine-data coupling (Option A's main effort) · survivorship (use 25k lake).

**Existing to build on:** `src/research/backtest.js`, `scripts/backtest-intelligent-exit.mjs`,
`src/regime-bot/`, `shadow_mode` column, and the `lake/` Python package (Silver/Gold + DuckDB).

**Validation gate for the sim itself:** replay a period the bots actually traded; sim P&L/decisions
must roughly match reality before trusting it.
