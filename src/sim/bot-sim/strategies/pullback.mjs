/**
 * strategies/pullback.mjs — "uptrend pullback" (the original BOT_SIM strategy).
 * A short-term reversal on oversold names within a long-term uptrend. The
 * research confirms this family (liquidity-shock losers = the long-only leg).
 */
import { etMinutes, vwapOf, swingExits } from './_shared.mjs';

export const seedPolicy = {
  version: 0, source: 'seed',
  regimes_allowed: ['R1_up_calm', 'R2_up_vol'],
  setup: {
    require_above_sma200: true, dist52w_min: -0.15,
    pullback_min: -0.08, pullback_max: -0.02, rvol_max: 2.0,
    require_above_sma50: false, require_rs_positive: false,
  },
  entry: { earliest_et_min: 600, latest_et_min: 930, mode: 'pullback', require_green_minute: true, uw_confirm: false, require_market_bounce: false },
  sizing: { dollars_per_trade: 10000, max_positions: 10, max_new_per_day: 5 },
  exits: { hard_sl_pct: 0.12, trail_pct: 0, time_stop_days: 3 },
};

export function qualifyNames(feed, policy) {
  const regime = feed.regimeNow();
  if (!regime || !policy.regimes_allowed.includes(regime.regime)) return { regime, names: new Set() };
  const s = policy.setup, names = new Set();
  for (const sym of feed.universe) {
    const f = feed.dailyFeat(sym);
    if (!f) continue;
    if (s.require_above_sma200 && !(f.dist_sma200 > 0)) continue;
    if (s.require_above_sma50 && !(f.dist_sma50 > 0)) continue;
    if (s.require_rs_positive && !(f.rs_spy_20 > 0)) continue;
    if (!(f.dist_52whigh > s.dist52w_min)) continue;
    if (!(f.ret_5d >= s.pullback_min && f.ret_5d <= s.pullback_max)) continue;
    if (!(f.rvol != null && f.rvol < s.rvol_max)) continue;
    names.add(sym);
  }
  return { regime, names };
}

export function confirmEntry(feed, symbol, policy) {
  const e = policy.entry, bars = feed.intraday(symbol);
  if (bars.length < 5) return { ok: false };
  const now = bars[bars.length - 1], mins = etMinutes(new Date(now.t));
  if (mins < e.earliest_et_min || mins > e.latest_et_min) return { ok: false };
  const vwap = vwapOf(bars);
  const reasons = [], mode = e.mode || 'pullback';
  const dippedBelow = bars.slice(-15).some(b => b.l < vwap);
  if (mode === 'reclaim') { if (!(dippedBelow && now.c > vwap)) return { ok: false }; reasons.push('vwap_reclaim'); }
  else { if (!(now.c <= vwap)) return { ok: false }; reasons.push('below_vwap'); }
  const last5low = Math.min(...bars.slice(-5).map(b => b.l));
  if (e.require_green_minute && !(now.c > now.o)) return { ok: false };
  if (!(now.l > last5low * 0.999)) return { ok: false };
  reasons.push('stabilizing');
  return { ok: true, reasons, refClose: now.c };
}

export const exitParams = swingExits;
export const name = 'pullback';
export default { name, seedPolicy, qualifyNames, confirmEntry, exitParams };
