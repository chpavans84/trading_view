/**
 * strategies/reversal.mjs — volatility/turnover-conditioned short-term reversal
 * on oversold LOSERS (the long-only, liquidity-shock leg of the reversal anomaly).
 *
 * From the research (Da/Liu/Schaumburg; Dai/Medhat/Novy-Marx):
 *   • the losers leg is the buyable long-only leg (fire-sale liquidity demand);
 *   • higher volatility ⇒ faster/stronger reversal (condition on it);
 *   • liquid/high-turnover names exhaust reversal in ~2 weeks ⇒ short hold;
 *   • enter on a reclaim (don't catch the falling knife — our validated fix).
 *
 * Distinct from `pullback`: deeper drop (real losers, −15%..−4%), requires
 * elevated volatility, no 52w-high constraint, reclaim entry, ~1-week hold.
 */
import { etMinutes, vwapOf, swingExits } from './_shared.mjs';

export const seedPolicy = {
  version: 0, source: 'seed',
  regimes_allowed: ['R1_up_calm', 'R2_up_vol'],
  setup: {
    require_above_sma200: true,   // long-term uptrend intact (quality / not a falling knife)
    drop_min: -0.15, drop_max: -0.04,   // a real short-term loser, not a shallow dip
    vol_min: 0.25,                // elevated 20d realized vol → faster reversal
    rvol_max: 4.0,
  },
  entry: { earliest_et_min: 600, latest_et_min: 930, require_green_minute: true },
  sizing: { dollars_per_trade: 10000, max_positions: 10, max_new_per_day: 5 },
  exits: { hard_sl_pct: 0.12, trail_pct: 0, time_stop_days: 5 },
};

export function qualifyNames(feed, policy) {
  const regime = feed.regimeNow();
  if (!regime || !policy.regimes_allowed.includes(regime.regime)) return { regime, names: new Set() };
  const s = policy.setup, names = new Set();
  for (const sym of feed.universe) {
    const f = feed.dailyFeat(sym);
    if (!f) continue;
    if (s.require_above_sma200 && !(f.dist_sma200 > 0)) continue;
    if (!(f.ret_5d >= s.drop_min && f.ret_5d <= s.drop_max)) continue;   // oversold loser
    if (!(f.rvol != null && f.rvol < s.rvol_max)) continue;
    // volatility condition: prefer elevated vol (faster reversal). vol proxy = |ret_5d| annualized-ish
    // use rvol or the 5d drop magnitude as the conditioning signal; require a real shock.
    if (s.vol_min != null) { const shock = Math.abs(f.ret_5d); if (!(shock >= 0.04)) continue; }
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
  // reclaim: dipped to/below VWAP today, now back above (bounce confirmed)
  const dipped = bars.slice(-15).some(b => b.l < vwap);
  if (!(dipped && now.c > vwap)) return { ok: false };
  if (e.require_green_minute && !(now.c > now.o)) return { ok: false };
  return { ok: true, reasons: ['reversal_reclaim'], refClose: now.c };
}

export const exitParams = swingExits;
export const name = 'reversal';
export default { name, seedPolicy, qualifyNames, confirmEntry, exitParams };
