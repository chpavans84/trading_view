/**
 * src/core/bot-advance/regime-gate.js — market regime loss-avoidance gate.
 *
 * Promoted from BOT_SIM (2026-06-14) after the multi-regime replay PROVED its
 * value: not trading while SPY is below its 200-day MA turned the COVID crash
 * from −12.2% to −4.7% and the 2022 bear from −6.9% to 0% (no-gate vs gated).
 * It is the single thing the live bot lacked.
 *
 * The gate ONLY BLOCKS new entries — it can never add risk or place a trade.
 * Boundary (validated): SPY < 200-day SMA = risk-off (regimes R3/R4) → block.
 * Above the 200-day (R1/R2) → allow, unchanged behavior.
 *
 * Per-bot opt-out: rules.risk.regime_gate_enabled === false disables it.
 * Cached per SPY session (one cheap query/day).
 */
import { query } from '../db.js';

let _cache = null;   // { asOf, regime, riskOff, spyClose, sma200, rvol20 }

export async function getMarketRegime() {
  const { rows } = await query(`
    WITH base AS (
      SELECT price_date, close, ln(close / LAG(close) OVER (ORDER BY price_date)) AS lr
        FROM backtest_prices WHERE symbol = 'SPY'
    ), spy AS (
      SELECT price_date, close,
        AVG(close) OVER (ORDER BY price_date ROWS BETWEEN 199 PRECEDING AND CURRENT ROW) AS sma200,
        STDDEV(lr) OVER (ORDER BY price_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) * sqrt(252) AS rvol20
      FROM base
    )
    SELECT price_date, close, sma200, rvol20 FROM spy
    WHERE sma200 IS NOT NULL ORDER BY price_date DESC LIMIT 1
  `);
  if (!rows.length) return null;
  const r = rows[0];
  const asOf = String(r.price_date);
  if (_cache && _cache.asOf === asOf) return _cache;

  const close = Number(r.close), sma200 = Number(r.sma200), rvol20 = Number(r.rvol20);
  const aboveMa = close >= sma200;
  const regime = aboveMa
    ? (rvol20 < 0.20 ? 'R1_up_calm' : 'R2_up_vol')
    : (rvol20 < 0.25 ? 'R3_down_calm' : 'R4_down_vol');
  _cache = { asOf, regime, riskOff: !aboveMa, spyClose: close, sma200, rvol20 };
  return _cache;
}

/**
 * Returns { blocked, regime, detail } for a bot. blocked=true means skip entries.
 * Fails OPEN (never blocks) if SPY data is missing — we don't want a data gap to
 * silently freeze the bot; the existing gates still apply.
 */
export async function checkRegimeGate(bot) {
  if (bot?.rules?.risk?.regime_gate_enabled === false) {
    return { blocked: false, regime: null, detail: 'gate disabled for this bot' };
  }
  let m;
  try { m = await getMarketRegime(); } catch (e) { return { blocked: false, regime: null, detail: `regime calc failed: ${e.message}` }; }
  if (!m) return { blocked: false, regime: null, detail: 'no SPY data — failing open' };
  return {
    blocked: m.riskOff,
    regime: m.regime,
    detail: `SPY ${m.spyClose.toFixed(2)} vs 200d ${m.sma200.toFixed(2)} (rvol ${m.rvol20.toFixed(2)}) → ${m.regime}`,
  };
}
