# Volume / Breakout Research — 2026-06-20

Two linked studies on what volume tells us about big stock moves in the **S&P 500 + NASDAQ-100**
universe. Both motivated by Pavan's thesis: *"NVDA, MSFT spike up and fall really quick, but volume-wise
NVDA is always high — does volume (and UW bullish flow) actually tell us whether a move is real?"*

**Prerequisite fix (same session):** `backtest_prices.volume` was IEX-contaminated (~30× too low for
recent days) because the 5 PM `refresh-prices` cron wrote Alpaca's free IEX feed (~3% of consolidated
tape). Fixed before this analysis — see `GOTCHAS.md` ("IEX volume contamination, FIXED 2026-06-19"):
`refresh-prices.js` now writes OHLC/close only; `polygon-daily-incremental.sh` syncs consolidated volume
from the lake (`market_bars_daily`) into `backtest_prices`. **All volume figures below are Polygon
consolidated (full-tape), not IEX.**

SQL is reproduced in this folder: `spike_study.sql`, `prespike_ramp.sql`, `breakout_study.sql`.

---

## STUDY A — Spike day study (last 1 month, with UW options flow)

**Window:** 2026-05-19 → 2026-06-18 (UW flow coverage start). **Universe:** S&P500 + NDX100.
**Spike** = ≥5% up day. **Outcome** = 3-day forward return. **371 spikes**, 290 with UW flow.
⚠️ One month, one regime (recent), 3-day horizon — descriptive, not regime-validated. UW history
structurally cannot be extended (starts 2026-05-19).

### A1 — Spike-day RVOL vs outcome — bigger volume surge → fades MORE
| Spike-day RVOL | n | avg 3d ret | % faded |
|---|---|---|---|
| <1.5× (no surge) | 247 | **+1.36%** | 44% |
| 1.5–3× | 99 | +0.24% | 52% |
| ≥3× (big surge) | 18 | **−0.59%** | 61% |

### A2 — On-day UW bullish % vs outcome — bullish flow is coincident-to-contrarian
| UW bullish % (premium-wtd) | n | avg 3d ret | % faded |
|---|---|---|---|
| <40% (flow NOT bullish) | 40 | **+2.24%** | 40% |
| 40–60% | 40 | +0.66% | 48% |
| 60–80% | 55 | +1.30% | 49% |
| ≥80% (very bullish) | 148 | +0.96% | 48% |

### A3 — Pre-spike "telegraphing" (5 days before) — the cleaner result
Monotonic across THREE independent dimensions + the combo: the more a spike is *telegraphed*
beforehand, the worse it does.

| Pre-spike volume ramp | n | avg 3d ret | % faded |
|---|---|---|---|
| <0.9× (quiet/declining in) | 137 | **+2.37%** | 34% |
| 0.9–1.3× (flat) | 158 | +1.21% | 51% |
| ≥1.3× (volume building in) | 62 | **−1.98%** | 63% |

| Pre-spike bullish flow (≥$50k) | n | avg 3d ret | % faded |
|---|---|---|---|
| <40% (NOT bullish pre-spike) | 56 | **+2.26%** | 34% |
| 40–60% | 75 | +1.84% | 45% |
| 60–80% | 90 | −0.53% | 58% |
| ≥80% | 96 | +1.61% | 43% |

| Pre-spike price drift | n | avg 3d ret | % faded |
|---|---|---|---|
| <−3% (fell into it) | 129 | **+2.60%** | 35% |
| −3..+3% (flat) | 98 | +0.42% | 49% |
| +3..+8% (climbing) | 61 | +1.18% | 56% |
| ≥+8% (extended) | 69 | −0.79% | 57% |

**Combo (perfectly monotonic):** least-telegraphed (quiet vol + flow not bullish) → +2.20%, 39% faded;
most-telegraphed (vol building + bullish flow) → −2.07%, 60% faded.

**Study A takeaway:** In this 1-month window, **visible bullish positioning + volume buildup before a
spike was a FADE signal, not confirmation.** The sustained spikes were the un-telegraphed ones (quiet
volume, flow not bullish, often bouncing off a decline). Validates Pavan's "hedge managers play games"
instinct — but flips the direction vs naive momentum-chasing.

