/**
 * tests/bot-engine/strategies/buy-and-hold.js
 *
 * Baseline benchmark: buy SPY on day 1, hold to end.
 * Used to compute "did the bot beat the market" comparisons.
 */

let _opened = false;

/**
 * @param {object} ctx — { day, market, portfolio, universe }
 */
export async function buyAndHoldStrategy(ctx) {
  if (_opened) return [];   // already long, no further action
  if (!ctx.universe.includes('SPY')) return [];
  _opened = true;
  return [{ action: 'enter_long', symbol: 'SPY' }];
}

// Reset between backtest runs
export function resetBuyAndHold() {
  _opened = false;
}
