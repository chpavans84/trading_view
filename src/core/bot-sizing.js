/**
 * src/core/bot-sizing.js
 *
 * Pure position-sizing + stop-loss math. NO I/O. Extracted from
 * src/core/bot-executor.js so the numerical logic can be unit-tested
 * without mocking Alpaca, the DB, or live quotes.
 *
 * Each function takes plain numbers / objects and returns a result.
 * Tests live in tests/bot-sizing.test.js.
 */

const DEFAULT_SIZE_PCT      = 95;   // percent of capital to deploy per trade
const DEFAULT_STOP_LOSS_USD = 50;   // fallback dollar loss limit
const FALLBACK_STOP_PCT     = 3;    // applied only when qty resolves to 0 (defensive)

/**
 * How much capital to deploy in dollars, given size-pct rule.
 *
 * @param {number} capitalUsd        bot's total budget
 * @param {number} [sizePct]         percent of capital (1-100). Defaults to 95.
 * @returns {number}                 integer dollars (floored)
 */
export function computeDollarBudget(capitalUsd, sizePct = DEFAULT_SIZE_PCT) {
  const cap = Number(capitalUsd);
  if (!Number.isFinite(cap) || cap <= 0)      return 0;
  const pct = Number(sizePct);
  if (!Number.isFinite(pct) || pct <= 0)      return 0;
  // Floor to dollar — never overspend
  return Math.floor(cap * Math.min(pct, 100) / 100);
}

/**
 * Convert a dollar budget + current price into a share qty.
 * Floors to whole shares (B-3.7 paper bots don't use fractionals here).
 *
 * @param {number} dollarBudget
 * @param {number} price
 * @returns {number}                 integer shares (>= 0)
 */
export function computeQty(dollarBudget, price) {
  const b = Number(dollarBudget);
  const p = Number(price);
  if (!Number.isFinite(b) || b <= 0)          return 0;
  if (!Number.isFinite(p) || p <= 0)          return 0;
  return Math.floor(b / p);
}

/**
 * Compute the stop-loss percent based on dollar risk + invested amount.
 *
 * If dollarsInvested is 0/invalid (qty=0 edge case), returns FALLBACK_STOP_PCT
 * so callers never end up with a NaN/Infinity stop.
 *
 * @param {number} stopLossUsd
 * @param {number} dollarsInvested
 * @returns {number}                 percent, rounded to 2 decimals
 */
export function computeStopPct(stopLossUsd, dollarsInvested) {
  const sl = Number(stopLossUsd) || DEFAULT_STOP_LOSS_USD;
  const di = Number(dollarsInvested);
  if (!Number.isFinite(di) || di <= 0) return FALLBACK_STOP_PCT;
  return +((sl / di) * 100).toFixed(2);
}

/**
 * Compute the absolute stop-loss price for a long position.
 *
 * @param {number} fillPrice
 * @param {number} stopPct           e.g. 3 for "3% below fill"
 * @returns {number}                 stop price, 2-decimal precision
 */
export function computeStopPrice(fillPrice, stopPct) {
  const fp = Number(fillPrice);
  const sp = Number(stopPct);
  if (!Number.isFinite(fp) || fp <= 0) return 0;
  if (!Number.isFinite(sp))            return fp;
  return +(fp * (1 - sp / 100)).toFixed(2);
}

/**
 * Full sizing pipeline — used by _tryOpenPosition. Captures all the numerical
 * decisions in one place so the test suite can verify the entire chain.
 *
 * @param {object} args
 * @param {number} args.capitalUsd
 * @param {number} args.price
 * @param {number} [args.sizePct]
 * @param {number} [args.stopLossUsd]
 * @returns {{ skip: 'no_capital' | 'no_price' | 'insufficient_capital' } |
 *           { qty: number, dollarBudget: number, dollarsInvested: number,
 *             stopPct: number, stopPrice: number }}
 */
export function planEntry({ capitalUsd, price, sizePct = DEFAULT_SIZE_PCT, stopLossUsd = DEFAULT_STOP_LOSS_USD }) {
  const dollarBudget = computeDollarBudget(capitalUsd, sizePct);
  if (dollarBudget <= 0) {
    return { skip: 'no_capital', dollarBudget: 0, qty: 0, dollarsInvested: 0, stopPct: 0, stopPrice: 0 };
  }
  if (!Number.isFinite(Number(price)) || Number(price) <= 0) {
    return { skip: 'no_price', dollarBudget, qty: 0, dollarsInvested: 0, stopPct: 0, stopPrice: 0 };
  }
  const qty = computeQty(dollarBudget, price);
  if (qty < 1) {
    return { skip: 'insufficient_capital', dollarBudget, qty: 0, dollarsInvested: 0, stopPct: 0, stopPrice: 0 };
  }
  const dollarsInvested = +(Number(price) * qty).toFixed(2);
  const stopPct  = computeStopPct(stopLossUsd, dollarsInvested);
  const stopPrice = computeStopPrice(price, stopPct);
  return { qty, dollarBudget, dollarsInvested, stopPct, stopPrice };
}

/**
 * Has this bot tripped its circuit breaker? Pure function so the executor
 * can call it without going to the DB twice. Used together with the DB
 * query that fetches cumulative_pnl_usd + max_loss_usd.
 *
 * Returns true if cumulative loss has reached or exceeded the limit.
 *
 * `maxLossUsd` is a POSITIVE dollar amount (e.g. 100 for "$100 lifetime cap").
 * A value of 0, negative, NaN, or null is treated as "circuit breaker disabled"
 * — almost certainly a config typo, safer than guessing the user's intent.
 *
 * @param {number} cumulativePnlUsd
 * @param {number} maxLossUsd
 * @returns {boolean}
 */
export function isCircuitBreakerTripped(cumulativePnlUsd, maxLossUsd) {
  const pnl = Number(cumulativePnlUsd);
  const cap = Number(maxLossUsd);
  if (!Number.isFinite(pnl) || !Number.isFinite(cap) || cap <= 0) return false;
  return pnl <= -cap;
}