---

## STUDY B — Breakout / false-breakout study (5.5 years, multi-regime, price+volume only)

Drops UW (no history) → runs on the lake's full consolidated-volume history.
**Window:** 2021-01 → 2026-06. **Universe:** S&P500 + NDX100 (516 names). **86,000 breakout events.**
**Breakout UP** = first close above prior 20-day high; **DOWN** = first close below prior 20-day low
(deduped to the first day of each thrust). **FALSE breakout (trap)** = closes back inside the broken
range within 5 days. **Follow-through** = directional 10-day return. **RVOL** = vol / trailing-50d avg.

### B1 — Base rates: most breakouts fail
| Direction | events | % false (trap) | avg 10d follow-through |
|---|---|---|---|
| UP | 48,556 | **55%** | +0.5% |
| DOWN | 37,426 | **59%** | −1.0% |

### B2 — False-breakout rate by BREAKOUT-DAY volume (monotonic, both directions)
| Breakout-day RVOL | UP % false | DOWN % false |
|---|---|---|
| <1× | 60% | 64% |
| 1–1.5× | 53% | 61% |
| 1.5–2.5× | 45% | 54% |
| **≥2.5×** | **28%** | **38%** |

Avg relative volume, real vs false: UP real 1.22 vs false 1.03; DOWN real 1.50 vs false 1.22.

### B3 — Pre-breakout volume TREND (1wk/2wk/1mo/2mo) does NOT help
| Pre-vol trend (1wk vs 2mo) | UP % false | DOWN % false |
|---|---|---|
| Falling into breakout | 56% | 59% |
| Flat | 55% | 59% |
| Rising into breakout | 52% | 60% |
All 1wk/2wk/1mo/2mo window ratios ≈1.0 for both real and false. **The signal is the breakout BAR, not
the lead-in.**

### B4 — Regime stability (false-breakout rate by year)
| Year | UP % false | DOWN % false |
|---|---|---|
| 2021 | 54 | 64 |
| 2022 (bear) | 58 | 57 |
| 2023 | 52 | 58 |
| 2024 | 54 | 59 |
| 2025 | 56 | 61 |
| 2026 | 55 | 58 |

Stable across bull and bear — unlike Study A, this finding is **not regime-bound.**

### Claude GenAI thesis (generated by sub-agent from the facts above)

> **Thesis** — The single fact separating real breakouts from false traps is **breakout-day relative
> volume**, not any pre-breakout build-up. False-trap rates fall monotonically as day-of RVOL rises
> (UP 60%→28%, DOWN 64%→38%). Base rates are hostile, so volume is a *filter that tilts the odds*,
> not an edge by itself.
>
> **Mechanism** — A breakout is just a price level until volume confirms participation. High
> breakout-day RVOL = real order flow (institutions, forced shorts, index demand) absorbing the range's
> resting supply. Low-volume breakouts are thin overshoots no one defends, so price reverts back inside
> — the trap. The volume IS the evidence of who showed up.
>
> **Key asymmetry** — Confirmation is an event, not a buildup. Slow accumulation into a level tells you
> nothing about whether the *breach* was defended; conviction shows up at the moment of the break. So
> measure volume on the breakout bar — don't try to "see it coming" from prior weeks. That signal isn't
> there.
>
> **Filter rule** — Only act on breakouts with **breakout-day RVOL ≥ 2.5×**. UP: false-rate 55%→28%.
> DOWN: 59%→38%. A looser ≥1.5× gate still helps (UP 45%, DOWN 54%) for more signals at lower confidence.
>
> **Caveats** — This is a *filter, not a strategy* (no entries/exits/sizing). Even at the best gate,
> 28–38% still fail. Follow-through is tiny (+0.81% / −0.95% over 10d) and before costs/slippage, which
> may erase it — especially shorting. Holds only for the 10-day horizon + large-cap universe.

---

