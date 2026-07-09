/**
 * src/sim/broker.mjs — simulated execution against replayed minute bars.
 *
 * No real broker, no money, no production trader.js. Models the two things
 * that actually move backtest realism:
 *   1. Fills happen on the NEXT bar's open (you can't fill on the bar you used
 *      to decide) + a small slippage in the adverse direction.
 *   2. Stops are checked GAP-AWARE against each subsequent bar's high/low — if
 *      the bar gaps through the stop, you exit at the open, not the stop price.
 *
 * Slippage is modeled honestly (a few bps for liquid large-caps), NOT taken
 * from the contaminated production slippage_cents that conflated execution with
 * stale-price drift — the very bug this whole exercise is meant to avoid.
 */

const SLIP_BPS = 4;        // per side, adverse — liquid S&P/NDX names (flat model)

// ── Realistic slippage model (SIM_SLIP_MODEL=realistic, default) ──────────────
// The fix this addresses: flat bps under-charges strategies that BUY STRENGTH
// (breakout enters into up-momentum, taking liquidity aggressively → worse fills),
// while pullback BUYS WEAKNESS (enters at/below VWAP, ~provides liquidity → base
// fills). Strategy-agnostic + microstructure-grounded: charge a base half-spread +
// an IMPACT term proportional to the short-term up-move INTO the entry. The next-bar
// open already captures realized drift; this adds the cost of crossing into momentum.
const SLIP_MODEL  = process.env.SIM_SLIP_MODEL || 'realistic';   // 'flat' | 'realistic'
const BASE_BPS    = 3;      // half-spread + base impact, liquid large-cap
const MOM_IMPACT  = 0.35;   // fraction of the trailing ~5-min up-move charged as impact
const MAX_MOM_BPS = 25;     // cap the momentum-impact component
const SELL_BPS    = 3;      // exit base (time/stop driven; no momentum-chase component)

// Adverse buy-side bps for the realistic model, from momentum INTO the decision bar.
function buySlipBps(feed, symbol, refBar) {
  if (SLIP_MODEL === 'flat') return SLIP_BPS;
  let momBps = 0;
  const bars = feed.intraday(symbol);
  if (bars && bars.length >= 6) {
    const c0 = bars[bars.length - 6].c;            // ≈5 minutes before the decision bar
    if (c0 > 0) momBps = Math.max(0, (refBar.c / c0 - 1) * 1e4) * MOM_IMPACT;
  }
  return BASE_BPS + Math.min(momBps, MAX_MOM_BPS);
}
const sellSlip = (px) => px * (1 - (SLIP_MODEL === 'flat' ? SLIP_BPS : SELL_BPS) / 1e4);

/**
 * Fill a market BUY decided at `refBar` (its close) using the symbol's NEXT bar.
 * Returns null if there is no next bar (end of session — decision is dropped).
 */
export function fillBuy(feed, symbol, dollars, refBar) {
  const nb = feed.nextBar(symbol);
  if (!nb || !(nb.o > 0)) return null;
  const bps    = buySlipBps(feed, symbol, refBar);
  const fillPx = nb.o * (1 + bps / 1e4);
  const qty = Math.floor(dollars / fillPx);
  if (qty < 1) return null;
  return {
    qty, fillPx, fillTs: nb.ts, fillT: nb.t,
    refPx: refBar.c,
    slippageBps: ((fillPx - refBar.c) / refBar.c) * 1e4,
  };
}

/**
 * Given an open position and the CURRENT bar, decide whether an exit triggers.
 * Order of checks within a bar: gap at open → intrabar stop → trail → time.
 * Returns {exitPx, reason} or null.
 *
 * pos: { entryPx, stopPx, trailPct, peak, entryT, timeStopT }
 */
export function checkExit(pos, bar, clockT) {
  // hard / trail stop — gap-aware
  const stop = pos.stopPx;
  if (stop != null) {
    if (bar.o <= stop) return { exitPx: sellSlip(bar.o), reason: 'stop_gap' };       // gapped through
    if (bar.l <= stop) {
      const reason = pos.trailing ? 'trail_stop' : 'hard_stop';
      // Min-hold floor (2026-07-07): veto ONLY the non-risk trail_stop while the
      // position is younger than minHoldT. hard_stop (risk) and stop_gap always fire.
      // Falls through to the time-stop check. Mirrors live executor shouldVetoExit().
      const vetoed = reason === 'trail_stop' && pos.minHoldT && clockT < pos.minHoldT;
      if (!vetoed) return { exitPx: sellSlip(stop), reason };
    }
  }
  // time stop — exit at this bar's close once we're past the horizon
  if (pos.timeStopT != null && clockT >= pos.timeStopT) {
    return { exitPx: sellSlip(bar.c), reason: 'time_stop' };
  }
  return null;
}

/** Update a trailing stop from the latest bar's high (call before checkExit next bar). */
export function updateTrail(pos, bar) {
  if (!pos.trailPct) return;
  if (bar.h > pos.peak) {
    pos.peak = bar.h;
    const newStop = pos.peak * (1 - pos.trailPct);
    if (newStop > pos.stopPx) { pos.stopPx = newStop; pos.trailing = true; }
  }
}

export { SLIP_BPS };
