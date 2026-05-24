/**
 * tests/bot-engine/strategies/sma-cross.js
 *
 * Long-only 50/200 SMA crossover across the configured universe.
 * Classic Faber-style trend follower — used as a known-baseline.
 *
 * Entry: fast SMA > slow SMA (golden cross territory) AND not already held
 * Exit:  fast SMA <= slow SMA (death cross territory)
 *
 * No stop-loss in v1 — pure signal-based. Trailing/stops can be layered later.
 */

const HYSTERESIS = 0.0005;   // 0.05% — same as the live primary signal

export function makeSmaCrossStrategy({ fast = 50, slow = 200 } = {}) {
  return async function smaCrossStrategy(ctx) {
    const { day, market, portfolio, universe } = ctx;
    const orders = [];

    for (const symbol of universe) {
      const f = market.sma(symbol, day, fast);
      const s = market.sma(symbol, day, slow);
      if (f == null || s == null) continue;

      const ratio = (f - s) / s;
      const signal = Math.abs(ratio) < HYSTERESIS ? 0 : (ratio > 0 ? 1 : -1);

      const has = portfolio.has(symbol);

      if (signal === 1 && !has) {
        if (portfolio.availableSlots() > 0) {
          orders.push({ action: 'enter_long', symbol });
        }
      } else if (signal === -1 && has) {
        orders.push({ action: 'exit_long', symbol, reason: 'sma_cross_down' });
      }
    }

    return orders;
  };
}

// Default export: standard 50/200
export const smaCrossStrategy = makeSmaCrossStrategy();