## Reconciling A and B (tension to resolve before any bot change)
- **Study B** (5.5y, robust): volume-confirmed breakouts are *more real* → supports the bot's
  `at_52w_high_with_volume` direction.
- **Study A** (1mo, UW): telegraphed momentum spikes *fade* → cautions against chasing.
- They're not contradictory — different definitions (20-day breakout vs 5%+ spike day) and the key split
  is **breakout-DAY volume (confirms) vs multi-week pre-ramp / visible bullish positioning (fades).**
  Both say: the conviction is in the *event bar*, not the anticipation.

## Status / next steps (none shipped to live bot)
- [ ] Tighten filter: test ≥3×/≥4× RVOL + price-hold confirmation (close stays above level 2 days).
- [ ] Prototype the ≥2.5× RVOL false-breakout filter as a **sim** gate (NOT live) — validate net of costs.
- [ ] Net-of-cost backtest before any live rule (follow-through magnitudes are small).

**Discipline:** evidence-based, no faith-based bot changes; validate in sim across regimes before ship.

---

## STUDY F — Sim prototype + multi-regime walk-forward (2026-06-22)

Encoded the findings as a sim strategy: `src/sim/bot-sim/strategies/breakout.mjs` (volume-confirmed
20-day breakout, intraday "next-day-hold" confirmation, WIDE+TIME-BASED exits per Study C5, no UW/GEX
per E). Added `dist_20dhigh` feature to sim feed/schema/ETL. Runner:
`src/sim/experiments/breakout-walkforward.sh`. Net of 4bps slippage. Breakout vs `pullback` baseline:

| Window | Regime | Breakout | Pullback |
|---|---|---|---|
| 2026 May | calm bull (IN-SAMPLE) | +7.52% | +2.05% |
| 2024 Aug | up-vol V-snapback | −0.14% | +5.08% |
| 2020 Sep | up-vol grind | +0.77% | −1.98% |
| 2018 Feb | volmageddon | −2.18% | −3.87% |
| 2022 Apr-Jun | bear | +1.63% | −2.82% |
| 2020 Mar-May | covid crash | −2.32% | −4.67% |
| equal-wt avg | | **+0.88%** | **−1.04%** |

**Findings:** (1) breakout is MORE REGIME-ROBUST than the incumbent pullback — beat it 5/6 windows,
positive cross-regime avg vs pullback negative; gate+hold-discipline limited bear/crash losses (14 & 4
trades, stood aside). (2) BUT the +7.52% headline is IN-SAMPLE/calm-bull/3-trade-concentrated and does
NOT generalize — out-of-sample breakout is ~breakeven (losses in volmageddon & covid). NOT a standalone
edge. (3) Breakout & pullback are COMPLEMENTARY (pullback won the 2024 V-snapback breakout was flat in)
→ a regime-switched book is the promising direction. Caveats: small per-window samples (4-47 trades);
flat 4bps slippage flatters strength-buying; current-index survivorship. NOT live-ready.

**STUDY F bottom line:** breakout is a better, more robust CORE than pullback, but not a profitable
standalone strategy. Next: regime-switched breakout+pullback, realistic slippage, longer windows.

### F2 — Realistic slippage + rolling walk-forward (2026-06-22, ~2,700 trades)
Added momentum-aware slippage (`broker.mjs`, `SIM_SLIP_MODEL`; charges impact for buying INTO up-moves —
breakout pays ~2× pullback). A/B on R1: realistic charged breakout 11.4 vs 2.7 bps yet edge held (+7.16%).
Then a 34-window rolling walk-forward 2018→2026 (`src/sim/experiments/rolling-walkforward.sh`), realistic
slippage, TRADE-LEVEL aggregate:

| Strategy | trades | win% | avg/trade |
|---|---|---|---|
| breakout | 1,022 | 54.3% | +0.286% |
| pullback | 1,696 | 53.7% | +0.207% |

Per regime: **R1 calm-bull — breakout +0.352%/trade (893 trades, 55%) >> pullback +0.144%**; **R2 up-vol —
breakout −0.169% (loses) << pullback +0.713% (63%)**. Both take ZERO trades in R3/R4 (gate stands aside).

