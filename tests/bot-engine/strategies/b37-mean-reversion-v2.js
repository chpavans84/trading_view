/**
 * tests/bot-engine/strategies/b37-mean-reversion-v2.js
 *
 * Tightened version of b37-mean-reversion based on failure analysis:
 *   - WIDENED stop loss from -10% to -15%. Reason: 28 stops × -$982 avg
 *     = -$27,509 of losses (60% of total). Worst-10% losers at exactly
 *     -10.24% confirms stops fire on noise. Mean-reversion needs room.
 *   - ADDED entry filter: don't enter if pctOff52w ≤ -0.25 (no falling
 *     knives — when a name is 25%+ off its 52w high it's usually a
 *     genuine breakdown, not a reversion candidate).
 *   - Kept the RSI > 50 recovery exit unchanged — that's the 98% WR
 *     winner that produces +$77,487
 *   - Kept the 15-day time stop unchanged
 *
 * Hypothesis: fewer entries (better quality) + wider stops (let the
 * thesis play out) = fewer catastrophic losses, similar or better wins.
 */

const ENTRY_PCT_OFF_52W_MAX = -0.15;   // ≥15% off high to enter
const ENTRY_PCT_OFF_52W_MIN = -0.25;   // NEW: skip if ≥25% off (falling knife filter)
const ENTRY_RSI_MAX         = 30;
const ENTRY_MA50_DIST       = -0.05;
const EXIT_RSI_MIN          = 50;
const EXIT_HOLD_DAYS        = 15;
const STOP_PCT              = -0.15;   // widened from -0.10

export function makeB37MeanReversionV2Strategy(opts = {}) {
  const entryMax   = opts.entryPctOff52wMax ?? ENTRY_PCT_OFF_52W_MAX;
  const entryMin   = opts.entryPctOff52wMin ?? ENTRY_PCT_OFF_52W_MIN;
  const entryRsi   = opts.entryRsiMax       ?? ENTRY_RSI_MAX;
  const entryMa50  = opts.entryMa50Dist     ?? ENTRY_MA50_DIST;
  const exitRsi    = opts.exitRsiMin        ?? EXIT_RSI_MIN;
  const exitHold   = opts.exitHoldDays      ?? EXIT_HOLD_DAYS;
  const stopPct    = opts.stopPct           ?? STOP_PCT;

  return async function b37MeanReversionV2(ctx) {
    const { day, market, portfolio, universe } = ctx;
    const orders = [];

    // ─── EXITS (unchanged) ─────────────────────────────────────────────
    for (const [symbol, pos] of portfolio.positions) {
      const heldDays = (new Date(day) - new Date(pos.openedAt)) / 86_400_000;
      if (heldDays >= exitHold) {
        orders.push({ action: 'exit_long', symbol, reason: 'b37_mr_v2_time_stop' });
        continue;
      }
      const rsi = market.rsi(symbol, day, 14);
      if (rsi != null && rsi >= exitRsi) {
        orders.push({ action: 'exit_long', symbol, reason: 'b37_mr_v2_recovered' });
      }
    }

    // ─── ENTRIES with falling-knife filter ────────────────────────────
    const cands = [];
    for (const symbol of universe) {
      if (portfolio.has(symbol)) continue;
      const pctOff = market.pctOff52w(symbol, day);
      if (pctOff == null) continue;
      // Skip if too shallow OR too deep (the new lower bound is the change)
      if (pctOff > entryMax || pctOff < entryMin) continue;
      const rsi = market.rsi(symbol, day, 14);
      if (rsi == null || rsi > entryRsi) continue;
      const ma50d = market.ma50Distance(symbol, day);
      if (ma50d == null || ma50d > entryMa50) continue;
      cands.push({ symbol, rsi });
    }
    cands.sort((a, b) => a.rsi - b.rsi);

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

export const b37MeanReversionV2Strategy = makeB37MeanReversionV2Strategy();
