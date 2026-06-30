/**
 * strategies/breakout.mjs — volume-confirmed 20-day breakout with hold-discipline exits.
 *
 * Encodes the 2026-06-20 breakout research (reports/breakout-study-20260620/README.md):
 *   • Most 20-day breakouts FAIL (~55% become traps). The ONE proven entry filter is the
 *     breakout-DAY VOLUME (RVOL): <1x → 60% false, ≥2.5x → 28% false. The multi-week
 *     pre-breakout volume TREND is useless (Study B). Stacking volume + decisive break +
 *     above-200SMA + next-day-hold → ~89% real (but rare, ~2% of breakouts).
 *   • The EDGE is the HOLD side: a breakout that stays above its level is green ~90% — and
 *     it's regime-PROOF (survives the 2022 bear at 90.5%) (Study C/C4).
 *   • The SELL side is NOT solved: level-stops whipsaw and UNDERPERFORM just holding (Study C5).
 *     ⇒ exits here are WIDE + TIME-BASED (no trail, no tight level-stop) by design.
 *   • UW flow / dealer GEX add ~nothing for trap-avoidance (Study E) → not used.
 *
 * Sim mapping: the breakout is a PRIOR-session event (dist_20dhigh as-of prior close, point-in-time
 * via the feed). The intraday confirmEntry IS the "next-day hold" confirmation — we only buy if the
 * breakout is being DEFENDED intraday (price holding above VWAP), never chase a fresh spike.
 */
import { etMinutes, vwapOf, swingExits } from './_shared.mjs';

export const seedPolicy = {
  version: 0, source: 'seed',
  regimes_allowed: ['R1_up_calm', 'R2_up_vol'],
  setup: {
    require_above_sma200: true,   // trend alignment (part of the stacked filter; quality gate)
    brk_min:      0.0,            // dist_20dhigh > brk_min ⇒ closed above prior 20-day high
    decisive_min: 0.0,            // optional: require clearing the level by ≥ this (0.02 = 2%)
    rvol_min:     1.5,            // THE proven lever — breakout-day volume confirmation
  },
  entry: {
    earliest_et_min: 600, latest_et_min: 930,   // 10:00–15:30 ET
    require_green_minute: true,
    require_above_vwap:  true,    // hold confirmation: breakout being defended (not reversing)
    require_hold_level:  false,   // stricter option: price ≥ prior-session (breakout) close
  },
  sizing: { dollars_per_trade: 10000, max_positions: 10, max_new_per_day: 5 },
  // hold-discipline: wide hard stop = gap/crash protection only; NO trail / NO level-stop
  // (they leak — Study C5). Time-based exit (research horizon ~10d; default 5d, tunable).
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
    if (f.dist_20dhigh == null || !(f.dist_20dhigh > s.brk_min)) continue;   // is a 20-day breakout
    if (s.decisive_min && !(f.dist_20dhigh >= s.decisive_min)) continue;     // decisive break
    // BO_RVOL_MIN env = sweep hook for the held-out fit (overrides the seed rvol_min only)
    const rvolMin = process.env.BO_RVOL_MIN ? +process.env.BO_RVOL_MIN : s.rvol_min;
    if (!(f.rvol != null && f.rvol >= rvolMin)) continue;                    // volume-confirmed
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
  const reasons = ['breakout'];
  // hold confirmation: the breakout is being defended intraday (price holding above VWAP)
  if (e.require_above_vwap && !(now.c > vwap)) return { ok: false };
  if (e.require_above_vwap) reasons.push('above_vwap');
  if (e.require_hold_level) {
    const f = feed.dailyFeat(symbol);
    if (!(f && now.c >= f.close)) return { ok: false };   // still above the breakout close
    reasons.push('hold_level');
  }
  if (e.require_green_minute && !(now.c > now.o)) return { ok: false };
  const last5low = Math.min(...bars.slice(-5).map(b => b.l));
  if (!(now.l > last5low * 0.999)) return { ok: false };  // not slicing to fresh lows → wait
  reasons.push('holding');
  return { ok: true, reasons, refClose: now.c };
}

export const exitParams = swingExits;
export const name = 'breakout';
export default { name, seedPolicy, qualifyNames, confirmEntry, exitParams };
