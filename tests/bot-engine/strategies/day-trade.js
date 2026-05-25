/**
 * tests/bot-engine/strategies/day-trade.js
 *
 * Day-trade momentum: enter on intraday breakout signal, exit by close
 * regardless of P&L. No overnight holds.
 *
 * Hypothesis under test:
 *   "Buy or sell same day for profits. If overnight risk, exit before close."
 *
 * Entry rules (per CRDO-style setup):
 *   • Yesterday's last5dReturn >= +2% (stock already moving)
 *   • Yesterday closed within 10% of 52w high (momentum, not value)
 *   • Yesterday's relative volume vs 20d avg >= 1.3x (interest accelerating)
 *   • Skip if last 3 closes are all negative (no falling-knife catches)
 *
 * Exit rules (intraday):
 *   • Take profit at +TP_PCT (default 3%)         → eod ledger: 'take_profit'
 *   • Stop loss   at  -SL_PCT (default 2%)        → eod ledger: 'stop_loss'
 *   • Force close at today's close, no exceptions → eod ledger: 'eod_force_close'
 *
 * What this measures:
 *   • Does intraday momentum continue intraday enough to hit +3% before stops?
 *   • Does avoiding overnight risk improve or hurt Sharpe vs swing strategies?
 *   • What % of trades hit TP vs SL vs EOD-close?
 *
 * Backtest caveats:
 *   • Daily-bar simulation — we know whether the bar's high reached TP and
 *     whether the bar's low reached SL, but NOT which fired first if both
 *     are touched on the same day. Engine assumes TP fires first (optimistic).
 *     Most day-trades have small targets relative to daily ATR, so co-fire
 *     days are rare; conservatively this should overstate returns by 0.1-0.3%.
 *   • Slippage: 5 bps per trade applied (vs 2-3 bps real for liquid names).
 *   • No commissions modeled (Alpaca paper is free; Alpaca live is also free).
 *   • PDT rule not enforced — paper-only strategy.
 */

const TP_PCT          = 0.03;   // take profit at +3%
const SL_PCT          = 0.02;   // stop loss at -2%
const MIN_5D_RETURN   = 0.02;   // entry: 5-day return at least +2%
const MAX_PCT_OFF_52W = -0.10;  // entry: within 10% of 52w high
const MIN_REL_VOLUME  = 1.3;    // entry: yesterday's volume ≥ 1.3× 20d avg

export function makeDayTradeStrategy(opts = {}) {
  const tpPct        = opts.tpPct        ?? TP_PCT;
  const slPct        = opts.slPct        ?? SL_PCT;
  const min5dReturn  = opts.min5dReturn  ?? MIN_5D_RETURN;
  const maxOff52w    = opts.maxOff52w    ?? MAX_PCT_OFF_52W;
  const minRelVol    = opts.minRelVol    ?? MIN_REL_VOLUME;

  return async function dayTrade(ctx) {
    const { day, market, portfolio, universe } = ctx;
    const orders = [];

    // ── EXITS: day-trade positions auto-exit via engine (forceCloseEod) ──
    //   No exit orders emitted from strategy — engine handles TP/SL/EOD.
    //   Multi-day positions never exist in this strategy.

    // ── ENTRIES: rank candidates by 5-day momentum, take top N ──────────
    const cands = [];
    for (const symbol of universe) {
      if (portfolio.has(symbol)) continue;

      const pctOff = market.pctOff52w(symbol, day);
      const r5     = market.lastNdReturn(symbol, day, 5);
      if (pctOff == null || r5 == null) continue;

      // Entry gates
      if (r5 < min5dReturn)         continue;   // not enough momentum
      if (pctOff < maxOff52w)       continue;   // too far from 52w high
      // (note: pctOff is negative, so "< maxOff52w" means "more than 10% off")

      // Volume confirmation — needs at least the last bar
      const bar = market.getBar(symbol, day);
      if (!bar) continue;
      const avgVol20 = _avgVolume(market, symbol, day, 20);
      if (!avgVol20) continue;
      const relVol = Number(bar.volume) / avgVol20;
      if (relVol < minRelVol) continue;

      // Falling-knife guard: skip if last 3 closes are all red
      const last3Red = _last3AllNegative(market, symbol, day);
      if (last3Red) continue;

      cands.push({ symbol, r5, relVol, lastClose: bar.close });
    }

    // Rank by 5-day return, take top N (capped by portfolio slots)
    cands.sort((a, b) => b.r5 - a.r5);
    const slots = portfolio.availableSlots();
    for (let i = 0; i < cands.length && i < slots; i++) {
      const c = cands[i];
      // Use PERCENTAGE-based TP/SL — engine computes absolute prices against
      // the actual fill (which differs from yesterday's close when the
      // market gaps overnight). Previously hardcoded absolute prices
      // produced "take_profit" exits with negative P&L on gap-up opens.
      orders.push({
        action:        'enter_long',
        symbol:        c.symbol,
        stopPct:       slPct,
        takeProfitPct: tpPct,
        forceCloseEod: true,
      });
    }

    return orders;
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function _avgVolume(market, symbol, asOfDay, lookback) {
  let sum = 0, n = 0;
  for (let i = 1; i <= lookback; i++) {
    const bar = market.getBarNDaysBefore(symbol, asOfDay, i);
    if (bar?.volume) { sum += Number(bar.volume); n++; }
  }
  return n >= Math.floor(lookback * 0.7) ? sum / n : null;
}

function _last3AllNegative(market, symbol, asOfDay) {
  for (let i = 1; i <= 3; i++) {
    const prev = market.getBarNDaysBefore(symbol, asOfDay, i + 1);
    const cur  = market.getBarNDaysBefore(symbol, asOfDay, i);
    if (!prev || !cur) return false;     // missing data → don't block
    if (Number(cur.close) >= Number(prev.close)) return false;
  }
  return true;
}

export const dayTradeStrategy = makeDayTradeStrategy();
