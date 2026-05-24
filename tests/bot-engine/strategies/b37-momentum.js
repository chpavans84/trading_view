/**
 * tests/bot-engine/strategies/b37-momentum.js
 *
 * Faithful price-only port of B-3.7's MOMENTUM setup.
 * Reference: src/core/bot-setup-classifier.js lines 287-300.
 *
 * Production rule (B-3.7):
 *   pctOff52w >= -0.10                            ← within 10% of 52w high
 *   AND last5dReturn >= 0.02                      ← 5d gain ≥ +2%
 *   AND (uwScore >= 40 OR uwLabel in bullish*)    ← UW flow confirmation
 *   AND newsLabel != 'negative'                   ← no bearish news
 *   ⇒ setup=momentum, hold 2-7 days
 *
 * This port DROPS the UW + news gates (no history available for replay).
 * That makes this the **best-case** B-3.7 momentum: if even this loses to
 * SMA cross / buy-and-hold, the gated composite cannot rescue it.
 *
 * Exits:
 *   - Hard time stop: exit at day 7 of hold (production: expected_hold_days_max=7)
 *   - Momentum break: exit if last5dReturn drops below -0.02
 *   - Stop loss: exit if intraday low ≤ entry * 0.95 (5% stop)
 */

const ENTRY_PCT_OFF_52W = -0.10;
const ENTRY_5D_RETURN   = 0.02;
const EXIT_HOLD_DAYS    = 7;
const EXIT_MOMENTUM_BRK = -0.02;
const STOP_PCT          = -0.05;

export function makeB37MomentumStrategy(opts = {}) {
  const entryPctOff52w = opts.entryPctOff52w ?? ENTRY_PCT_OFF_52W;
  const entry5dReturn  = opts.entry5dReturn  ?? ENTRY_5D_RETURN;
  const exitHoldDays   = opts.exitHoldDays   ?? EXIT_HOLD_DAYS;
  const exitMomBreak   = opts.exitMomBreak   ?? EXIT_MOMENTUM_BRK;
  const stopPct        = opts.stopPct        ?? STOP_PCT;

  return async function b37Momentum(ctx) {
    const { day, market, portfolio, universe } = ctx;
    const orders = [];

    // ─── EXITS first (so freed slots can be reused for entries today) ─
    for (const [symbol, pos] of portfolio.positions) {
      const heldDays = (new Date(day) - new Date(pos.openedAt)) / 86_400_000;
      if (heldDays >= exitHoldDays) {
        orders.push({ action: 'exit_long', symbol, reason: 'b37_mom_time_stop' });
        continue;
      }
      const r5 = market.lastNdReturn(symbol, day, 5);
      if (r5 != null && r5 < exitMomBreak) {
        orders.push({ action: 'exit_long', symbol, reason: 'b37_mom_broken' });
      }
    }

    // ─── ENTRIES ─────────────────────────────────────────────────────
    // Rank candidates by 5d return strength (highest first) — production
    // selects single best, but harness can hold up to max-pos. We rank to
    // make selection deterministic when more candidates exist than slots.
    const cands = [];
    for (const symbol of universe) {
      if (portfolio.has(symbol)) continue;
      const pctOff = market.pctOff52w(symbol, day);
      const r5     = market.lastNdReturn(symbol, day, 5);
      if (pctOff == null || r5 == null) continue;
      if (pctOff >= entryPctOff52w && r5 >= entry5dReturn) {
        cands.push({ symbol, r5 });
      }
    }
    cands.sort((a, b) => b.r5 - a.r5);   // strongest momentum first

    const slots = portfolio.availableSlots();
    for (let i = 0; i < cands.length && i < slots; i++) {
      const bar = market.getBar(cands[i].symbol, day);
      if (!bar) continue;
      const stopPrice = bar.close * (1 + stopPct);   // 5% below today's close
      orders.push({ action: 'enter_long', symbol: cands[i].symbol, stopPrice });
    }

    return orders;
  };
}

export const b37MomentumStrategy = makeB37MomentumStrategy();
