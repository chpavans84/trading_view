/**
 * tests/bot-engine/strategies/b37-mean-reversion.js
 *
 * Faithful price-only port of B-3.7's MEAN_REVERSION setup.
 * Reference: src/core/bot-setup-classifier.js lines 326-340.
 *
 * Production rule (B-3.7):
 *   pctOff52w <= -0.15                ← ≥15% off 52w high
 *   AND rsi <= 30                     ← oversold
 *   AND ma50Distance <= -0.05         ← ≥5% below 50-day MA
 *   AND uwLabel NOT in (bearish*)     ← UW not bearish
 *   AND NOT (newsLabel='negative' AND articleCount >= 3)
 *   ⇒ setup=mean_reversion, hold 5-15 days
 *
 * This port DROPS the UW + news gates. Pure price-based test.
 *
 * Exits:
 *   - Mean-reverted: exit when RSI > 50
 *   - Hard time stop: exit at day 15
 *   - Stop loss: 10% (mean reversion needs wider stops than momentum)
 */

const ENTRY_PCT_OFF_52W = -0.15;
const ENTRY_RSI_MAX     = 30;
const ENTRY_MA50_DIST   = -0.05;
const EXIT_RSI_MIN      = 50;
const EXIT_HOLD_DAYS    = 15;
const STOP_PCT          = -0.10;

export function makeB37MeanReversionStrategy(opts = {}) {
  const entryPctOff52w = opts.entryPctOff52w ?? ENTRY_PCT_OFF_52W;
  const entryRsiMax    = opts.entryRsiMax    ?? ENTRY_RSI_MAX;
  const entryMa50Dist  = opts.entryMa50Dist  ?? ENTRY_MA50_DIST;
  const exitRsiMin     = opts.exitRsiMin     ?? EXIT_RSI_MIN;
  const exitHoldDays   = opts.exitHoldDays   ?? EXIT_HOLD_DAYS;
  const stopPct        = opts.stopPct        ?? STOP_PCT;

  return async function b37MeanReversion(ctx) {
    const { day, market, portfolio, universe } = ctx;
    const orders = [];

    // ─── EXITS ───────────────────────────────────────────────────────
    for (const [symbol, pos] of portfolio.positions) {
      const heldDays = (new Date(day) - new Date(pos.openedAt)) / 86_400_000;
      if (heldDays >= exitHoldDays) {
        orders.push({ action: 'exit_long', symbol, reason: 'b37_mr_time_stop' });
        continue;
      }
      const rsi = market.rsi(symbol, day, 14);
      if (rsi != null && rsi >= exitRsiMin) {
        orders.push({ action: 'exit_long', symbol, reason: 'b37_mr_recovered' });
      }
    }

    // ─── ENTRIES ─────────────────────────────────────────────────────
    // Rank by MOST oversold (lowest RSI first) — production picks one;
    // harness can hold up to max-pos.
    const cands = [];
    for (const symbol of universe) {
      if (portfolio.has(symbol)) continue;
      const pctOff = market.pctOff52w(symbol, day);
      if (pctOff == null || pctOff > entryPctOff52w) continue;
      const rsi    = market.rsi(symbol, day, 14);
      if (rsi == null || rsi > entryRsiMax) continue;
      const ma50d  = market.ma50Distance(symbol, day);
      if (ma50d == null || ma50d > entryMa50Dist) continue;
      cands.push({ symbol, rsi });
    }
    cands.sort((a, b) => a.rsi - b.rsi);   // most oversold first

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

export const b37MeanReversionStrategy = makeB37MeanReversionStrategy();
