# Bot Intelligence — Design Doc

> **Status:** Draft 1 · created 2026-05-27 · awaiting Pavan's review
> **Owner:** Pavan + Claude (shared contract)
> **Living document.** Every change to trading logic must add a row to the Decision Log at the bottom.

---

## 0. The Contract

**No code change to trading logic ships without all three of these:**

1. A section in this document explaining what's changing and why.
2. A backtest table — baseline vs. proposed — with sample size ≥ 100 and an explicit edge metric (forward 5-day or 10-day return delta vs. baseline).
3. A row appended to the Decision Log at the bottom of this doc.

If a proposed change can't pass these gates, it doesn't ship. We go back to the design.

This document is the **shared mental model** for the bot. If it's not in here, it's not real.

---

## 1. Current State — Brutal Honesty

The bot today is, structurally:

```
composite_score = Σ (fixed_weight × signal_value)
if composite_score ≥ threshold AND every hard_gate passes:
    BUY $5000_worth
```

That is a calculator, not a trader. Specifically:

- **7 fixed signals** with **arbitrary fixed weights** (UW 30%, news 22%, GEX 15%, insider 15%, conviction 10%, distance_52w 8%, predictor 0%) — none of these weights have been measured against forward returns.
- **No regime awareness** — same scoring runs in VIX 12 (risk-on) and VIX 35 (risk-off). The bot can't tell the difference.
- **No memory** — the bot bought SWKS three times last week. Whether SWKS paid off doesn't feed back into next week's scoring.
- **Hard gates kill most of the universe before scoring** — most damagingly, `gateUwLabel` requires `bullish` or `strong_bullish` UW flow, and ~50–70% of large-cap candidates have no UW flow on any given day. They're rejected before any signal reaches a score.
- **5 setup types but the classifier rejects ~98%** of candidates. Most decisions on a typical day end with `skip_unclassifiable_setup`, meaning the classifier said "I can't bucket this." That's classifier-too-strict, not stocks-too-bad.
- **Composite + grade are inputs to a single binary BUY/SKIP** — no confidence, no half-size, no "watch but don't buy yet." A 71-score and a 99-score get the same action.

### What we discovered on 2026-05-27 (the audit that motivated this doc)

| Finding | Evidence |
|---|---|
| Universe filter silently dropped MU/AMD/MRVL/NVDA via NULL `adv_dollar_30d` | 491 of 734 gainers ≥5% on 2026-05-26 killed by this single NULL check |
| `price_max = 500` cut every fractionable mega-cap above that price | MU $895, AMD $503, KLAC $2011 all excluded |
| ARCA-listed ETFs (SOXL, SPY, XLK) were never in the universe | `ALLOWED_EXCHANGES = {NYSE, NASDAQ}` only |
| `min_composite_score = 40` was actively harmful | 90-day backtest: 40-49 bucket = 46.6% win rate (worse than coin flip), +2.14% avg 10d return |
| UW labeler returns `no_data` 100% of the time in `conviction_scores` (last 7 days, 15,699 rows) | One column query confirmed |
| `gateUwLabel` therefore rejects every candidate when the labeler is silent | Code reads gate, gate reads label, label is always no_data |
| Bot didn't run at all on Mon 2026-05-19 | Zero rows in `bot_decisions` for that date — no heartbeat alarm caught it |
| Composite-score renormalization (skip null signals) was fixed earlier, in code | Verified at bot-engine.js:327-335 |

### Shipped 2026-05-27 (already live in production)

- ✅ Universe filter NULL-ADV escape (mktcap ≥ $10B trusted as liquidity proxy when ADV is missing)
- ✅ `price_max` raised 500 → 2500 (in DB rules + 5 code defaults)
- ✅ `ALLOWED_EXCHANGES` += ARCA, BATS in `universe-sync.js`
- ✅ Full universe re-sync — 12,296 Alpaca-tradable assets fetched
- ✅ ADV backfill from `backtest_prices` — 2,278 rows populated
- ✅ `min_composite_score` raised 40 → 70 (DB rules + all code defaults), justified by backtest

### NOT shipped, deferred to this doc

- ❌ `gateUwLabel` removal / softening
- ❌ Setup classifier rewrite
- ❌ Per-gate rejection logging (so notes column tells us WHICH gate fired, not "none passed")
- ❌ Bot heartbeat alarm
- ❌ Sub-sector tagging + relative-strength scanner
- ❌ Regime detector
- ❌ Memory lookup
- ❌ Bull/bear case builder
- ❌ Exit planner

---

## 2. What "Intelligent" Means Concretely

**Intelligent is not a vibe.** It means the bot can answer these seven questions about every BUY (or SKIP) decision, in plain English, with evidence:

### 2.1 "What kind of trade is this?"

- **Today:** `setup_type` is a one-word label (e.g. "momentum", or null).
- **Intelligent:** structured thesis output:
  ```
  {
    "setup_type": "catalyst",
    "thesis": "UBS triple PT on MU drives institutional rerating; memory supercycle confirmation",
    "expected_hold_days": [3, 10],
    "exit_conditions": ["composite < 60", "stop −7%", "thesis invalidation (NVDA earnings miss)", "time-out 4w"],
    "key_risks": ["NVDA earnings reaction", "DRAM contract pricing reversal"],
    "evidence": ["benzinga_news_id=547399", "uw_flow_24h_premium=$206M", "conviction_grade=A"]
  }
  ```

### 2.2 "What regime am I in?"

- **Today:** single VIX gate (skip if VIX > 60).
- **Intelligent:** classify market state into one of `{risk_on, neutral, risk_off, vol_spike}` from:
  - VIX level + 5-day change
  - SPY 50-day slope (uptrend / sideways / downtrend)
  - Breadth (Advance/Decline ratio)
  - Sector rotation map (which sub-sectors are leading)
  - Output: `{ regime, strength_0_100, confidence_0_100 }`
  - Used to: adjust thresholds (lower in risk-on, raise in risk-off), scale position size, prefer different setups.

### 2.3 "Has this exact setup worked recently?"

- **Today:** no memory — the bot is amnesiac.
- **Intelligent:** before placing a trade, query closed trades from last 30 days where `setup_type = current_setup AND regime = current_regime`:
  ```
  Catalyst trades in risk-on regimes (last 30d):
    8 winners / 3 losers, +4.2% avg P&L, 73% win rate
  → confidence adjustment: +15%
  ```
  Or:
  ```
  Mean-reversion trades in vol-spike regimes (last 30d):
    1 winner / 6 losers, −3.1% avg P&L
  → confidence adjustment: −30%, downsize to half
  ```

### 2.4 "Where's the contradiction?"

- **Today:** average all signals into one composite. Bull and bear evidence cancel mathematically.
- **Intelligent:** build bull case and bear case **separately**, then require asymmetry:
  ```
  Bull case (score 78):
    - UW bullish flow $200M (weight 30, value 80)
    - A-grade conviction (weight 10, value 90)
    - Insider buy $250k (weight 15, value 100)
    - Positive news 12 articles, 9 positive (weight 22, value 70)
  Bear case (score 35):
    - 52w high → mean reversion risk (weight 15, value 65)
    - RSI 78 → overbought (weight 10, value 70)
    - Earnings in 4 days (weight 15, value 40)
  Ratio: 78 / 35 = 2.23x → asymmetric, take it
  ```
  Reject when `bear_score >= bull_score / 1.5` (i.e., bears are >67% of bulls — too risky).

