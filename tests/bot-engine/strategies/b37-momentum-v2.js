/**
 * tests/bot-engine/strategies/b37-momentum-v2.js
 *
 * Tightened version of b37-momentum based on failure analysis:
 *   - DROPPED the b37_mom_broken exit (5d return < -2% triggered exit)
 *     Reason: 279 trades, 3% WR, -$99,013 total. The rule was firing on
 *     natural noise, selling at the bottom of normal pullbacks.
 *   - WIDENED stop loss from -5% to -8% to reduce noise-driven stops
 *   - Kept the 7-day time stop unchanged — it's the winning exit at +$178K
 *   - Entry rules unchanged (pctOff52w >= -0.10, last5dReturn >= 0.02)
 *
 * Hypothesis: removing the destructive mid-trade exit lets winners reach
 * the time stop instead of being prematurely killed.
 */

const ENTRY_PCT_OFF_52W = -0.10;
const ENTRY_5D_RETURN   = 0.02;
const EXIT_HOLD_DAYS    = 7;
const STOP_PCT          = -0.08;   // widened from -0.05

export function makeB37MomentumV2Strategy(opts = {}) {
  const entryPctOff52w = opts.entryPctOff52w ?? ENTRY_PCT_OFF_52W;
  const entry5dReturn  = opts.entry5dReturn  ?? ENTRY_5D_RETURN;
  const exitHoldDays   = opts.exitHoldDays   ?? EXIT_HOLD_DAYS;
  const stopPct        = opts.stopPct        ?? STOP_PCT;

  return async function b37MomentumV2(ctx) {
    const { day, market, portfolio, universe } = ctx;
    const orders = [];

    // ─── EXITS: time stop only (no momentum-broken exit) ──────────────
    for (const [symbol, pos] of portfolio.positions) {
      const heldDays = (new Date(day) - new Date(pos.openedAt)) / 86_400_000;
      if (heldDays >= exitHoldDays) {
        orders.push({ action: 'exit_long', symbol, reason: 'b37_mom_v2_time_stop' });
      }
    }

    // ─── ENTRIES (unchanged from v1) ─────────────────────────────────
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
    cands.sort((a, b) => b.r5 - a.r5);

    const slots = portfolio.availableSlots();
    for (let i = 0; i < cands.length && i < slots; i++) {
      const bar = market.getBar(cands[i].symbol, day);
      if (!bar) continue;
      const stopPrice = bar.close * (1 + stopPct);
      orders.push({ action: 'enter_long', symbol: cands[i].symbol, stopPrice });
    }

    return orders;
  };
}

export const b37MomentumV2Strategy = makeB37MomentumV2Strategy();