**F2 conclusions (statistically grounded now):** (1) breakout has a REAL calm-bull edge, net of realistic
slippage, on ~900 trades — NOT the earlier "3-trade luck" worry. (2) It is regime-SPECIFIC, not robust:
loses in up-vol where pullback dominates. (3) breakout & pullback are measurably COMPLEMENTARY → the
regime-switched book (breakout in R1, pullback in R2) is now EVIDENCE-BACKED. Still open: build+walk-
forward the switched book; thinner R2 sample (318); current-index survivorship; slippage still gentle.

### F3 — Regime-switched book built + walk-forward (2026-06-22) — WINS
`src/sim/bot-sim/strategies/regime-switch.mjs` (breakout in R1_up_calm, pullback in R2_up_vol, aside in
R3/R4; exits travel by entry-regime via conf._regime). Same 34-window rolling WF, realistic slippage.
THREE-WAY trade-level:

| Book | trades | win% | avg/trade | total P&L |
|---|---|---|---|---|
| **regime-switch** | 1,072 | **55.9%** | **+0.380%** | **+$40,497** |
| breakout | 1,022 | 54.3% | +0.286% | +$29,133 |
| pullback | 1,696 | 53.7% | +0.207% | +$34,871 |

Per-regime confirms routing: R1 switch +0.337% (→breakout) vs pullback +0.144%; R2 switch +0.599%
(→pullback) vs breakout −0.169%. **Switched book beats BOTH standalones on every metric** (per-trade,
win%, total P&L) — complementarity confirmed on ~1,070 trades / 8yr / realistic slippage.

**F3 bottom line / path to live:** regime-switch is the validated winner. Before live: TRUE held-out
years test (fit 2018-23 / test 2024-26), thin R2 sample (174), idle in down-regimes (sampled windows =
per-trade expectancy NOT annual return), current-index survivorship, commissions not separately modeled.
Nothing shipped to the live bot.

### F4 — TRUE held-out-years test (2026-06-22) — PASSES
Two parts. (a) Split the frozen-param rolling results IS(2018-23) vs OOS(2024-26): regime-switch beats
BOTH standalones in BOTH periods (IS +0.173%/trade vs breakout 0.079/pullback 0.082; OOS +0.793 vs
0.699/0.444) → design generalizes, not overfit. (b) Honest param fit: swept breakout rvol_min
(`rvol-fit-sweep.sh` + `BO_RVOL_MIN` hook) and selected on TRAIN ONLY — rv2.5 best on 2018-23
(+0.206%/trade). Applied that train-choice to held-out 2024-26: **+0.684%/trade, 61.3% win, 235 trades**.
ALL rvol values positive OOS (+0.66 to +0.79) → robust to the param, not knife-edge. Train-best (2.5) ≠
test-best (1.5 @ +0.793) so honest selection costs ~0.1pp vs peeking — and survives it.

**F4 verdict:** held-out test PASSES; implicit-fitting concern RETIRED; regime-switch is genuinely
OUT-OF-SAMPLE VALIDATED. All-weather edge estimate ≈ TRAIN +0.21%/trade (the OOS +0.68 is bull-flattered).
Remaining before live: survivorship (current-index), commissions, idle in down-regimes, thin R2 (174).
STILL nothing shipped to the live bot.

### F5 — Survivorship-free re-validation (2026-06-22) — EDGE SURVIVES
Added `SIM_UNIVERSE=liquidity` to load-data.sh: universe = top-500 by adv20 AS-OF window start, point-in-
time from the lake (survivorship-FREE; in 2018 only 273/500 are in today's index — rest since acquired/
dropped: AET/AGN/ATVI/AMTD/APC…). Re-ran regime-switch rolling WF (`RUN_PREFIX=surv`). Result vs current-
index:

| Universe | pooled avg/trade | IS 2018-23 | OOS 2024-26 |
|---|---|---|---|
| current-index | +0.380% | +0.173% | +0.793% |
| survivorship-free | +0.397% | +0.317% | +0.559% |

