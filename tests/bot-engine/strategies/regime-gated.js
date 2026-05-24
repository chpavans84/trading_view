/**
 * tests/bot-engine/strategies/regime-gated.js
 *
 * SMA 50/200 cross on individual names, gated by a market-regime filter on SPY.
 *
 * Faithful proxy for the regime-bot's production Markov gate. The production
 * gate spawns a Python subprocess per (ticker, day) which cannot scale to
 * backtest. Empirically the regime-bot's 3-state chain (Bull/Sideways/Bear)
 * on SPY-like returns reduces to the binary "is SPY in uptrend" question
 * for the entry decision — and that question is well-captured by SPY's own
 * 50/200 cross.
 *
 * Reference: Faber "A Quantitative Approach to Tactical Asset Allocation"
 * (2007) shows that a single 200-day filter on SPY as a regime detector cuts
 * drawdowns ~50% in bear regimes with modest CAGR cost. The regime-bot is
 * trying to do this more elegantly with Markov; the proxy lower-bounds the
 * theoretical advantage.
 *
 * Entry: SPY in bull regime (SPY's SMA50 > SMA200) AND individual ticker's
 *        SMA50 > SMA200
 * Exit:  individual ticker's SMA50 ≤ SMA200 (death cross — same as ungated)
 *        OR SPY exits bull regime (flatten everything — "regime change" exit)
 */

const HYSTERESIS  = 0.0005;
const REGIME_SYM  = 'SPY';

function ratio(a, b) { return (a - b) / b; }

export function makeRegimeGatedStrategy(opts = {}) {
  const fast       = opts.fast       ?? 50;
  const slow       = opts.slow       ?? 200;
  const regimeSym  = opts.regimeSym  ?? REGIME_SYM;
  const flattenOnRegimeChange = opts.flattenOnRegimeChange ?? true;

  return async function regimeGated(ctx) {
    const { day, market, portfolio, universe } = ctx;
    const orders = [];

    // ─── Compute market regime (SPY 50/200) ──────────────────────────
    const mktFast = market.sma(regimeSym, day, fast);
    const mktSlow = market.sma(regimeSym, day, slow);
    let inBull = false;
    if (mktFast != null && mktSlow != null) {
      const r = ratio(mktFast, mktSlow);
      // Apply same hysteresis as individual signal — within the band we
      // hold the previous regime decision. We don't have stateful history
      // here, so default to "not bull" inside hysteresis (conservative).
      if (Math.abs(r) >= HYSTERESIS) inBull = r > 0;
    }

    // ─── Regime change exit: flatten everything if SPY drops out of bull
    if (!inBull && flattenOnRegimeChange) {
      for (const symbol of portfolio.positions.keys()) {
        orders.push({ action: 'exit_long', symbol, reason: 'regime_exit_bear' });
      }
      return orders;   // no entries allowed in bear/sideways regime
    }

    // ─── Individual SMA cross logic (same as ungated SMA strategy) ───
    for (const symbol of universe) {
      const f = market.sma(symbol, day, fast);
      const s = market.sma(symbol, day, slow);
      if (f == null || s == null) continue;
      const r = ratio(f, s);
      const signal = Math.abs(r) < HYSTERESIS ? 0 : (r > 0 ? 1 : -1);
      const has = portfolio.has(symbol);

      if (signal === 1 && !has && portfolio.availableSlots() > 0) {
        orders.push({ action: 'enter_long', symbol });
      } else if (signal === -1 && has) {
        orders.push({ action: 'exit_long', symbol, reason: 'sma_cross_down' });
      }
    }

    return orders;
  };
}

export const regimeGatedStrategy = makeRegimeGatedStrategy();
