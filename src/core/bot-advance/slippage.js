/**
 * src/core/bot-advance/slippage.js — honest execution-slippage metric.
 *
 * slippage_cents = (fill − reference) × 100, where the reference is the live
 * quote the order was SIZED against. Returns null when the reference is missing
 * or implausible (|fill−ref|/ref > maxFrac), so a bad reference records "unknown"
 * instead of a fictional number. See GOTCHAS "Bot-advance slippage metric".
 *
 * Pure + side-effect free → unit-tested in tests/bot-advance-slippage.test.js.
 */
export function computeSlippageCents(fillPrice, refPrice, { maxFrac = 0.05 } = {}) {
  const fill = Number(fillPrice), ref = Number(refPrice);
  if (!(fill > 0) || !(ref > 0)) return null;
  if (Math.abs(fill - ref) / ref > maxFrac) return null;   // bad reference → unknown
  return +(((fill - ref) * 100).toFixed(2));
}
