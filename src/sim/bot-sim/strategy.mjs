/**
 * src/sim/bot-sim/strategy.mjs — the evidence-based strategy (BOT_SIM).
 *
 * Forked in spirit from src/core/bot-advance/entry-rules.js, but rewritten
 * around what the 10-year survivorship-free study actually proved:
 *
 *   • The ONE walk-forward-stable setup is the "uptrend pullback":
 *       above SMA200, within ~15% of the 52w high, 5-day return −8%..−2%,
 *       RVOL < 2.  (R2 up-vol regime: 63-66% win, +150-197bp, stable in BOTH
 *       2017-21 and 2022-26 halves. Random entries in the same regime decayed.)
 *   • The bot's old style — chasing RVOL≥3 spikes / hot momentum — was the
 *       single WORST bucket in the decade (−1.9% excess). BOT_SIM never does it.
 *   • Tight stops destroyed the edge (sold noise). Exits are wide + time-based.
 *
 * Everything tunable lives in `policy` so the learning layer can adjust it
 * between sim-days WITHOUT touching code. The daily qualification uses ONLY
 * prior-session features (feed enforces this); intraday timing uses bars ≤ clock.
 */

export const SEED_POLICY = {
  version: 0,
  source: 'seed',
  regimes_allowed: ['R1_up_calm', 'R2_up_vol'],     // uptrend only; avoid down regimes
  setup: {
    require_above_sma200: true,
    dist52w_min:  -0.15,     // within 15% of the 52-week high
    pullback_min: -0.08,     // 5-day return floor (not a crash)
    pullback_max: -0.02,     // 5-day return ceiling (a real pullback, not extension)
    rvol_max:      2.0,      // NOT a volume spike (the chase the old bot died on)
    require_above_sma50: false,  // step-3 filter: shallow dip (still above 50d), not a deep break
    require_rs_positive: false,  // step-3 filter: name outperforming SPY (rs_spy_20 > 0)
  },
  entry: {
    earliest_et_min: 600,           // 10:00 ET — let the open settle (avoid first 30m)
    latest_et_min:   930,           // 15:30 ET — no fresh entries in the last 30m
    // mode = how we time the intraday entry:
    //   'pullback' (default) — buy weakness (price ≤ VWAP). Knife-catches.
    //   'reclaim'  — wait for the bounce: price dipped below VWAP then crossed back
    //                ABOVE it (trend-RESUMPTION confirmation, step 3).
    mode: 'pullback',
    require_green_minute:  true,    // a green stabilizing minute
    uw_confirm: false,              // optional: require bull>bear UW premium when available
    require_market_bounce: false,   // step-3 (#2): only enter when SPY itself is bouncing
                                    // intraday (SPY ≥ its own VWAP). Targets grinding
                                    // selloffs (Sep-2020) where name reclaims were bull traps.
  },
  sizing: { dollars_per_trade: 10000, max_positions: 10, max_new_per_day: 5 },
  // Exit grid (2026-06-13, R1 window): the TRAIL stop was a net leak (29% win,
  // −$1.6k) — removing it flips the month positive. A wide hard stop never fired
  // in calm bull but is kept as gap/crash protection. Horizon left at 3d as a
  // neutral default: 2d was best in R1 (+0.75%) but that's likely regime-specific
  // (R2's 10yr edge is a 5-10d forward move) → horizon should be regime-tuned,
  // not hardcoded. See reports/strategy-research-20260613/SIM_FINDINGS.md.
  exits:  { hard_sl_pct: 0.12, trail_pct: 0, time_stop_days: 3 },
};

const etMinutes = (d) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  return +p.find(x => x.type === 'hour').value * 60 + +p.find(x => x.type === 'minute').value;
};

/**
 * Daily qualification — which names are eligible TODAY, using prior-session
 * features + the prior-session regime. Pure, point-in-time. Returns a Set.
 */
export function qualifyNames(feed, policy) {
  const regime = feed.regimeNow();
  if (!regime || !policy.regimes_allowed.includes(regime.regime)) return { regime, names: new Set() };
  const s = policy.setup;
  const names = new Set();
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

/**
 * Intraday entry confirmation for an already-qualified name at the current clock.
 * Returns { ok, reasons } — ok=true means "enter now".
 */
export function confirmEntry(feed, symbol, policy) {
  const e = policy.entry;
  const bars = feed.intraday(symbol);
  if (bars.length < 5) return { ok: false };
  const now = bars[bars.length - 1];
  const mins = etMinutes(new Date(now.t));
  if (mins < e.earliest_et_min || mins > e.latest_et_min) return { ok: false };

  // VWAP so far today (the intraday pullback reference)
  let pv = 0, vol = 0;
  for (const b of bars) { const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vol += b.v; }
  const vwap = vol > 0 ? pv / vol : now.c;

  // market-bounce gate: SPY must be at/above its own intraday VWAP (the market is
  // bidding, not bleeding). Cheap proxy that separates V-snapbacks from grinds.
  if (e.require_market_bounce) {
    const spy = feed.intraday('SPY');
    if (spy.length < 5) return { ok: false };
    let pv = 0, vol = 0;
    for (const b of spy) { pv += ((b.h + b.l + b.c) / 3) * b.v; vol += b.v; }
    const spyVwap = vol > 0 ? pv / vol : spy[spy.length - 1].c;
    if (!(spy[spy.length - 1].c >= spyVwap)) return { ok: false };
  }

  const reasons = [];
  const mode = e.mode || 'pullback';
  const dippedBelow = bars.slice(-15).some(b => b.l < vwap);   // pulled back to VWAP today
  if (mode === 'reclaim') {
    // trend-RESUMPTION: it dipped to/below VWAP, and the current bar is back ABOVE it
    if (!(dippedBelow && now.c > vwap)) return { ok: false };
    reasons.push('vwap_reclaim');
  } else {
    // pullback (default): buy weakness — price at/below VWAP
    if (!(now.c <= vwap)) return { ok: false };
    reasons.push('below_vwap');
  }

  // stabilization: a green minute AND not making a fresh 5-bar low
  const last5low = Math.min(...bars.slice(-5).map(b => b.l));
  const green = now.c > now.o;
  if (e.require_green_minute && !green) return { ok: false };
  if (!(now.l > last5low * 0.999)) return { ok: false };   // still slicing lower → wait
  reasons.push('stabilizing');

  if (e.uw_confirm) {
    const uw = feed.uwFlow(symbol, 24);
    if (!(uw.bull > uw.bear)) return { ok: false };
    if (uw.n > 0) reasons.push('uw_bull');
  } else {
    const uw = feed.uwFlow(symbol, 24);
    if (uw.n > 0 && uw.bull > uw.bear) reasons.push('uw_bull');   // informational
  }

  return { ok: true, reasons, vwap, refClose: now.c };
}

/** Build the exit parameters that travel with a new trade.
 *  hard_sl_pct = 0/null → no hard stop;  trail_pct = 0/null → no trailing. */
export function exitParams(policy, fillPx, fillT) {
  const x = policy.exits;
  return {
    stopPx: x.hard_sl_pct ? +(fillPx * (1 - x.hard_sl_pct)).toFixed(4) : null,
    trailPct: x.trail_pct || 0,
    peak: fillPx,
    trailing: false,
    timeStopT: fillT + x.time_stop_days * 24 * 3600e3,   // calendar-day horizon
  };
}
