# Order-Path Correctness Fixes — APPLIED 2026-06-12 (overnight, user-authorized)

Status: **APPLIED to the bot-advance engine** 2026-06-12. Verification state:
- ✅ Forced-reject test PASSED live (insufficient-BP order → terminal failure, no phantom row).
- ✅ Poll correctly refuses to treat an unfilled after-hours order as a fill (left pending; sweeper resolves).
- ⏳ Happy-path fill verification = first market-hours bot order (watch logs for `OPENED … @` with
  broker fill + non-null slippage_cents in bot_advance_trades).
- LEGACY engine (src/core/bot-executor.js) deliberately NOT patched — the whole legacy fleet (22 bots)
  was stopped instead (status_message explains). If a legacy bot is ever reactivated, port BUG 1/3 first.

What was applied: `pollOrderFill()` in trader.js; executor.js — no scan-price fill fallback, immediate
order_id persistence, poll-on-missing-fill, terminal-failure handling, pending-on-timeout,
`_resolveStalePendings()` sweeper each tick, slippage_cents persisted (new column, migration
1781300000000); context.js — conviction reuse 24h→90min, live-quote refresh when daily bar ≠ today (ET).

Original analysis below.

---

Status: ROOT-CAUSED 2026-06-10, applied as described above. These touch the live (paper) order-execution
path — apply + **test against Alpaca paper** with the user present (place one real paper order, confirm
the poll resolves and `slippage_cents` populates). Do NOT deploy blind. All three share one cause:
`placeQuickTrade()`/`placeTrade()` return immediately after `POST /v2/orders` **without polling the
fill**, so `filled_avg_price` is null at return for market orders (Alpaca fills async).

---

## BUG 1 — Phantom positions (`alpaca_reconcile_phantom`, still firing 2026-06-09)
**Cause:** `src/core/bot-advance/executor.js:330-356` (and legacy `src/core/bot-executor.js:398-406`)
promote a trade to `status='open'` using a **fabricated** fill: `_normalizeOrder` (executor.js:156-162)
falls back to the *scan price* when the broker returns no `fill_price`, so the `if (!(order.fill_price>0))`
guard passes even though nothing filled. If Alpaca later rejects/cancels (insufficient BP, halt,
wash-trade, PDT, after-hours), there's no broker position → drift-detector flips it to phantom
(`drift-detector.js:128-138`).
**Fix:** add `pollOrderFill(creds, orderId, {timeoutMs:5000})` in `trader.js` (uses existing
`alpaca('GET','/v2/orders/{id}')`, e.g. lines 228-233) that polls until terminal status. In
`executor.js _openOneSymbol` (right after the buy, ~line 325) and `bot-executor.js` (~398):
- `filled` → promote to `open` using broker `filled_avg_price`/`filled_qty` (real fill).
- `rejected`/`canceled`/`expired` → mark row `failed` with that reason (existing failed path handles it).
- still `new`/`accepted` after timeout → leave as `pending` (do NOT mark open); next tick re-polls; the
  `status IN ('open','pending')` dedup already prevents a duplicate buy.
- STOP using scan `price` as a `fill_price` fallback in `_normalizeOrder` for the open decision.

## BUG 2 — Stale price (`live_quote_diverged_up_X%`, still firing 2026-06-09)
**Cause:** the guard at `executor.js:300-310` is CORRECT (aborts on >max divergence). The problem is the
decision is anchored to a stale price: `signals.last_price` = `backtest_prices.close` (prior daily close)
and `signals.current_price` from a conviction row up to 24h old (`context.js:43-60,139-155`;
`scored_at > NOW()-INTERVAL '24 hours'`). So at execute time the live ask legitimately differs 5-17%.
**Fix (smallest):** in `context.js`, if `liqRow.last_date` is not the current trading day, fetch a live
quote via `getLatestPrice(symbol)` (trader.js:439) for `last_price` so price-gated rules (e.g. 52w-high,
`entry-rules.js:171-184`) evaluate on fresh data. Optionally tighten the conviction reuse window
(context.js:47) from 24h → ~90min for ENTRY reuse. Guard itself needs no change.

## BUG 3 — Slippage never recorded (`trades.slippage_cents` always null)
**Cause:** `recordTrade()` is called without `slippage_cents` (`bot-executor.js:448-469`; db.js plumbing
exists at db.js:1305-1320). `placeQuickTrade`/`placeTrade` even compute slippage (trader.js:806-808,
652-654) but `_normalizeOrder` discards it.
**Fix:** pass `expected_price` (the live sizing quote = `estimated_price`) through `_normalizeOrder`, then
in `bot-executor.js` (~after 406) and `executor.js` (~347-356 UPDATE) compute
`slippage_cents = (fill_price - expected) * (side==='sell'?-1:1) * 100` and store it.
**Coupling:** meaningless until BUG 1 lands (needs the real broker fill, not the scan-price fallback).

---

## Recommended apply order (supervised, with paper test)
1. BUG 1 (`pollOrderFill` + confirmed-fill promotion) — the root fix.
2. BUG 3 (slippage) — rides on BUG 1's real fill.
3. BUG 2 (fresh price into the decision) — independent.
Test: place one Alpaca-paper buy, confirm poll resolves to `filled`, row goes `open` with real fill,
`slippage_cents` populated; force a reject (oversize) and confirm it goes `failed` not phantom.
