/**
 * tests/bot-engine/strategies/b37-momentum-prod-aligned.js
 *
 * Validates the production change shipped 2026-05-23: momentum hard_sl_pct
 * widened from 3% to 6% in src/core/bot-executor.js line 40.
 *
 * This variant differs from b37-momentum-v2 in that it ONLY widens the
 * stop — it does NOT remove the b37_mom_broken exit rule. That mirrors
 * what was actually deployed (production never had the option to drop
 * that exit; my v2 dropped it as a backtest hypothesis).
 *
 * Settings:
 *   - Stop: -6% (matching production)
 *   - b37_mom_broken exit: KEPT (matching production's behavior of
 *     having multiple exit signals)
 *   - 7-day time stop: KEPT (production has same)
 *   - Entry rules: unchanged (pctOff52w >= -0.10, last5dReturn >= 0.02)
 *
 * Hypothesis: widening the stop alone should reduce stop-out losses
 * (78 trades × $-515 avg @ -5% became how much @ -6%?). If b37_mom_broken
 * is still the dominant loss source, the improvement will be modest.
 */

const ENTRY_PCT_OFF_52W = -0.10;
const ENTRY_5D_RETURN   = 0.02;
const EXIT_HOLD_DAYS    = 7;
const EXIT_MOMENTUM_BRK = -0.02;
const STOP_PCT          = -0.06;   // production-aligned

export function makeB37MomentumProdAlignedStrategy(opts = {}) {
  const entryPctOff52w = opts.entryPctOff52w ?? ENTRY_PCT_OFF_52W;
  const entry5dReturn  = opts.entry5dReturn  ?? ENTRY_5D_RETURN;
  const exitHoldDays   = opts.exitHoldDays   ?? EXIT_HOLD_DAYS;
  const exitMomBreak   = opts.exitMomBreak   ?? EXIT_MOMENTUM_BRK;
  const stopPct        = opts.stopPct        ?? STOP_PCT;

  return async function b37MomentumProdAligned(ctx) {
    const { day, market, portfolio, universe } = ctx;
    const orders = [];

    // ─── EXITS (both rules, matching production logic) ───────────────
    for (const [symbol, pos] of portfolio.positions) {
      const heldDays = (new Date(day) - new Date(pos.openedAt)) / 86_400_000;
      if (heldDays >= exitHoldDays) {
        orders.push({ action: 'exit_long', symbol, reason: 'b37_mom_prod_time_stop' });
        continue;
      }
      const r5 = market.lastNdReturn(symbol, day, 5);
      if (r5 != null && r5 < exitMomBreak) {
        orders.push({ action: 'exit_long', symbol, reason: 'b37_mom_prod_broken' });
      }
    }

    // ─── ENTRIES (unchanged) ─────────────────────────────────────────
    const cands = [];
    for (const symbol of universe) {
      if (portfolio.has(symbol)) continue;
      const pctOff = market.pctOff52w(symbol, day);
      const r5     = market.lastNdReturn(symbol, day, 5);
      if (pctOff == null || r5 == null) continue;
      if (pctOff >= entryPctOff52w && r5 >= entry5dReturn) {
        cands.push({ symbol, r5 });
      }
    }
    cands.sort((a, b) => b.r5 - a.r5);

    const slots = portfolio.availableSlots();
    for (let i = 0; i < cands.length && i < slots; i++) {
      const bar = market.getBar(cands[i].symbol, day);
      if (!bar) continue;
      const stopPrice = bar.close * (1 + stopPct);
      orders.push({ action: 'enter_long', symbol: cands[i].symbol, stopPrice });
    }

    return orders;
  };
}

export const b37MomentumProdAlignedStrategy = makeB37MomentumProdAlignedStrategy();
