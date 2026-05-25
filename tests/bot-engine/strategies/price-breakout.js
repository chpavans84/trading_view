/**
 * tests/bot-engine/strategies/price-breakout.js
 *
 * Pure price-action breakout strategy — NO UW data dependency.
 *
 * Why this test exists:
 *   The live bot's setup classifier requires bullish UW conviction for 3 of
 *   its 5 setup types. The UW conviction labeler returns 'no_data' or
 *   'neutral' for almost everything (even AAPL/NVDA), so 38% of bot scans
 *   die at `skip_unclassifiable_setup`. The hypothesis: a price-only
 *   strategy without UW gating could still catch the same trades that
 *   b37-momentum-v2 catches AND the ones it misses due to UW filtering.
 *
 * What this measures:
 *   • Does removing UW dependency PRESERVE the swing-momentum edge?
 *   • Does it CATCH additional trades (CRDO-style) that pure-price detects?
 *   • Win rate, return, and Sharpe vs. b37-momentum-v2 on the same window
 *
 * Entry rules (price-only, no UW):
 *   • last5dReturn >= ENTRY_5D_RETURN (default +5%) — strong momentum
 *   • pctOff52w >= MAX_PCT_OFF_52W (default within 10% of high)
 *   • NOT already in a 3-day-down streak (no falling knives)
 *
 * Exit rules (matches b37-momentum-v2 for fair comparison):
 *   • Hard stop at SL_PCT (default -8%)
 *   • Time stop at EXIT_HOLD_DAYS (default 7d)
 *
 * If this strategy holds up on the same backtest window where day-trade
 * failed (2024-05-23 → 2026-05-22) AND matches/beats b37-momentum-v2,
 * we have evidence to either:
 *   a) Add a new "price_breakout" setup type to the live classifier
 *   b) Disable the bot's `require_uw_label_any` rule (which uses the same
 *      broken signal)
 */

const ENTRY_5D_RETURN   = 0.05;   // need at least +5% over last 5 days
const MAX_PCT_OFF_52W   = -0.10;  // within 10% of 52-week high
const EXIT_HOLD_DAYS    = 7;      // matches b37-momentum-v2 time stop
const STOP_PCT          = -0.08;  // matches b37-momentum-v2 -8% hard stop

export function makePriceBreakoutStrategy(opts = {}) {
  const entry5dReturn = opts.entry5dReturn ?? ENTRY_5D_RETURN;
  const maxOff52w     = opts.maxOff52w     ?? MAX_PCT_OFF_52W;
  const exitHoldDays  = opts.exitHoldDays  ?? EXIT_HOLD_DAYS;
  const stopPct       = opts.stopPct       ?? STOP_PCT;

  return async function priceBreakout(ctx) {
    const { day, market, portfolio, universe } = ctx;
    const orders = [];

    // ── EXITS: time stop only (stop_loss handled by engine via stopPrice) ──
    for (const [symbol, pos] of portfolio.positions) {
      const heldDays = (new Date(day) - new Date(pos.openedAt)) / 86_400_000;
      if (heldDays >= exitHoldDays) {
        orders.push({ action: 'exit_long', symbol, reason: 'price_breakout_time_stop' });
      }
    }

    // ── ENTRIES: rank by 5-day return, take top N ──────────────────────────
    const cands = [];
    for (const symbol of universe) {
      if (portfolio.has(symbol)) continue;

      const pctOff = market.pctOff52w(symbol, day);
      const r5     = market.lastNdReturn(symbol, day, 5);
      if (pctOff == null || r5 == null) continue;

      // Entry gates
      if (r5 < entry5dReturn)   continue;   // need strong 5-day momentum
      if (pctOff < maxOff52w)   continue;   // too far from 52w high

      // Falling-knife guard: last 3 closes must NOT all be red
      const last3Red = _last3AllNegative(market, symbol, day);
      if (last3Red) continue;

      cands.push({ symbol, r5 });
    }

    cands.sort((a, b) => b.r5 - a.r5);
    const slots = portfolio.availableSlots();
    for (let i = 0; i < cands.length && i < slots; i++) {
      orders.push({
        action:  'enter_long',
        symbol:  cands[i].symbol,
        stopPct: -stopPct,           // engine converts to absolute price vs. fill
      });
    }

    return orders;
  };
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

export const priceBreakoutStrategy = makePriceBreakoutStrategy();