### 2.5 "What's my expected exit, not just entry?"

- **Today:** static stop_loss / take_profit % set when the bot was created. Same exits for every trade.
- **Intelligent:** exits computed per-trade from:
  - **Volatility-aware stop:** entry − 1.5 × ATR(14) (not arbitrary 7%)
  - **Setup-aware target:** catalyst trades: composite drop below 60; momentum: trail by 3 × ATR; mean-reversion: target = 20-day mean
  - **Time-out:** never hold a catalyst trade > 4 weeks (thesis fades); never hold a momentum trade > 5 days
  - **Re-evaluation triggers:** earnings approaching → tighten stop; regime shift → reduce size

### 2.6 "What's my confidence, given missing data?"

- **Today:** missing data is treated as zero signal (good — renormalization fix) but ALSO treated as DISQUALIFYING via `gateUwLabel` (bad — kills 50-70% of universe).
- **Intelligent:** missing data lowers **confidence**, not eligibility. Output:
  ```
  composite_score: 78 (from 4 of 7 signals firing)
  data_coverage: 57% (4/7 signals had data)
  confidence: 0.78 × 0.57 = 44%
  position_size: base_size × confidence = $5000 × 0.44 = $2200
  ```
  The bot still trades, but at proportional size to its confidence. Half-position on half-confident setup is a real-world trader habit; the bot should match it.

### 2.7 "Why am I NOT in this trade?"

- **Today:** rejection notes are vague: "none passed hard gates or setup classification". Useless for debugging.
- **Intelligent:** every rejection cites the specific gate + value + threshold:
  ```
  symbol=MRVL  rejected=true  gate=gateUwLabel  value="no_data"  threshold="bullish|strong_bullish"
  symbol=KLAC  rejected=true  gate=composite_score  value=68  threshold=70  setup_type=catalyst
  ```
  Then we can audit: "Why didn't the bot take X today?" → one DB query, one specific answer.

---

## 3. The Five Thinking Primitives

Each is a module that produces a structured output the bot's decision layer consumes. Each gets its own backtest gate before it can affect live trading.

**Where Claude (LLM) fits — the governance rule:**

