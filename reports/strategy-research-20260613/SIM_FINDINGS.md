# BOT_SIM — minute-replay simulation findings (2026-06-13)

Window **2026-05-11 → 2026-06-10** (22 sessions; the minute lake lacks 06-11 RTH).
Universe **S&P 500 ∪ NASDAQ-100** (516 names). Start capital **$100,000**.
Everything ran in an **isolated `sim` schema** as a restricted role that Postgres
physically forbids from writing production. **No lookahead** — price, daily
features, regime, UW flow and news are all gated to the sim clock at the data
layer (verified). Fills next-minute-open + 4 bps slippage.

## Headline numbers

| Run | Trades | Win% | Net P&L | Avg/trade | Avg hold | Return |
|---|---|---|---|---|---|---|
| **Baseline** (seed policy, no learning) | 87 | **57.5%** | −$279 | −0.04% | 3.1 days | **−0.28%** |
| **Self-learning** (Claude tunes nightly) | 63 | 44.4% | −$5,638 | −0.92% | 4.5 days | **−5.64%** |
| *Production bot (live paper, for contrast)* | *194* | *14–33%* | *−$16,600* | *−3.3% losers* | *minutes* | *catastrophic* |

## The three findings (all from the data, none assumed)

### 1. The entry selection is real; the engine mechanics are sound.
57.5% win vs the live bot's 24–33%. Holds are **~3 days, not sub-hour** — the
timeframe-mismatch that defined the live bot's losses is gone. Slippage is an
honest **3 bps**, not the contaminated −625¢ the production metric reported.
The exit breakdown shows the core works: the **3-day time stop is the workhorse —
68 trades, 68% win, +0.65% avg, +$4,456.** The setup itself isn't the problem.

### 2. The damage is in the stops, and it's regime-driven.
Baseline losers: trail_stop (29% win, −$1,654), end-of-window held positions
(−$1,552), hard/gap stops (−$1,528). The time-stop winners (+$4,456) are almost
exactly cancelled by stop losers (−$4,734) → roughly flat.

### 3. The window was 100% calm-bull (R1) — the ONE regime where this setup is weakest.
Every one of the 22 days classified **R1_up_calm**. The independent 10-year
walk-forward (daily bars, survivorship-free) found this exact setup earns only
**+0.0 to +8 bp in R1_up_calm**, but **+150–197 bp in R2_up_vol** (and that R2
edge held in BOTH 2017-21 and 2022-26 halves vs a decaying random control).

> **So a flat baseline in a pure-R1 month is not a failure — it is exactly what
> the 10-year study predicted.** Two independent methods (minute replay + daily
> decade) agree. The strategy is being tested in its weakest regime and roughly
> breaks even, which is the honest, consistent result.

## The self-learning hurt — and *why* is the most useful lesson

Claude tuned the policy nightly (4 adopted versions), and each night's reasoning
was *locally correct* on the data it had:
- v1–v2: "9–19 of every 20 trades exit on the time stop while the rare trail
  exit returns +3% — we're cutting winners short" → extended time stop **3→7 days**.
- v3: "trail stops average −5.2% at 20% win" → widened trail **8%→10%**.

But extending the holding period **increased market exposure right as the tape
softened in early June** (SPY's forward 5-day turned −3.1% that stretch — which
the bot correctly could *not* see). Longer holds (avg 5.4 vs 3.0 days) meant it
held *into* the pullback the seed policy had exited before. Result: trail losses
deepened (−$1,654 → −$3,065), end-of-window marks worsened, −5.6% overall.

**Meta-lesson (this is the real prize):** greedy nightly tuning on 8–20-trade
samples overfits and can walk the strategy straight into an unseen regime change.
The deterministic guardrail bounded the *magnitude* of each change but not its
*direction*. Self-learning has to use longer evidence windows, be regime-aware,
and change far less — confirming your instinct to prove this in simulation first
instead of shipping it live.

## Success criteria for the setup (your original question, now evidence-based)

A "deal-booking-day" entry should require **all** of:
1. **Regime gate** — SPY above its 200-day. Prefer **up-volatile (R2)**; in calm
   bull (R1) the edge is marginal → size down or stand aside.
2. **Name (prior close)** — above 200-day MA · within 15% of 52-wk high · 5-day
   return −8%…−2% (a real pullback) · **RVOL < 2** (never a volume spike).
3. **Intraday timing** — after 10:00 ET · price pulled back to/below VWAP · a
   green stabilizing minute. Optional: UW bull-flow > bear-flow.
4. **Hard ban** — RVOL ≥ 3 + up-move (the worst bucket in the entire decade).

Exit geometry that the data supports:
- **3-day time stop is the edge** (68% win). Do **not** extend it in calm regimes.
- **Trailing stops hurt here** (29% win) — remove, or set ≥12% wide.
- Hard stop wide (~8%); with good entries it should rarely fire.

## Promotion verdict: NOT YET

