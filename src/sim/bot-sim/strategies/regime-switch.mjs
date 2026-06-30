/**
 * strategies/regime-switch.mjs — regime-switched book (2026-06-22).
 *
 * Evidence (reports/breakout-study-20260620 Study F2, ~2,700-trade rolling walk-forward,
 * realistic slippage): breakout and pullback are COMPLEMENTARY, each regime-specific:
 *   • R1 calm-bull  → breakout +0.352%/trade (893 trades, 55% win) >> pullback +0.144%
 *   • R2 up-vol     → pullback +0.713%/trade (63% win)             >> breakout −0.169% (loses)
 *   • R3/R4 down    → both stand aside (gate).
 * So: run BREAKOUT in R1, PULLBACK in R2, nothing otherwise.
 *
 * Delegation through the engine contract: qualify + confirm use the CURRENT regime (stable
 * within a sim-day via feed.regimeNow); exit params are baked in AT ENTRY and travel with the
 * trade (we stash the entry regime on the confirm result `conf._regime` so exitParams uses the
 * SAME sub-strategy's exits even if the regime later flips).
 */
import breakout from './breakout.mjs';
import pullback from './pullback.mjs';

const SUBS = { R1_up_calm: breakout, R2_up_vol: pullback };
const subFor = (regime) => (regime ? SUBS[regime] : null);

export const seedPolicy = {
  version: 0, source: 'seed',
  regimes_allowed: ['R1_up_calm', 'R2_up_vol'],
  // engine reads sizing at top level; both sub-strategies use the same sizing
  sizing: { dollars_per_trade: 10000, max_positions: 10, max_new_per_day: 5 },
  by_regime: { R1_up_calm: breakout.seedPolicy, R2_up_vol: pullback.seedPolicy },
};

export function qualifyNames(feed, policy) {
  const regime = feed.regimeNow();
  const sub = subFor(regime?.regime);
  if (!sub || !policy.regimes_allowed.includes(regime.regime)) return { regime, names: new Set() };
  return sub.qualifyNames(feed, policy.by_regime[regime.regime]);
}

export function confirmEntry(feed, symbol, policy) {
  const regime = feed.regimeNow();
  const sub = subFor(regime?.regime);
  if (!sub) return { ok: false };
  const r = sub.confirmEntry(feed, symbol, policy.by_regime[regime.regime]);
  if (r && r.ok) {
    r._regime = regime.regime;                                   // travels to exitParams
    r.reasons = [`${regime.regime}→${sub.name}`, ...(r.reasons || [])];
  }
  return r;
}

export function exitParams(policy, fillPx, fillT, conf) {
  const regime = conf?._regime || 'R1_up_calm';
  const sub = SUBS[regime] || breakout;
  return sub.exitParams(policy.by_regime[regime], fillPx, fillT, conf);
}

export const name = 'regime-switch';
export default { name, seedPolicy, qualifyNames, confirmEntry, exitParams };