> **The bot runtime is 100% deterministic. Claude reasoning is a consumption layer via Claude Desktop + MCP tools (using Pavan's Max subscription, NOT the Anthropic API).**

Two architectural constraints driving this:
1. Pavan already pays $200/mo for Claude Max. We don't pay extra per-token through the Anthropic API for bot work.
2. A trading bot must not depend on a network LLM call to decide trades — that's a latency, cost, and reliability liability we won't accept.

So the split:
- **Deterministic core** (Node, SQL, every primitive below) — produces structured facts: scores, ratios, gate results, exits. This is what the bot acts on. Runs every 5 min in production.
- **Consumption layer** (Claude Desktop, on-demand) — Pavan opens Claude Desktop, asks questions ("why didn't the bot buy MU today?", "give me a weekly retrospective"), and Claude Desktop calls MCP tools that read the structured data and narrates plain-English explanations. Uses Pavan's Max subscription. Zero incremental cost.

This is the same pattern already in production for the 99-tool MCP server (`tradingview-mcp` + `bot_verdict`, `portfolio_advisor`, `system_health`, etc.). We extend it — add the new MCP tools the thinking primitives need so Claude Desktop can audit them — but the bot itself never calls Claude.

Each primitive below marks **[deterministic — runs in bot]** vs **[MCP tool — Claude Desktop calls on-demand]** so the responsibility split is unambiguous.

### 3.1 Setup Classifier (refactor existing)

- **[deterministic — runs in bot]** Input: signals + indicators + recent price action + news + earnings calendar
- **[deterministic — runs in bot]** Output: `{ setup_type, expected_hold_days, exit_conditions_struct, key_risks_struct, evidence_refs }` — all factual data the bot acts on. Stored in `bot_decisions.factor_breakdown` and `bot_decisions.thesis` (as structured JSONB, not prose).
- **[MCP tool — Claude Desktop calls on-demand]** New MCP tool: `explain_setup(symbol, decision_id)` returns the structured setup data; Claude Desktop narrates it in plain English when Pavan asks.
- **Setups (initial):** `catalyst`, `breakout`, `momentum`, `mean_reversion`, `signal_stack`, `null (no thesis)`
- **Backtest gate:** classified setups must show **+3% or more avg 10-day return** vs. unclassified baseline, on ≥ 100 samples per setup type.
- **Today's problem:** classifier returns null for ~98% of candidates. Either it's too strict, or the indicators it reads (RSI, MACD, EMA, news sentiment) aren't being computed. Need to audit before rewriting.

### 3.2 Regime Detector (new)

- **[deterministic — runs in bot]** Input: VIX (level, 5d Δ), SPY (close, 50d slope), market breadth (advancers / decliners), sector rotation (top-3 sub-sectors by 5d RS vs. SPY)
- **[deterministic — runs in bot]** Output: `{ regime, strength_0_100, confidence_0_100, sub_sector_leaders, sub_sector_laggards }` — pure rules. Written to new `regime_snapshots` table, one row per scan.
- **[MCP tool — Claude Desktop calls on-demand]** New MCP tool: `get_regime_state()` and `get_regime_history(days)`. Pavan asks Claude Desktop "what regime are we in?" or "explain today's regime shift" — Claude Desktop pulls the structured rows and narrates.
- **Used by:** threshold adjustment, position sizing, setup preference, exit tightness
- **Backtest gate:** regime-adjusted thresholds outperform static-70 threshold on a 90-day walk-forward backtest by ≥ 100 bps annualized.

### 3.3 Memory Lookup (new — uses existing `trades` table)

- **[deterministic — runs in bot]** Input: `setup_type` + `regime` + `sub_sector`
- **[deterministic — runs in bot]** Output: `{ n_recent_trades, win_rate, avg_pnl_pct, best_trade, worst_trade, confidence_adjustment }` — the numeric memory the bot acts on.
- **[MCP tool — Claude Desktop calls on-demand]** New MCP tool: `summarize_closed_trade(trade_id)` and `weekly_trade_review(days)`. Pavan asks Claude Desktop "review last week's trades" — Claude Desktop pulls structured trade rows + entry context + market regime + signals at entry, and narrates post-mortems. **No automated nightly cron with LLM** — fully on-demand.
- **Used by:** bot adds/subtracts confidence from current candidate based on whether similar setups in similar regimes have worked.
- **Backtest gate:** memory-adjusted confidence-weighted P&L beats unweighted P&L on a 60-day forward test by ≥ 5% relative.

### 3.4 Bull/Bear Case Builder (new)

- **[deterministic — runs in bot]** Input: signals + indicators + news + earnings + technicals
- **[deterministic — runs in bot]** Output: `{ bull_factors[], bull_score, bear_factors[], bear_score, ratio, asymmetric: bool }` — the asymmetry decision is pure code. **The bot acts only when `ratio ≥ 1.5` from this deterministic computation.** No LLM in the live decision path.
- **[MCP tool — Claude Desktop calls on-demand]** New MCP tool: `bull_bear_breakdown(symbol)` returns the structured factor lists. When Pavan asks "what's the bull case for MU vs bear case?", Claude Desktop narrates the trade-offs from the structured data.
- **Used by:** replaces single composite gate with asymmetry gate (`ratio ≥ 1.5`).
- **Backtest gate:** asymmetry-gated trades outperform single-composite-gated trades by ≥ 3% on forward 10-day return.

### 3.5 Exit Planner (new)

- **[deterministic — runs in bot]** Input: `setup_type` + `entry_price` + `ATR_14` + `signals_at_entry` + earnings calendar
- **[deterministic — runs in bot]** Output: `{ initial_stop, initial_target, time_out_days, trailing_rule, re_eval_triggers[] }` — every number is computed in Node. Written to `trades` table as structured columns.
- **[MCP tool — Claude Desktop calls on-demand]** New MCP tool: `explain_exits(trade_id)` returns the structured exits; Claude Desktop narrates the plan in plain English when Pavan asks.
- **Used by:** every BUY decision includes structured exits, written to `trades` table.
- **Backtest gate:** ATR-based + time-out exits beat fixed-% exits on a 90-day backtest of closed trades by ≥ 5% relative P&L improvement.

### 3.6 Claude / LLM Integration Pattern — Claude Desktop + MCP only

**The hard rule (non-negotiable):**

> **The bot does not call any LLM. Ever. The bot writes structured facts to the database. Claude Desktop (Pavan's Max subscription) reads those facts via MCP tools and reasons over them on-demand.**

**Why this constraint:**

1. **Cost.** Pavan already pays $200/mo for Claude Max. Anthropic API calls inside the bot would be incremental per-token cost on top of that, indefinitely. Not acceptable.
2. **Reliability.** A trading bot that depends on a network LLM call to decide trades has a new failure mode (API down, rate-limit hit, model deprecated). Deterministic-only bot = deterministic reliability.
3. **Auditability.** Every bot decision must be reproducible from the structured DB data alone, with no opaque "the LLM said X" in the chain. If Pavan re-runs Thursday's data in 6 months, he gets the same answer.

**How reasoning happens (the consumption pattern):**

```
[Bot runtime — fully deterministic, no LLM]
    │
    ▼
[Postgres — structured facts: bot_decisions, trades, regime_snapshots,
            signal_returns, candidate_signals, factor_breakdown JSONB]
    │
    │   ← Claude Desktop (Pavan's Max subscription)
    │   ← calls via MCP server (stdio)
    ▼
[New MCP tools that read structured data and return facts]
    │
    ▼
[Claude Desktop renders prose using Pavan's subscription credits — zero extra cost]
```

**MCP tools to add for this consumption pattern** (each one is deterministic — returns structured facts; Claude Desktop turns them into narratives):

| New MCP tool | What it returns | Pavan asks Claude Desktop |
|---|---|---|
| `explain_bot_decision(symbol, date)` | bot_decisions row + signals + gates that fired/blocked | "why didn't the bot buy MU on May 21?" |
| `why_didnt_bot_buy(symbol, days=1)` | per-gate rejection trace with values vs thresholds | "what's blocking AMD today?" |
| `summarize_closed_trade(trade_id)` | trade row + market context at entry/exit + signals + regime | "review my last 10 closed trades" |
| `weekly_bot_retrospective(days=7)` | structured weekly facts: wins, losses, top blind-spots, signal performance | "give me Saturday's retrospective" |
| `get_regime_state()` / `get_regime_history(days)` | current + historical regime classifications + sub-sector leaders | "what regime are we in? when did it shift?" |
| `bull_bear_breakdown(symbol)` | structured bull/bear factor lists with weights and ratio | "make the bull and bear case for KLAC" |
| `explain_setup(symbol, decision_id)` | setup classification + structured thesis + exits | "what's the thesis on MU?" |
| `explain_exits(trade_id)` | structured exit plan + ATR + time-out + triggers | "explain my stop/target on the SWKS trade" |

All of these extend the existing pattern of `bot_verdict`, `portfolio_advisor`, `system_health` (CLAUDE.md §"Path B"). Same conventions, same MCP server, no new infrastructure.

**What this looks like in daily use:**

- **Morning briefing:** Pavan opens Claude Desktop → "summarize what the bot did yesterday and why" → Claude calls MCP tools → reads bot_decisions + trades → narrates the briefing using Max subscription. Zero extra cost.
- **Investigation:** Pavan asks "why didn't the bot buy MU on May 21?" → Claude Desktop calls `why_didnt_bot_buy('MU', date='2026-05-21')` → reads per-gate trace → "Universe filter excluded MU because adv_dollar_30d was NULL. Even if it had passed, gateUwLabel would have rejected it because UW returned no_data. Both have since been fixed."
- **Weekly retrospective:** Saturday morning Pavan asks "weekly review" → Claude calls `weekly_bot_retrospective(7)` → narrates the win/miss breakdown with data.

**What stays in the bot's runtime code:**

- ✅ All scoring, gating, decision logic — pure Node
- ✅ All trade execution — broker SDK only
- ✅ All data writes to Postgres — structured columns + JSONB
- ❌ **No Anthropic SDK calls in any new bot-intelligence code we ship**
- ❌ **No automated LLM cron jobs** — Claude Desktop is reactive (Pavan-driven), not proactive
- ❌ **No `claude` CLI in shell pipelines for the bot brain** (CLI is fine for ad-hoc Pavan-initiated research, not unattended crons)

**What about existing Anthropic SDK usage?**

`ai-chat.js`, `sentinel.js`, and `admin-ai.js` already call the Anthropic API. **Those stay as-is** — existing surfaces Pavan explicitly opted into, with cost tracking already wired. This constraint applies only to **new code for the bot intelligence layer**.

---

## 4. Data the Bot Needs to Think

| Data | Status | Plan |
|---|---|---|
| Sub-sector tags (memory, fabless, equipment, etc.) | NULL for most | Compute from Yahoo `industry` + manual override table for top 100 |
| Relative strength vs sub-sector ETF | not computed | Daily cron writes to new `relative_strength` table |
| Intraday 1-min bars | ✅ Databento (43M rows, 115 symbols, 3yr history) | Start using it (currently zero code reads this table) |
| Catalyst attribution (analyst PT changes) | not collected | Benzinga ratings endpoint — free with current key |
| Earnings calendar history | only "next 7d" rolling | Backfill from Benzinga or UW |
| Regime indicators | partial (VIX only) | Compute SPY slope, A/D ratio, sector rotation map |
| Trade memory | `trades` table exists ✅ | Build query layer |
| Setup-tagged forward returns | proposed `signal_returns` | **M1 deliverable — mandatory infra** |
| News sentiment history (queryable) | `benzinga_news` exists ✅ | Already there — wire it into thesis builder |

**No new paid data subscriptions required for M1–M4.** Databento + Benzinga + UW + existing DB is enough. Tiingo / FMP / Polygon revisited only if a measurable gap is identified.

---

## 5. Architecture

```
[ Scanners — each independent, each writes provenance ]
  TopMovers · VolumeSpike · Catalyst · SmartMoney · Breakout
  MeanReversion · SectorRotation · Watchlist
       │
       ▼
  candidate_signals table (symbol, scanner, signal_type, confidence, payload, ts)
       │
       ▼
[ Aggregator — dedup by symbol, build confidence-weighted buckets ]
       │
       ▼
[ 🧠 Thinking Layer ←─── NEW ]
  ├─ Setup Classifier   → thesis + hold window
  ├─ Regime Detector    → market state
  ├─ Memory Lookup      → "have we done this before? did it work?"
  ├─ Bull/Bear Builder  → require asymmetry
  └─ Exit Planner       → stops + targets + time-out
       │
       ▼  { setup, regime, confidence, bull_bear_ratio, exits } per candidate
       │
[ Bot Strategy — subscribes to buckets, applies regime-adjusted thresholds, sizes by confidence ]
       │
       ▼
[ Trade Execution → trades table ]
       │
       ▼
[ Trade Postmortem cron → signal_returns ──► memory ──► loop back ]
```

The current bot collapses Scanners + Aggregator + Thinking into one 800-line `_buildCandidateUniverse` → `_scoreCandidate`. The redesign splits these so each can be tested, swapped, and measured independently.

---

## 6. The Measurement Gate (non-negotiable)

```
NO CODE CHANGE TO TRADING LOGIC SHIPS WITHOUT:
  1. A section in this doc explaining the change
  2. A backtest table — baseline vs. new, with N ≥ 100 samples
  3. A Decision Log entry — date, change, baseline number, new number, reason
```

Backtest SQL queries live in `src/research/backtests/` as committed `.sql` files. They are runnable end-to-end so we can re-execute the same test in 30 days and see if our claimed edge held.

**The signal_returns table is M1 infrastructure** — without it, none of the other measurement gates can be evaluated, so it ships first.

---

## 7. Out of Scope (for now)

To stop scope creep killing us, the following are **explicitly deferred** to a separate design doc:

- **Options trading** — Pavan said to defer, deferred.
- **Crypto** — different market structure, different data feeds.
- **Margin and shorts** — different risk profile.
- **Multi-asset portfolio optimization** — single-stock setups first.
- **RL / neural net models** — start with interpretable rules + measured weights. We can't trust black boxes when interpretable rules are still failing.
- **Auto-tuning hyperparameters** — only after M1–M7 are stable.
- **Multi-user / multi-tenant scaling** — Pavan's accounts only, until proven.

---

## 8. Roadmap with Backtest Gates

Each milestone has a backtest gate. **If the gate fails, the milestone does not ship — we redesign.** No exceptions.

| M | Deliverable | Backtest Gate | Status |
|---|---|---|---|
| **M1** | `signal_returns` table + 90d backfill from Databento + 🎯 Signal Edge dashboard panel | Forward-return measurable for every existing signal (UW, news, insider, conviction, GEX, distance_52w). Output table exists, panel renders. | **TODO** |
| **M2** | Per-gate rejection logging + bot heartbeat alarm | Every `bot_decisions` row carries `rejected_gate` when rejected. Heartbeat fires if no decisions logged for ≥ 15 min during market hours. | **TODO** |
| **M3** | Setup classifier rewrite + thesis output | Classified setups show ≥ +3% avg 10d return vs. unclassified baseline on ≥ 100 samples per setup type | **TODO** |
| **M4** | Sub-sector tagging + relative-strength scanner | Lead-lag rotation signals show ≥ +3% edge on 5d forward return vs. random | **TODO** |
| **M5** | Regime Detector + regime-adjusted thresholds | Regime-adjusted thresholds outperform static-70 by ≥ 100 bps annualized on 90d walk-forward backtest | **TODO** |
| **M6** | Memory Lookup + Bull/Bear Builder | Confidence-weighted P&L beats unweighted by ≥ 5% relative on 60d forward test | **TODO** |
| **M7** | Exit Planner replaces static stops | ATR + time-out exits beat fixed-% exits on closed trades by ≥ 5% relative P&L | **TODO** |

**Soft target:** M1 within 3 days, M2 within 1 week, M3–M4 within 2-3 weeks, M5–M7 within 6 weeks total.
**Hard constraint:** Backtest gate must pass. If it doesn't, we don't move to the next milestone — we either improve the design or accept the milestone is wrong and replace it.

---

## 9. Pending Fixes — Held Until Design Decides

These were proposed during the 2026-05-27 session but **NOT shipped** pending evaluation by this doc:

- [ ] **Remove or soften `gateUwLabel`.** Proposed: drop hard requirement, let UW be a signal (already 30% weight). Backtest first: would the 70+ composite-score trades that *included* `no_data` UW symbols have positive forward edge? Likely yes — but verify before shipping.
- [ ] **Per-gate rejection logging.** The notes column says "none passed hard gates" — useless. Replace with specific gate name + value + threshold. M2 deliverable.
- [ ] **Bot heartbeat alarm.** Monday 2026-05-19 the bot didn't log a single decision and nobody noticed. M2 deliverable.
- [ ] **Setup classifier looseness investigation.** ~98% of candidates currently `skip_unclassifiable_setup`. Need to audit the classifier function (`src/core/bot-setup-classifier.js`) to find which sub-gate inside it is rejecting. Probably one specific check (e.g. "requires news article count ≥ 3 in last hour") that's too tight. M3 deliverable but might be a quick win to address sooner.

---

## 10. Decision Log (append-only)

| Date | Change | Baseline | New | Reason |
|---|---|---|---|---|
| 2026-05-27 | `min_composite_score` 40 → 70 (all 4 active bots + 8 code defaults) | 40-49 bucket: 46.6% win rate at 10d, +2.14% avg return (N=1,183) | 70+ bucket: ~70% win rate at 10d, +9.98% avg return (N=9,564) | Score 40-49 was negative-edge vs. random baseline (0-39 bucket: 66% / +3.02%). Lowering to 40 told the bot to take its worst trades. |
| 2026-05-27 | Universe filter NULL-ADV escape (`mktcap ≥ $10B` trusted as liquidity proxy) | 245 names in baseline candidate pool | 800 names | 67% of `tradable_universe` had NULL `adv_dollar_30d`; `NULL >= 5e6` is false in SQL; mega-caps (MU, AMD, MRVL, NVDA, KLAC, AMAT, LRCX, AVGO) silently dropped. 491 of 734 gainers ≥5% on 2026-05-26 killed by this single NULL check. |
| 2026-05-27 | `price_max` 500 → 2500 (DB + 5 code defaults) | MU $895, AMD $503, KLAC $2011, SOXX $570 all excluded | included | `fractionable = TRUE` makes dollar-sized orders trivial. The price cap was a holdover from non-fractional days. |
| 2026-05-27 | `ALLOWED_EXCHANGES` += {ARCA, BATS} + full universe re-sync | NYSE+NASDAQ only (8,333 rows) | NYSE+NASDAQ+ARCA+BATS (12,296 rows) | Every major sector / leveraged ETF (SOXL, SPY, XLK, IWM, GLD) trades on Arca. NYSE/NASDAQ-only filter silently excluded all of them. |
| 2026-05-27 | ADV backfill from `backtest_prices` | 5,451 rows with NULL `adv_dollar_30d` | 2,278 NULL rows populated; 3,173 still NULL (no backtest data) | Backtest_prices has 3yr daily OHLCV — computing `avg(close × volume)` gives a clean ADV. Filled the NULLs the sync hadn't covered. |
| 2026-05-27 | BOT_DESIGN.md created (this doc) | — | — | First version of intelligent-bot design contract. Pending review by Pavan. |
| 2026-05-27 | §3.6 Claude/LLM Integration Pattern added | — | — | Per Pavan: use Claude (both Anthropic SDK runtime + `claude` CLI for batch) wherever building this intelligence system requires it. Hard rule: Claude writes prose, deterministic code owns every number that touches a trade. Daily budget cap $1.00, est. monthly $10–25. |
| 2026-05-27 | §3.6 REVISED — Claude Desktop + MCP only, no Anthropic API | $10–25/mo proposed | $0/mo (uses existing Claude Max sub) | Per Pavan: "don't use claude api, use claude desktop." Bot runtime stays 100% deterministic. LLM reasoning is a consumption layer via Claude Desktop calling new MCP tools (`why_didnt_bot_buy`, `summarize_closed_trade`, `weekly_bot_retrospective`, etc.) using Pavan's Max subscription. Zero incremental cost. Existing ai-chat.js / sentinel.js Anthropic API usage unchanged. |
| 2026-05-27 | §11 decisions locked + §12 Execution Plan added | 7 open questions | 7 decisions made by Claude | Per Pavan: "you take better decision since you know what we are doing from day 1." Closed: setup classifier waits for M2 observability; sizing deferred to M6; memory window = 30d; gateUwLabel removal pending M1 backtest; watchlist priority unchanged; first MCP tool = why_didnt_bot_buy; MCP wiring verified on deploy. Phase 1 starts next session with 5 observability deliverables, no bot behavior changes yet. |
| 2026-05-27 | Claude Desktop wired to `tradingview-mcp` MCP server | No `mcpServers` block in claude_desktop_config.json | `tradingview-mcp` added with `--env-file` flag pointing to project `.env`. Backup saved as `claude_desktop_config.json.backup.20260527-142113`. Boot-smoked clean (env-loader fires, no startup errors). | Per Pavan: not previously wired. Required for Phase 1.4 (`why_didnt_bot_buy` MCP tool). Pavan must restart Claude Desktop to activate. |
| 2026-05-27 | **Phase 1.1 SHIPPED: `signal_returns` table + 90d backfill** | No measurement infra existed; every change was faith-based | 951,869 rows from `conviction_scores` × signals JSONB joined to `backtest_prices` for forward 1d/5d/10d returns. 40,299 unique decisions per signal, 21,822 with 10d forward windows. Covers ~25 signal names (composite, RSI, RVOL, analyst_consensus, analyst_upside_pct, insider_buys_60d, weekly_trend, drift_5d_pct, rs_score, etc.). | Foundation for every future bot change. M1 mandatory infra complete. First analysis already revealed: (a) momentum wins big in this regime (RSI 70+ → +9.65% / 68%), (b) analyst-consensus signal is INVERTED (analysts most bullish = worst forward returns), (c) insider buying edge is real but weaker than 15% weight suggests. **No weight changes yet** — that's Phase 2+. |
| 2026-05-27 | **Phase 1.5 SHIPPED: `signal_edge_report` MCP tool** | No way to ask Claude Desktop about signal edge | Added to `src/tools/portfolio-advisor.js`. Two modes: (1) no-arg overview returns composite-score buckets + top 15 signals by sample size; (2) `signal=<name>` returns quintile-bucketed analysis for numeric signals (e.g. RSI Q4 70-81 = 73% win, +12.78% avg 10d) OR label-grouped analysis for categorical (e.g. analyst_consensus). Server boot-smoked clean. **Pavan must restart Claude Desktop to see the new tool.** | Phase 1.5 of M1 complete. Tool wraps the SQL we already ran in this session. RSI sweet-spot empirically: Q4 70-81 (mildly overbought) wins 73%; Q5 81+ (extreme) wins 63%. Counter to "RSI overbought = sell" folk wisdom in this 90-day bull regime. |
| 2026-05-27 | **Phase 1.3 — already shipped earlier** | Believed bot Monday silence was an alarm-failure | Scanner watchdog at `src/web/server.js:10309` fires every 10 min during market hours (9-16 ET, Mon-Fri). Sends `sysAlert` email at 8+ min stale ('warn') and 30+ min silent ('critical'). Verified working: fired 8 alerts on 2026-05-26 across the day. | The "Mon 5/19 silence" diagnosis was wrong — no bots existed yet on that date (all 4 active bots created 5/22-5/26). Watchdog never had anything to watch. No new code needed; task marked complete. |
| 2026-05-27 | **Phase 1.2 SHIPPED: Per-gate rejection logging** | "Notes" column said "none passed hard gates" — useless | Modified `_scoreCandidate` in `bot-engine.js` to return `{_blocked: true, gate, value, threshold, message}` instead of `null` when a candidate fails a gate. Caller aggregates rejections into `factor_breakdown.gate_histogram` (e.g. `{uw_label: 32, conviction_grade: 5}`) plus `sample_blocked` (first 5 rejected with full detail). Notes string now reads "Top gates: uw_label×32, conviction_grade×5". Dashboard restarted; live as of next bot scan. | Going forward, every scan that rejected all candidates carries a gate histogram. Past scans (pre-2026-05-27 restart) don't have this — only future ones. Enables Phase 1.4 audit queries. |
| 2026-05-27 | **Phase 1.4 SHIPPED: `why_didnt_bot_buy` MCP tool** | No way to audit historical or current bot decisions per symbol | Added to `src/tools/portfolio-advisor.js`. Returns 4 things: (1) bot_decisions rows for the symbol on the date, (2) gate_histograms from that day's blocked scans, (3) conviction_scores around the date, (4) live `diagnoseCandidate` verdict using current data. Smoke-tested with MU on 2026-05-21 — confirmed MU was never in bot's universe that day (NULL-ADV bug), even though it had RSI 69 + strong_buy analyst consensus. **Pavan must restart Claude Desktop to see the new tool.** | Phase 1.4 of M1 complete. Now Pavan can ask Claude Desktop "why didn't bot buy MU on May 21?" and get the full audit trail. |
| 2026-05-27 | **Phase 2.1 SHIPPED: `momentum_flip` setup override (experimental, capped 5/day/bot)** | Composite-70 threshold cut every score in the 60-69 band even when underlying momentum was turning positive. MU on 5/23 (score 69 + momentum flip + 3 days before +19% rip) is the canonical example. | `_scoreCandidate` in bot-engine.js now checks composite 60-69 + drift_5d_pct>0 + macd_hist>-3 + per-bot daily cap < 5. When all true, override setup_type='momentum_flip', expected_hold_days_max=5, and tag with `_momentum_flip=true` so the caller's threshold gate lets it through. Kill-switch: `entry_filters.momentum_flip_enabled=false`. | **Backtest 90d (N=1,477):** filtered 60-69 = +6.86%/65.5% win at 10d (vs raw 60-69 = +6.92%/65.2% — filter big 5d boost, similar 10d). **Regime-conditional:** filter +3.35pp better in SPY-flat regime; filter -2.5pp WORSE in SPY-up regime (mean-reversion winners in bull markets). Zero data on SPY-down. **Live experiment with capped exposure** so we can collect real-world regime data. Promote to full rule + regime gate in Phase 5 once regime detector ships. |
| 2026-05-27 | **Phase 2.2 investigated — gateUwLabel NOT removed** | Was suspected as the 50-70% rejection culprit | No code change. **Finding:** the raw-flow fallback in `_signalUw` (added earlier) already paves over no_data labels — in last 14 days of bot_decisions, 99.8% of SCORED candidates have label=bullish or strong_bullish. gateUwLabel is effectively a no-op now. Will revisit when Phase 1.2 gate histograms accumulate 2-3 days of live data showing actual rejection counts per gate. | The earlier "100% no_data" stat was from `conviction_scores` (a different scoring path), not bot_decisions. Bot is fine. Indirect evidence from bz_options_sentiment: stocks with neutral/bearish options sentiment at composite 70+ have HIGHER forward returns than bullish-tagged ones — flagged for future weight-tuning Phase. |
| 2026-05-27 | **Phase 2.3 investigated — setup classifier NOT rewritten** | 98% rejection at `skip_unclassifiable_setup` | No code change. **Finding:** the classifier itself (`bot-setup-classifier.js`) has reasonable logic. The catch-all `signal_stack` should fire ~46% of A/B-grade candidates. Real bottleneck is **pre-signal gates** (earnings proximity, liquidity, VIX range, premarket gap) that kill candidates BEFORE reaching the classifier. Phase 1.2 per-gate logging will pinpoint which exact gate over the next 2-3 days of live data. Surgical fix afterward. | Premature classifier rewrite without per-gate data = faith-based change. Discipline holds: backtest first. |
| 2026-05-27 | **Phase 2.4 SHIPPED: `weekly_bot_retrospective` MCP tool** | No automated way to see weekly bot performance with context | Added to `src/tools/portfolio-advisor.js`. Returns: trades opened/closed with P&L, top winners + losers, biggest MISSES (A/B-grade stocks at 70+ that bot never bought — caught via universe filter or gates), gate-histogram summary, action breakdown, composite-edge stats, momentum_flip experiment counter. Smoke-tested with real data (17 trades in last 7d, 150 potential misses). | First retrospective: Saturday 2026-05-30. Pavan asks Claude Desktop "weekly review" → it calls this tool and narrates the analysis using Max subscription. **Pavan must restart Claude Desktop again to pick up this new tool.** |
| 2026-05-27 | **Phase 3.1 SHIPPED: Dashboard AI Chat — Claude Code CLI backend (Max-sub, zero API cost)** | All chat traffic billed against Anthropic API budget | New `src/core/claude-desktop-chat.js` spawns `claude -p` as subprocess. Strips `ANTHROPIC_API_KEY` from child env to force Max-sub OAuth auth. Passes `--mcp-config /Users/pavan/.claude/.mcp.json` (headless mode does NOT auto-discover MCP config — verified 2026-05-27). `--allowedTools` pre-approves 25 read-only tradingview MCP tools so headless model doesn't ask permission. New endpoint `POST /api/chat/desktop` and admin `GET /api/chat/desktop/ping`. Frontend toggle button in chat header (`🌐 API` ↔ `🖥 Desktop`) persisted in localStorage. Smoke-test passed: real `system_health` tool call in 17.7s → "17 ok · 2 warn · 1 fail" with actual data. | Default mode stays `api` (streaming, fast). User opts into `desktop` via toggle. Tradeoff: ~15-30s response vs ~2-5s on API; ZERO incremental cost vs ~$/day on API. Hard-coded paths for now (CLAUDE_BIN, MCP config); cleanup if multi-user later. Existing `ai-chat.js` Anthropic SDK path untouched. |
| 2026-05-27 | **Phase 2.5 SHIPPED: Conviction pre-warm in bot scan** | 72 of yesterday's 90 quality (≥$5B mcap) ≥5% movers had NO conviction_scores row → `_signalConviction` returned value=0 → composite silently dragged down by 10% × 0 | Before the per-candidate scoring loop in `runBotScanForAllActive`, query which of the 50 candidates have a `conviction_scores` row written in the last 60 min. For missing symbols, call `getConvictionScore({symbol})` in parallel batches of 10. The scorer's `recordConvictionScore` writes the row; the bot's `_signalConviction` then reads it. Smoke-tested: LRCX (one of the 72) scored 90/A in 1.5s via the on-demand path. | Adds ~10-30s upfront to scans where many candidates are unscored (mostly market-open scan); subsequent scans hit the cache. Closes the gap where high-quality movers like LRCX, TXN, KLAC, ADI, SCCO, NXPI, STM, TER, WDC, AMAT were invisible to the bot. Expected catch-rate jump: from 13/90 of yesterday's ≥5% movers to ~50-70/90 (the quality mid-caps that were blank are now scoreable). |
| 2026-05-27 | **Phase 2.7 SHIPPED: macd_hist null in conviction_scores (silent technicals failure)** | 0 of 176 conviction_scores rows in 2-hour window had `macd_hist` (or `rsi`, `ema20`, `ema50`). Momentum_flip override was DEAD CODE — gate requires `macd_hist != null` and could never be satisfied. The ~10 days of "we should have caught MU/AMD" was rooted partly here. | Root cause: `getChartTechnicals(symbol)` in `src/core/tradingview-bridge.js` reads chart studies, but the TV chart only shows ONE symbol. When called with a different symbol (49/50 cases during a 50-candidate scan), it returned `available: true` with all-null values instead of falling back to the OHLCV-based computation already used when TV is offline. Fix: detect `symbolMismatch` and route to `fetchFallbackTechnicals(symbol)` which computes MACD/RSI/EMAs from Yahoo 90d daily data. | Smoke-test verified all 5 sampled symbols (AMD, MU, RDW, LUNR, NVDA) now return real `macd_hist`, `rsi`, EMA20/50. Post-restart: 40/40 conviction_scores rows have all technicals (vs 0/176 before). Also tightened pre-warm staleness check to require `macd_hist=number` so pre-2.7 rows are treated as stale and re-scored. **This was 10 days of bot running technically-blind.** Momentum_flip empirical edge (+6.86%/65.5% win) was zero in practice. |
| 2026-05-27 | **Phase 2.6 SHIPPED: `_signalDistance52w` empirically inverted (mean-reversion → momentum)** | OLD mapping penalized stocks within 5% of 52w high with value=-40 and rewarded stocks 20-40% off the high with value=+80. Empirically backwards — mean-reversion logic that fights momentum literature. Top picks under OLD: +2.82%/5d, 58.2% win. | Inverted the mapping based on 21,719-row signal_returns backtest: NEW gives value=80 for within 2% of 52w high (breakout regime), 50 for 2-10% off, 10 for 10-25% off (correction), -40 for >25% off (distressed). Code in `src/core/bot-engine.js` `_signalDistance52w()`. | **Backtest, top 10% by signal score:** OLD +2.82%/5d 58.2% win → NEW **+9.00%/5d 76.6% win** (+6.2pp return, +18.4pp winrate). **Top 25%:** OLD +1.46%/5d 53.6% → NEW +7.06%/5d 68.2%. Far above +3pp ship threshold. AMD/LUNR/RDW/MU (all -3 to 0% from 52w high) jump from -40 contribution to +80 contribution — composite swing ~+9.6pts on 8% weight. Aligns with Jegadeesh-Titman 1993 momentum literature, and Pavan's earlier pushback that "buying at 52w high underperforms" is folk wisdom contradicted by data. |
| 2026-05-27 | **Phase 2.8 SHIPPED: Trail-stop minimum-peak guard + momentum_flip exit rules** | Tonight, all 4 ASML trades (peaks $7-19) and AMAT (peak $5.46) tripped the 30% P&L trail within 6-17 min. Trail of 30% on a $5 peak = $1.50 wide — narrower than ASML's $1593 bid/ask noise. ASML × 3 net +$8.63 (left $80+ unrealized per share on the table), AMAT -$241 (trail fired then market sell filled after a -$11/sh plunge). | Two changes in `src/core/bot-executor.js`: (1) Trail only fires when `peakPnl > dollars_invested * 0.01` (1% of position size — a real move, not bid/ask noise). Hard stop unchanged — protection still active. (2) Added `momentum_flip` to `EXIT_RULES_BY_SETUP` with hard_sl 4%, trail 35%, time_stop 5d — previously fell back to LEGACY (3% hard stop) which contributed to AMAT's $241 loss. | Tonight's 4 trail exits: peaks were 0.05-0.5% of dollars_invested — all under the new 1% threshold, so NONE would have fired under Phase 2.8. ASML bot28 (still open, peak $44.40 = 0.55% of $7969) would have continued to develop. **Restored to live at 22:55 SGT** — observable in the next 4 scans during remainder of session. Hard stops (4% breakout, 4% momentum_flip) are the protective floor; trail kicks in only after the trade has earned the right to be trailed. |
| 2026-05-28 | **Phase 4.1 RESEARCH COMPLETE: Insider signal backtest — 2 years of UW data** | Prior session had 27 days of insider data (1,011 rows), confounded by May-15 cluster. Preliminary result was noise-level (N=12 matched events). | Backfilled 2024-01-01 → 2026-04-30 via UW API: 851 days processed, 88,080 rows inserted, total 90,184 rows across 4,398 tickers. Fixed 3 concurrent bugs: (1) live ingestion cron stored 'buy'/'sell' not SEC codes, stored share-count in value column instead of dollars, and derived null role; (2) migrated all existing rows to SEC codes + dollar values; (3) updated `_signalInsider` in bot-engine.js to match 'P'/'S' (open-market only, excludes 'F'=tax-withholding). Backtest query: N=1,658 insider-purchase events (type='P') matched to backtest_prices for T+5/T+10 forward returns. | **FINDINGS (N=1,658):** Overall insider buys: +2.35%/5d, +3.36%/10d, 59.9% win vs SPY +0.39%/+0.79%/62.7%. Edge: +1.95pp 5d, +2.57pp 10d. **BUY SIZE is the strongest filter** (monotonic): $1M+ buys: +4.59%/66.8% win; $100K-1M: +2.84%/66.3%; $10K-100K: +1.93%/59.1%; <$10K: **+0.62%/48.5% (noise — worse than SPY win rate)**. **ROLE hierarchy:** Director/10%Owner: +3.79%/73.2%; 10%Owner: +2.82%/64.0%; Director: +2.19%/59.0%; Officer: +1.92%/55.5%. **HIGH-CONVICTION SUBSET** (Director buying ≥$100K, N=436): +3.49%/5d, 67.0% win (+3.10pp over SPY). **YEAR CONTROL:** 2024 weak (-0.27%/42.5%), 2025 strong (+2.80%/62.8%), 2026 moderate (+1.59%/55.0%). **CONCLUSION:** Insider buying IS a real signal. Current bot formula (net buy/sell dollar ratio, no size/role filter) uses ALL purchases including noise-level <$10K buys. Phase 4.2 improvement: weight by buy size, exclude buys <$10K, give extra weight to Director/10%Owner. |
| 2026-05-28 | **Phase 4.1B RESEARCH COMPLETE: Congressional trade signal backtest** | No historical congressional data — `uw_congressional_trades` had 105 rows (10 days). UW API limits congress to 90 trading days, same as flow. | Backfilled full 90-day window: paginated 40 pages × 100 rows = 1,825 trades (2025-12-22 → 2026-05-18). Congress buys N=854, sells N=640. Backtest via LATERAL join to backtest_prices using `filed_at` as signal date (when trade becomes public knowledge via STOCK Act). | **FINDINGS (N=854 buys):** All buys: +0.81% 5d, 57.6% win (edge +0.44pp vs SPY +0.37%). By size: $250K-500K: 85.7% win, +3.27% 5d (N=7, too small); $100K-250K: 66.1% win, +0.83% 5d (N=56, reliable). By disclosure lag: 0-5 day filers: +2.34% 5d, 66.7% win (N=15) — quick disclosure = most actionable. By member: Fetterman +4.15% (N=7), Gottheimer +2.38% (N=10). Sell signal inconclusive (stocks also rose, market bias). **CONCLUSION:** Congress signal is real but weaker than insider (+0.44pp vs +1.95pp edge). Not a primary gate — added as +5% weight signal that only participates when recent congressional buys exist for the stock. Email alert added to congress ingestion cron: fires for new buys ≥$15K (skips $1K-$15K noise, skips sells). |
| 2026-05-28 | **Phase 4.2 SHIPPED: Insider signal tightened + Congress signal added** | `_signalInsider` used ALL purchases including <$10K noise (48.5% win, worse than SPY). No role differentiation. No congressional signal in composite. | (1) `_signalInsider` rewritten: exclude buys <$10K, apply 1.5× role weight for Director/10%Owner vs 1.0× Officer, track high-conviction ($100K+ Director buys) separately. (2) New `_signalCongress(symbol)` function: queries `uw_congressional_trades` for recent buys ≥$15K within 30 days, scores 30-100 based on count, size (≥$100K), and disclosure lag (≤5 days). (3) Both signals wired into both `_scoreCandidate` (live bot) and `diagnoseCandidate` (MCP tool / dashboard). (4) `DIAGNOSE_DEFAULT_WEIGHTS` updated: added `congress: 0.05`. Both processes restarted. | **Empirical basis:** Insider <$10K: 48.5% win → excluded. Director/10%Owner 1.5× weight based on: all-Director: 73.2% win vs Officer 55.5% win (17.7pp gap). Congress 0.05 weight based on: +0.44pp edge, 57.6% win (weaker than insider's 0.15 weight). Congress signal returns 0 when no recent buys (excluded from renormalization → no effect on most stocks). Quick-filer bonus (+15 pts) based on: 0-5 day lag = +2.34% 5d vs 30+ day = +0.94% 5d. **Additive, safe — no gates removed, no weights reduced.** |
| 2026-05-28 | **Retrospective fixes SHIPPED: stale-price gate, market-close cutoff, position cap, cron-owner gate** | TTMI entered at $208 with cache showing $189 (5 trading days stale) → -$1,358 loss after gap-through-stop. AMD entered 4 min before close, stopped out 1 min before close → -$200. No per-trade $ cap → $9K AMD position. Suspected duplicate-scan issue (later disproved during deploy — see Process Naming note below). | (1) `gateLiquidityStale` in `bot-gates.js`: block when liquidity.last_date is >2 **trading** days stale (uses weekday-counting helper, handles Thanksgiving/Christmas). Message surfaces `cached_price` for one-shot post-mortems. (2) `gateMarketCloseProximity`: block entries after 3:30 PM ET. Uses `toLocaleString('en-US', { timeZone: 'America/New_York' })` for DST-correct ET wall-clock (initial UTC-arithmetic version was 90 min wrong in winter). Weekend early-out. **Opt-out: `filters.block_late_session = false`** — set this on backtest/replay bots that need late-session entries. (3) `EXIT_RULES_BY_SETUP` in `bot-executor.js`: explicit `price_breakout` entry (was falling to LEGACY 3%), widened all stops 4→6-8%, extended `time_stop_days` to 5-30. (4) New `sizing.max_position_usd` per-bot rule + `planEntry` cap in `bot-sizing.js`: hard ceiling on per-trade $ deployment. Set $1000 on all bots; bot 28 capital $10K → max 10% concentration. (5) `BOT_CRON_OWNER=true` env-var gate on `startBotEngineCrons` and `startBotExecutorCrons`: only the PM2 process with this env var registers the cron. Defense-in-depth + cheap insurance against any future module wiring that adds a second cron registration. DB 15-min dedup guard in `_scoreCandidate` remains as a secondary belt-and-suspenders. (6) `momentum_flip` override: requires `rsi14 < 68` and `drift_5d < 15` so we don't chase overbought/exhausted moves. | **No backtest** — these are defensive guards on broken-fundamentals cases (stale data, EOD volatility, runaway concentration). Empirical motivation: yesterday's -$1,812 loss session. CodeRabbit review caught DST bug in initial UTC-arithmetic version + TOCTOU race in initial dedup-only version + fractional-share strict-equality bug in reconciler — all fixed before merge. **All paper bots: set $1K cap + 70 threshold + momentum_flip_enabled=false.** **PM2 process naming gotcha (discovered during deploy):** `trading-bot` is the MCP **stdio** server (`src/server.js`) — it does NOT run the bot scanner. `trading-dashboard` is the web server (`src/web/server.js`) — it DOES run the scanner + executor crons. PM2 deploy command: `BOT_CRON_OWNER=true pm2 restart trading-dashboard --update-env` (NOT trading-bot, despite the name). Leave trading-bot's env unset. Verify on dashboard startup logs: `[bot-engine] crons scheduled — ...(BOT_CRON_OWNER=true)`. If the env var is missing, the scanner silently stops — better silent than double-fire. |

---

## 11. Decisions Made (was: Open Questions)

Pavan 2026-05-27: *"You take better decision since you know what we are doing from day 1."* — I'm closing all open questions with the choices I'm standing behind, with reasoning. Every choice is reversible if the data later disagrees.

1. **Setup classifier hotfix vs. rewrite** → **Wait for M2 observability.** Hotfixing without per-gate data risks loosening the wrong sub-check and ending up with worse trades, not more trades. Once M2 logging tells us *which* check inside the classifier is rejecting, we fix with evidence. (~1 week wait.)

2. **Confidence-based sizing (half-size on partial data)** → **Defer to M6.** Hard floor for now: bot trades full size when all gates pass, skips otherwise. Adding partial sizing introduces position-math complexity (exits, P&L calc, multi-leg handling) we don't need before measurement infrastructure exists. Revisit once we have memory + regime to feed it.

3. **Memory lookback window** → **30 days.** Reacts faster to regime shifts. If stats are too noisy at 30d, we'll see it in M6 backtests and extend to 60–90 then. Default 30, configurable per setup type.

4. **`gateUwLabel` removal** → **Approved pending M1 backtest result.** The evidence is overwhelming (100% no_data labels in last 7d, gate kills 50-70% of mega-caps). But still backtest first using `signal_returns`: of historical trades where uw_label was no_data but composite-without-UW was ≥ 70, what's the forward 10d return? If positive → ship removal. If negative → soften (allow `neutral` to pass) rather than remove. Decision is data-driven, not voted.

5. **Watchlist priority override** → **Leave as today.** A-grade non-watchlist names can outrank watchlist symbols. Not a known problem; don't fix what isn't broken. Revisit if a real conflict appears in trades.

6. **First MCP tool to build** → **`why_didnt_bot_buy(symbol, date)`.** Highest immediate audit value (you can interrogate any missed trade), and it forces us to build per-gate rejection logging — which M2 needs anyway, so we double up.

7. **Claude Desktop MCP wiring** → **I'll verify on first deployment day.** If `~/Library/Application Support/Claude/claude_desktop_config.json` already references `tradingview-mcp`, new tools land automatically. If not, 5-minute config edit and you restart Claude Desktop. Will document in the post-deploy report.

---

## 12. Execution Plan — what gets built, in what order

**Phase 1 — Observability (this week, 2-3 days)**

The bot's behavior is NOT changed. We add the windows that let us see what's happening.

| # | Deliverable | Backtest gate (none for observability) |
|---|---|---|
| 1.1 | `signal_returns` table + schema + 90-day backfill from `databento_ohlcv_1m` + `bot_decisions` | Output table populated, row count ≥ 5000 |
| 1.2 | Per-gate rejection logging — `bot_decisions.notes` column tells us which exact gate fired with value + threshold | Every new rejection row has a specific `rejected_gate` field |
| 1.3 | Bot heartbeat alarm — email + Telegram if no decisions logged for ≥ 15 min during market hours | Manual test: kill bot, alarm fires |
| 1.4 | New MCP tool `why_didnt_bot_buy(symbol, date)` — reads (1.2) trace, returns gate-by-gate analysis | Manual test: ask Claude Desktop "why didn't bot buy MU on 2026-05-21?" → coherent answer |
| 1.5 | New MCP tool `signal_edge_report(days=90)` — per-signal forward-return table from `signal_returns` | Returns a table Claude Desktop can narrate |

**Phase 2 — Evidence-driven unblocks (next week)**

Now we use Phase 1's eyes to find and fix real problems.

| # | Deliverable | Backtest gate |
|---|---|---|
| 2.1 | Gate-removal backtest for `gateUwLabel` using signal_returns | If `composite_without_UW ≥ 70 AND uw_label=no_data` trades show positive 10d edge → remove gate. Else soften. |
| 2.2 | Audit setup-classifier rejection histogram — which sub-check kills most candidates | One specific sub-check identified |
| 2.3 | Loosen the worst classifier sub-check based on data | Forward 10d return delta vs. baseline ≥ 0 (don't break what's working) |
| 2.4 | Daily Saturday retrospective via Claude Desktop using new MCP tools | Pavan reads first one Saturday morning, confirms it's useful |

**Phase 3 — Sub-sector + scanner architecture (weeks 3-4)**

Once we can see and have unblocked, we start adding intelligence.

- Sub-sector tagging in `tradable_universe` (memory, fabless, equipment, etc.)
- Relative-strength scanner — daily cron writing to new `relative_strength` table
- Top-Movers scanner extracted from monolithic `_buildCandidateUniverse`
- New MCP tool `get_regime_state()`

**Phase 4 — Thinking primitives (weeks 5-7)**

- Setup classifier rewrite with structured thesis output
- Regime Detector (full §3.2 spec)
- Memory Lookup (§3.3)
- New MCP tools: `explain_setup`, `get_regime_history`, `summarize_closed_trade`

**Phase 5 — Decision layer rewrite (weeks 8-10)**

- Bull/Bear Case Builder (§3.4)
- Exit Planner (§3.5)
- Confidence-based sizing
- New MCP tools: `bull_bear_breakdown`, `explain_exits`, `weekly_bot_retrospective`

**Cadence I commit to:**

- **Daily:** bot keeps running, I monitor logs, fix anything broken silently
- **Saturday status report:** what shipped this week + backtest numbers + what's next week + any reality vs. plan divergence
- **Monthly:** re-read this doc, update sections that reality has invalidated

**One promise:** every behavior change ships with a Decision Log row including baseline number, new number, sample size. If a change can't show measurable edge in backtest, it doesn't ship — it goes back to design.

---

*End of Draft 2 (decisions locked). Execution starts Phase 1.1 next session.*