The bar to move BOT_SIM → BOT: **positive expectancy net of costs across multiple
regimes, beating SPY risk-adjusted, with the minute sim agreeing with the 10-yr
walk-forward.** Right now: baseline is flat in R1 (consistent, not winning),
learning made it worse. **Do not promote.** Next steps are clear and testable:
extend the replay across R2/R3/R4 windows from the lake, redesign the learning to
be conservative + regime-aware, and re-run. The harness to do all of that now
exists and is fully isolated from production.

---

# UPDATE — Step 1: exit-geometry experiments (2026-06-13)

Grid over the same R1 window (no learning, just exit config):

| Config | Trades | Win% | Return | Hold |
|---|---|---|---|---|
| seed: trail 8% + hard 8% + time 3d | 87 | 57.5% | **−0.28%** | 3.1d |
| no trail (hard 8% + time 3d) | 86 | 59.3% | +0.17% | 3.2d |
| no trail + wide hard 12% | 85 | 58.8% | +0.23% | 3.3d |
| time-stop only | 85 | 58.8% | +0.23% | 3.3d |
| time-only, 5d | 50 | 50.0% | +0.15% | 5.5d |
| **time-only, 2d** | 110 | 51.8% | **+0.75%** | 2.5d |

**Findings:**
1. **The trailing stop was the leak.** Removing it flips the R1 month from −0.28%
   to positive. The wide hard stop (12%) never fired in calm bull (== no hard stop),
   so the trail was doing all the damage. → New seed: `trail=0, hard=0.12, time=3`.
2. **Calm bull rewards SHORT holds** (2d +0.75% > 3d +0.23% > 5d +0.15%) — the
   pullback-bounce resolves fast. This is the exact mirror of why the self-learning
   lost: it *extended* holds to 7d in the regime that wanted *shorter*. The learning
   redesign MUST be regime-aware (shorten in calm, lengthen in volatile).
3. Even the best R1 config is only **+0.75%/month** — still marginal, consistent
   with the 10-yr study (R1 ≈ flat). Exit tuning sharpened it but did not create an
   edge that isn't there in this regime. **R2 (up-volatile) remains the real test.**

Robust change locked into the seed (remove trail, keep wide protective hard stop).
2-day horizon NOT hardcoded — likely R1-specific; horizon belongs in regime-aware tuning.

---

# UPDATE — Step 2: multi-regime replay (2026-06-13) — THE decisive test

Same engine + improved exits, replayed over historical regime windows from the
minute lake (2016-2026). Survivorship caveat: current S&P∪NDX membership applied
to historical dates (directional; same universe across windows).

| Window | Regime | Trades | Win% | Return |
|---|---|---|---|---|
| 2024-08 (yen-carry V-snapback) | R2 | 44 | 75% | **+5.08%** |
| 2020-09 (Sept tech wobble) | R2 | 76 | 43% | −1.98% |
| 2018-02 (volmageddon) | R2 | 76 | 50% | −3.87% |
| 2022-07 summer | R3 | 0 | — | 0.00% (stood aside) |
| 2020-03 COVID | R4 | 5 | 0% | −4.67% (gate lag) |
| 2022-04 bear | R4 | 0 | — | 0.00% (stood aside) |
| 2020-03 COVID **no gate** | R4 | 118 | 53% | **−12.16%** |
| 2022-04 bear **no gate** | R4 | 165 | 45% | **−6.87%** |

## The two decisive findings

### A. The regime gate is the single most valuable component — KEEP it.
It turned the COVID crash from **−12.16% → −4.67%** and the 2022 bear from
**−6.87% → 0%**. The gate saves **7–12 percentage points** in downturns by simply
not trading them. This is exactly what the live bot lacked. Capital preservation
is real and large.

### B. The entry setup is NOT a reliable standalone edge.
Across the three R2 windows it averaged roughly **flat-to-slightly-negative**
(+5.08, −1.98, −3.87 → ≈ −0.3% mean); **2 of 3 R2 windows LOST.** The one big win
was a clean V-snapback (2024-08). The setup wins when the uptrend actually
*resumes* and gets knife-caught when volatility is choppy or still falling.

**This confirms the retrospective's warning precisely:** the 10-yr daily study's
"+150 bp R2 edge" was a CROSS-SECTIONAL decile spread (long-top vs short-bottom).
It does **not** survive as a long-only, absolute-return, 10-position portfolio with
real intraday fills and costs. Cross-sectional edge ≠ long-only profit.

## Honest verdict on the whole strategy

BOT_SIM is, as built, a **capital-preservation engine, not yet an alpha engine.**
- It is dramatically better than the live bot (which had no regime gate and chased
  the worst shape) — it avoids the −7 to −12% disasters.
- But the entry alone does not reliably generate profit; it is regime- and
  shape-dependent, ~breakeven across windows with occasional big wins.

**The missing piece** is a *trend-resumption* confirmation that separates clean
V-snapbacks (2024-08, +5%) from knife-catches (2018-02, −4%) at entry time — e.g.
requiring the broader trend to be re-accelerating, or a real reclaim of a level,
not just intraday stabilization. That is the next research iteration.