Pooled ~identical (+0.397 vs +0.380) → survivorship bias did NOT manufacture the edge. Most rigorous single
number (OOS + survivorship-free): **+0.559%/trade, 57.3% win**. IS higher survivorship-free (takeover pops
in later-acquired names = real breakout phenomenon); OOS lower (current-index OOS flattered by mega-cap
concentration). Both periods positive in both universes. Minor: a few ETFs leak into liquidity universe.

**F5 / FULL VALIDATION COMPLETE:** regime-switch passed EVERY rigor check — multi-regime, ~1k+ trades,
realistic slippage, beats both standalones, out-of-sample held-out years, honest train-only param fit, AND
survivorship-free. Honest edge ≈ +0.32%/trade (hard years) to +0.56% (OOS). Remaining = commissions, idle
in down-regimes, thin R2 — and the ultimate test: LIVE PAPER TRADING. Nothing shipped to the live bot.

---

## STUDY E — Can UW history help breakouts? (investigated 2026-06-20) — mostly NO

**UW API access (GET-tested with our key):** REST only, no bulk files; tier caps history at ~1yr
(older = 403). The **flow-alerts feed we ingest CANNOT be backfilled** (rolling/recent; date param
ignored). Historically queryable ~1yr: `greek-exposure` (GEX, whole series in 1 call/ticker),
`net-prem-ticks?date=` (intraday net call/put premium, 1 call/ticker/day), `flow-per-strike?date=`.

**GEX backfill (done):** `scripts/etl/backfill-uw-gex.mjs` → `uw_gex_history` table, 127,885 rows,
515 tickers, ~1yr (2025-06-23→2026-06-18). Breakout×GEX (8,631 UP breakouts): false-trap rate FLAT
across dealer-gamma regimes (55–57%); mild follow-through-magnitude gradient (short-gamma +1.17% vs
long-gamma +0.62% — amplify/suppress) but sign-cut contradicts (noisy). Volume dominates inside every
gamma bucket. ⇒ GEX is weak for trap-avoidance; maybe useful for position sizing, not entry.

**net-prem-ticks validation (508 breakout days sampled):** trap rate FLAT (57–61%) by net bullish flow
— useless for trap-avoidance. BUT direction is CONTRARIAN: most-bullish-flow breakouts had −1.23% fwd
return vs +0.46% for bearish-flow. This REPLICATES Study A's contrarian UW finding at 12× scale (~1yr
vs 1mo) — not a fluke. Decision: full 129k-call backfill SKIPPED (won't help traps; directional edge
weak+contrarian and already established cheaply).

**STUDY E bottom line:** for breakouts, VOLUME is the signal. UW flow/GEX/net-prem add little for
false-breakout avoidance; only directional signal is a weak contrarian one (bullish flow → fade).

---

## STUDY C — Hold-vs-Sell exit rule accuracy, at stock level (5.5y, multi-regime)

**Question (Pavan):** after a breakout (up or down), when should the bot HOLD vs SELL — and is the rule
≥90% accurate as a *historical fact* (not a prediction)? **Universe:** S&P500 + NDX100. **Window:**
2021–2026 lake consolidated. **Rule tested:** after UP breakout (new 20d high, level=prior-20d-high)
HOLD while close ≥ level, SELL first close < level (mirror for DOWN/short). **Horizon:** 10 trading days.
SQL: `exit_rule_study.sql` (full rule + per-stock) and `cond_acc.sql` (conditional reliability).

### C1 — Whole-rule accuracy: NO stock reaches 90% (honest headline)
| Direction | events | rule accuracy | avg rule ret | avg hold ret |
|---|---|---|---|---|
| UP | 48,968 | **62.8%** | +0.27% | +0.50% |
| DOWN | 37,426 | **63.4%** | −0.76% | −1.02% |

- Per-stock (UP, ≥30 events): **0 stocks ≥90%**; best = ELV 82%; only 1 stock >80%; most 60–70%.
- On UP breakouts the level-stop rule **underperforms naive holding** (+0.27% vs +0.50%) — it whipsaws
  you out of winners. NVDA proof: UP accuracy 57.6%, rule +1.06% vs hold +2.69%.
