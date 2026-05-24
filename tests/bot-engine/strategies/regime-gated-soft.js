/**
 * tests/bot-engine/strategies/regime-gated-soft.js
 *
 * Soft variant of regime-gated SMA cross based on failure analysis:
 *
 * v1 finding: regime_exit_bear (flatten all on bear) was actually a
 *   +$16,351 winner — it correctly saved positions in 12 of 19 cases.
 *   The strategy still underperformed because the gate ALSO blocked
 *   good entries during sideways/bear regimes that would have been
 *   profitable when the regime turned.
 *
 * v2 fix: block new entries when SPY is not in bull regime, but
 *   DON'T flatten existing positions. Let each position's own SMA
 *   cross signal manage its exit. This:
 *   - Keeps the saving behavior on truly bear regimes (positions hit
 *     their own death-cross exits naturally)
 *   - Stops the over-aggressive flatten that's too sensitive to
 *     short-lived hysteresis-band regime flips
 */

const HYSTERESIS = 0.0005;
const REGIME_SYM = 'SPY';

function ratio(a, b) { return (a - b) / b; }

export function makeRegimeGatedSoftStrategy(opts = {}) {
  const fast      = opts.fast      ?? 50;
  const slow      = opts.slow      ?? 200;
  const regimeSym = opts.regimeSym ?? REGIME_SYM;

  return async function regimeGatedSoft(ctx) {
    const { day, market, portfolio, universe } = ctx;
    const orders = [];

    // Compute market regime
    const mktFast = market.sma(regimeSym, day, fast);
    const mktSlow = market.sma(regimeSym, day, slow);
    let inBull = false;
    if (mktFast != null && mktSlow != null) {
      const r = ratio(mktFast, mktSlow);
      if (Math.abs(r) >= HYSTERESIS) inBull = r > 0;
    }

    for (const symbol of universe) {
      const f = market.sma(symbol, day, fast);
      const s = market.sma(symbol, day, slow);
      if (f == null || s == null) continue;
      const r = ratio(f, s);
      const signal = Math.abs(r) < HYSTERESIS ? 0 : (r > 0 ? 1 : -1);
      const has = portfolio.has(symbol);

      // Exit unchanged from ungated SMA cross (death cross fires regardless of regime)
      if (signal === -1 && has) {
        orders.push({ action: 'exit_long', symbol, reason: 'sma_cross_down' });
        continue;
      }

      // Entry only allowed when SPY is in bull regime (this is the only gate)
      if (signal === 1 && !has && inBull && portfolio.availableSlots() > 0) {
        orders.push({ action: 'enter_long', symbol });
      }
    }

    return orders;
  };
}

export const regimeGatedSoftStrategy = makeRegimeGatedSoftStrategy();