## Promotion verdict: STILL NOT YET (but the gate is promotable on its own)
Do not promote the full strategy as an alpha system. The **regime gate**, however,
is independently validated and could be added to the live bot now as a pure
loss-avoidance rule (don't trade when SPY < 200-day & vol elevated) — that single
change would have prevented the worst of the live bot's bleed.

---

# UPDATE — Step 3 (#2): market-bounce filter (2026-06-14) — NEGATIVE result

Added SPY's intraday bars to the feed; tested "only enter when SPY ≥ its own VWAP".

| Filter | Sep-2020 (grind) | Aug-2024 (V) | Feb-2018 (volmageddon) |
|---|---|---|---|
| M0 base | −1.98 | +5.08 | −3.87 |
| M1 market-bounce | **−3.07** | +4.50 | −3.62 |
| M2 market+reclaim | −2.38 | +3.08 | **+3.00** |
| M3 reclaim only | −2.66 | +3.27 | +1.76 |

**The market-bounce filter FAILED.** It did not rescue the grinding Sep-2020 window
(made it slightly worse) and didn't help elsewhere. An intraday SPY-above-VWAP gate
can be true even on a down week, so it doesn't capture a multi-day grind.

**Sep-2020 resists every entry filter.** The honest lesson: the residual losses are
NOT an entry-timing problem — they're a *regime-classification* problem. Sep-2020 was
"above the 200-day but grinding down," which the gate currently allows. The fix is a
**finer regime gate** (e.g. also require SPY above its 50-day / not in a short-term
downtrend), not more entry knobs. That's the next iteration if pursued.

**Decision: stop tuning entry filters** — diminishing returns / overfitting risk on 3
windows. Keep the **reclaim** filter (the one robust win) and the regime gate (now live
in production). The grind problem belongs to a future finer-gate experiment.

---

# FINAL VERDICT — web research + decade walk-forward (2026-06-14/15)

After a verified deep-research sweep (104 agents, 22 sources, 25 claims adversarially
verified) and a decade-spanning out-of-sample walk-forward, the strategy question is
answered. The answer is honest and consistent with everything before it.

## Web research (the academic reality)
- **Anomaly decay tax:** published equity anomalies lose ~58% post-publication (Sharpe
  halved); decay accelerating ~5pp/yr; driven by overfitting (McLean & Pontiff; Falck et al).
  Expect any backtest to retain <half its edge live.
- **Options flow:** NO surviving verified claim of a backtestable edge from unusual-options-
  flow + price confirmation. Treat as unvalidated; can only paper-trade forward. (We also
  only have ~1 month of UW data — unbacktestable regardless.)
- **PEAD:** decayed to ~zero for liquid large-caps since 2006. Wrong universe for us.
- **Short-term reversal on losers:** real but WEAK in liquid large-caps long-only; the
  buyable leg is liquidity-shock losers. Best fit but modest.
- **Intraday opening-range/momentum:** best data fit, convex, but gross-of-cost; net survival
  unproven.

## Three strategies built + tested (pluggable strategy layer, src/sim/bot-sim/strategies/)
pullback (current) · reversal (deeper losers, vol-conditioned, reclaim entry) · opening-range (intraday ORB).

## Decade walk-forward (13 tradeable windows 2017→2026; gate blocked 4 bear windows)
| | avg/window | windows positive | worst | head-to-head |
|---|---|---|---|---|
| reversal  | +1.32% | 9/13 | −5.41% | won 6 |
| pullback  | +0.92% | 8/13 | −4.03% | won 7 |
- **Reversal ≈ pullback out-of-sample — essentially TIED.** The clean "reversal wins every
  regime" picture from 5 hand-picked windows did NOT hold (those were favorable draws).
- **opening-range FAILED** the multi-regime test earlier (lost 3 of 4 tradeable windows;
  false breakouts in chop). Dead end.
- Both swing strategies are modestly-positive-but-noisy GROSS (4bps slip, no commission,
  survivorship-inflated). Net + decay → expect ~flat.

## THE DURABLE CONCLUSION (now confirmed 3 independent ways)
**The bot's edge is RISK AVOIDANCE (the regime gate), NOT entry/stock-picking alpha.**
- Confirmed by: (1) the original R1+multi-regime sim, (2) the web research/academic literature,
  (3) the decade out-of-sample walk-forward. All three agree.
- The regime gate (live since 2026-06-14) is the real, validated win — it blocked every bear
  window cleanly. The entry strategies just shuffle modest gains/losses where it's safe to trade.

## Recommendation: DO NOT promote any entry strategy (reversal/pullback/opening-range/flow)
as live alpha. Keep the gate. Keep the sim harness for testing future ideas. Treat entry as
unproven. This is the disciplined, money-saving outcome: we learned the entry signal is noise
in a sandbox instead of by losing real money live.