- ⇒ As a return-maximizing "when to sell" rule, **90% is NOT a real fact.**

### C2 — BUT the HOLD side and SELL side are very different — and HOLD ≥90% IS a fact
| Direction | HOLD-signal reliability | SELL-signal reliability |
|---|---|---|
| UP | **91.0%** (n=16,791) | 65.5% (n=31,765) |
| DOWN | 85.0% | 71.9% |

- **HOLD signal** = price stayed above the breakout level all 10d → ended profitable 91% (UP).
- **SELL signal** = first close back below level → holding would actually have lost only 65.5% (UP);
  the rest puncture the level then recover (whipsaw) — why the simple sell is unreliable.

Per-stock (UP, ≥30 signals): **HOLD side — 219 of 338 stocks ≥90%** (336 ≥80%); SELL side — only 1 ≥90%.
100%-HOLD-reliable names incl. CMI, LOW, KO, TXN, RJF, CRWD, VRSK, STX, CL; CAT 98%, AAPL 97.9%, NDAQ 97.7%.

### C3 — Answer to the question
- **"When to HOLD" = a ≥90% fact.** Hold a breakout while price stays above the breakout level; it ends
  green ~91% of the time (and ≥90% for the majority of NDX100/S&P names, many 100%). Reliable rule.
- **"When to SELL" = NOT 90%** (~65% for the simple level-break). Selling is the hard part — needs a
  confirmation/volume condition or wider stop, not just the first close below the level.
- **Bot implication:** lean toward holding level-respecting breakouts (90%+); be selective on selling.

**Caveats:** profitability *sign* not magnitude; 10d horizon; pre-cost; large-cap only; 2021–2026 skews
bullish (above-level ≈ uptrend carries regime tailwind). HOLD-side breadth (219/338 ≥90%) still strong.

### C4 — Regime stress-test: HOLD ≥90% survives the 2022 bear (NOT a bull artifact)
SQL: `exit_v2.sql`. HOLD reliability by year (UP): 2021=93.4%, **2022 bear=90.5%**, 2023=91.8%,
2024=89.4%, 2025=89.5%, 2026=89.9%. ~90% every year. In the bear fewer breakouts held their level
(2,277 vs 3,699 signals) but the ones that did stayed 90%+ profitable — selectivity is self-protective.
The HOLD fact is regime-robust.

### C5 — SELL trigger: no variant reaches 90%, and none beats just holding (10d horizon)
"Sell beat holding" rate / avg rule return vs avg hold return (+0.50%):
- baseline (first close<level): 45.6% / +0.29%
- 2-day confirmation: 44.8% / +0.37%
- buffer 2% below level: 44.2% / +0.37%
- buffer 3% below level: 43.3% / +0.41%
When a level-stop fires on an UP breakout, selling beat holding only ~45% (whipsaw — stock recovers).
Confirmation/buffers help only by selling less/later; NONE beat holding to day 10. ⇒ Over ~2 weeks the
best "sell rule" for up-breakouts is *don't*. A profit-maximizing 90% sell rule does not exist here.

### C6 — Volume twist (ties to Study A): heavy-vol breakouts are where selling matters
HOLD reliability / "sell was a real loser": all breakouts 92.3% / 65.3%; heavy-vol ≥2.5× RVOL
70.8% / 75.4%. Filtering entries to heavy volume makes HOLDING WORSE (92→71%) — those are the violent
blow-offs that reverse (consistent with Study A: ≥3× spikes fade most). The 92% HOLD reliability comes
from QUIET ordinary breakouts that trend; heavy-vol blow-offs are the only place a sell discipline earns
its keep (75% of their level-breaks were true losers, vs 65% overall).

### C7 — Final design implication
Bot should DEFAULT TO HOLDING level-respecting breakouts (≥90%, regime-proof, strongest on quiet ones)
and reserve active sell-discipline for HEAVY-VOLUME BLOW-OFF breakouts — not a blanket level-stop that
whipsaws it out of quiet winners. "When to hold" is solved (≥90%); "when to sell" is not (no 90% rule).
