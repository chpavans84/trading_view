/**
 * regime-bot/primary-signal.js
 *
 * Long-only 50/200 SMA crossover. Inputs are pre-loaded price arrays
 * (from price-loader.js) so this file is pure-function and easy to unit-test.
 *
 * Citation: Faber, "A Quantitative Approach to Tactical Asset Allocation"
 * (2007) — canonical reference for moving-average tactical signals.
 *
 * Signal interpretation:
 *    +1  fast SMA above slow SMA              → long position desired
 *     0  insufficient data OR fast === slow   → hold previous state
 *    -1  fast SMA below slow SMA              → flat (long-only, no short)
 *
 * Hysteresis: small floating-point noise around the crossover can flip
 * the signal back and forth. We treat |fast - slow| < 0.05% as "no change".
 */

import { PRIMARY_SIGNAL } from './config.js';

const HYSTERESIS_RATIO = 0.0005;  // 0.05% of slow SMA

/**
 * Computes a simple moving average of the last `window` close prices.
 * @param {Array<{date: string, close: number}>} prices  chronological
 * @param {number} window
 * @returns {number|null}  null if insufficient data
 */
export function sma(prices, window) {
  if (!Array.isArray(prices) || prices.length < window) return null;
  let sum = 0;
  for (let i = prices.length - window; i < prices.length; i++) {
    sum += prices[i].close;
  }
  return sum / window;
}

/**
 * Returns the primary signal for the latest bar.
 * @param {Array<{date: string, close: number}>} prices  chronological
 * @param {object} [opts]
 * @param {number} [opts.fast=50]
 * @param {number} [opts.slow=200]
 * @returns {{
 *   signal: -1 | 0 | 1,
 *   fast_sma: number|null,
 *   slow_sma: number|null,
 *   price: number|null,
 *   ratio: number|null,
 *   notes: string
 * }}
 */
export function primarySignal(prices, opts = {}) {
  const fast = opts.fast ?? PRIMARY_SIGNAL.fast_sma_days;
  const slow = opts.slow ?? PRIMARY_SIGNAL.slow_sma_days;

  if (!Array.isArray(prices) || prices.length < slow) {
    return {
      signal:   0,
      fast_sma: null,
      slow_sma: null,
      price:    prices?.[prices.length - 1]?.close ?? null,
      ratio:    null,
      notes:    `insufficient_history (need ${slow}, have ${prices?.length ?? 0})`,
    };
  }

  const fastSma = sma(prices, fast);
  const slowSma = sma(prices, slow);
  const price   = prices[prices.length - 1].close;

  if (fastSma == null || slowSma == null || !Number.isFinite(slowSma) || slowSma === 0) {
    return {
      signal:   0,
      fast_sma: fastSma,
      slow_sma: slowSma,
      price,
      ratio:    null,
      notes:    'sma_compute_failed',
    };
  }

  const diff  = fastSma - slowSma;
  const ratio = diff / slowSma;

  // Hysteresis band around the crossover
  if (Math.abs(ratio) < HYSTERESIS_RATIO) {
    return {
      signal:   0,
      fast_sma: fastSma,
      slow_sma: slowSma,
      price,
      ratio,
      notes:    'within_hysteresis_band',
    };
  }

  return {
    signal:   ratio > 0 ? 1 : -1,
    fast_sma: fastSma,
    slow_sma: slowSma,
    price,
    ratio,
    notes:    ratio > 0 ? 'fast_above_slow' : 'fast_below_slow',
  };
}

/**
 * Convenience: compute primary signal directly from a ticker by querying
 * backtest_prices via price-loader. Use this in the engine; tests should
 * use primarySignal() with synthetic prices for determinism.
 *
 * @param {string} ticker
 * @param {object} [opts]  passed through to primarySignal
 * @returns {Promise<object>}
 */
export async function primarySignalForTicker(ticker, opts = {}) {
  const { getPricesArray } = await import('./price-loader.js');
  const prices = await getPricesArray(ticker);
  return primarySignal(prices, opts);
}

// Self-test
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const ticker = process.argv[2] || 'SPY';
    try {
      const result = await primarySignalForTicker(ticker);
      console.log(`Primary signal for ${ticker}:`);
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error('[fatal]', e.message);
      process.exit(1);
    } finally {
      // close the pool that price-loader opened
      const pl = await import('./price-loader.js');
      // no public end fn — just let process exit naturally
      process.exit(0);
    }
  })();
}
