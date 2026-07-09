/**
 * strategies/insider-buy.mjs — event-driven long on recent OPEN-MARKET INSIDER BUYS.
 *
 * From the 2026-07-09 event study (uw_insider_trades code 'P', market-adjusted vs SPY,
 * survivorship-free prices, 2024-2026):
 *   • +10.24% 20d EXCESS over SPY in risk-on (SPY>200d), n=3833 — real alpha, not beta;
 *   • edge ~vanishes risk-off (+0.26%, n=181) ⇒ REGIME-GATE to R1/R2 (up regimes);
 *   • edge SCALES with buy size: <$10K +7.2% / $10-100K +8.0% / >=$100K +13.5% ⇒ size filter;
 *   • 8/10 quarters positive; edge is MAGNITUDE (positive skew), win ~53%, not hit-frequency;
 *   • best held ~20d (sim window truncates → time_stop_days here is a tunable, default 10).
 *
 * Entry driver is the insider filing itself (public at filed_at = known_at, no lookahead) —
 * no technical setup required. Light intraday confirmation only, for a clean fill.
 */
import { etMinutes, swingExits } from './_shared.mjs';

export const seedPolicy = {
  version: 0, source: 'seed',
  regimes_allowed: ['R1_up_calm', 'R2_up_vol'],   // regime gate: only when SPY is risk-on
  setup: {
    lookback_days: 5,        // buy within 5 trading days of the Form-4 filing
    min_value: 100000,       // >=$100K single filing — the highest-edge tier
    require_above_sma200: false,   // signal is the driver; don't over-filter (study didn't require it)
  },
  entry: { earliest_et_min: 600, latest_et_min: 930, require_green_minute: true },
  sizing: { dollars_per_trade: 10000, max_positions: 10, max_new_per_day: 5 },
  exits: { hard_sl_pct: 0.12, trail_pct: 0, time_stop_days: 10 },   // wide stop, no trail (trail leaks), swing hold
};

export function qualifyNames(feed, policy) {
  const regime = feed.regimeNow();
  if (!regime || !policy.regimes_allowed.includes(regime.regime)) return { regime, names: new Set() };
  const s = policy.setup, names = new Set();
  for (const sym of feed.universe) {
    const ins = feed.insiderBuys(sym, s.lookback_days);
    if (!(ins.n > 0 && ins.maxValue >= s.min_value)) continue;   // recent >=$100K open-market BUY
    if (s.require_above_sma200) { const f = feed.dailyFeat(sym); if (!f || !(f.dist_sma200 > 0)) continue; }
    names.add(sym);
  }
  return { regime, names };
}

export function confirmEntry(feed, symbol, policy) {
  const e = policy.entry, bars = feed.intraday(symbol);
  if (bars.length < 2) return { ok: false };
  const now = bars[bars.length - 1], mins = etMinutes(new Date(now.t));
  if (mins < e.earliest_et_min || mins > e.latest_et_min) return { ok: false };
  if (e.require_green_minute && !(now.c > now.o)) return { ok: false };   // enter into strength, not a fade
  return { ok: true, reasons: ['insider_buy'], refClose: now.c };
}

export const exitParams = swingExits;
export const name = 'insider-buy';
export default { name, seedPolicy, qualifyNames, confirmEntry, exitParams };
