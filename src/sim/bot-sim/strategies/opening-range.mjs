/**
 * strategies/opening-range.mjs — intraday Opening-Range Breakout (morning momentum).
 *
 * From the research: morning (9:30-11:30) returns drive CONTINUATION, and ORB
 * with trailing stops is convex (~43% hit ratio, edge = big winners not frequency).
 * Long-only, intraday (exit EOD). "In play" = gapped up vs prior close.
 *
 * Rules:
 *   universe — liquid + above 200d (quality) + regime-allowed.
 *   in-play  — today's open gapped up ≥ gap_min vs prior close.
 *   OR       — high of the first or_minutes (9:30 → 9:30+or_minutes).
 *   entry    — after the OR window, price breaks ABOVE the OR high, still in the
 *              morning, and trading above prior close (momentum confirmed).
 *   exit     — trailing stop (convexity) + same-day EOD close + OR-low hard stop.
 */
import { etMinutes } from './_shared.mjs';

const OPEN_ET = 570;   // 9:30

export const seedPolicy = {
  version: 0, source: 'seed',
  regimes_allowed: ['R1_up_calm', 'R2_up_vol'],
  setup: { require_above_sma200: true },
  entry: {
    or_minutes: 30,            // opening range = first 30 min (9:30-10:00)
    earliest_et_min: 600,      // breakouts valid from 10:00
    latest_et_min: 690,        // ...until 11:30 (morning-momentum window)
    gap_min: 0.005,            // in-play: gapped up ≥ 0.5% vs prior close
  },
  sizing: { dollars_per_trade: 10000, max_positions: 10, max_new_per_day: 8 },
  exits: { hard_sl_pct: 0.04, trail_pct: 0.03, time_stop_days: 1, eod_exit: true },
};

export function qualifyNames(feed, policy) {
  const regime = feed.regimeNow();
  if (!regime || !policy.regimes_allowed.includes(regime.regime)) return { regime, names: new Set() };
  const names = new Set();
  for (const sym of feed.universe) {
    const f = feed.dailyFeat(sym);
    if (!f) continue;
    if (policy.setup.require_above_sma200 && !(f.dist_sma200 > 0)) continue;
    names.add(sym);
  }
  return { regime, names };
}

export function confirmEntry(feed, symbol, policy) {
  const e = policy.entry, bars = feed.intraday(symbol);
  if (bars.length < 6) return { ok: false };
  const now = bars[bars.length - 1], mins = etMinutes(new Date(now.t));
  if (mins < e.earliest_et_min || mins > e.latest_et_min) return { ok: false };

  const prevClose = feed.dailyFeat(symbol)?.close;
  const open = bars[0].o;
  if (!(prevClose > 0)) return { ok: false };
  // in-play: gapped up vs prior close
  if (!((open / prevClose - 1) >= e.gap_min)) return { ok: false };

  // opening-range high over the first or_minutes
  const orEnd = OPEN_ET + e.or_minutes;
  const orBars = bars.filter(b => etMinutes(new Date(b.t)) < orEnd);
  if (orBars.length < 3) return { ok: false };
  const orHigh = Math.max(...orBars.map(b => b.h));
  const orLow  = Math.min(...orBars.map(b => b.l));

  // breakout: current bar closes above the OR high, momentum confirmed vs prior close
  if (!(now.c > orHigh && now.c > prevClose)) return { ok: false };
  return { ok: true, reasons: ['orb_break', `gap${((open/prevClose-1)*100).toFixed(1)}`], refClose: now.c, orLow };
}

/** Intraday exits: OR-low hard stop, trailing stop, forced EOD close. */
export function exitParams(policy, fillPx, fillT, conf) {
  const x = policy.exits;
  const orLowStop = conf?.orLow ? Math.min(conf.orLow, fillPx * (1 - x.hard_sl_pct)) : fillPx * (1 - x.hard_sl_pct);
  return {
    stopPx: +orLowStop.toFixed(4),
    trailPct: x.trail_pct || 0,
    peak: fillPx, trailing: false,
    timeStopT: fillT + (x.time_stop_days ?? 1) * 24 * 3600e3,
    eodExit: true,
  };
}

export const name = 'opening-range';
export default { name, seedPolicy, qualifyNames, confirmEntry, exitParams };
