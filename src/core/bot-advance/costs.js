/**
 * src/core/bot-advance/costs.js — platform trading-cost model (2026-06-19).
 *
 * The bot now accounts for round-trip platform charges so it (a) records NET P&L,
 * and (b) won't exit a position until profit has actually cleared its costs — which
 * also kills the 42-minute scalping the retrospective found (those +0.4% scalps lose
 * money once commission + fees + spread are counted).
 *
 * Round-trip cost as a fraction of notional, per broker (entry + exit):
 *   alpaca     — $0 stock commission; only tiny SEC/TAF reg fees → dominated by
 *                bid-ask + slippage on liquid large-caps ≈ 0.10% round trip.
 *   tiger_demo — commission ≈ $0.0099/share (min $0.99) + platform fee + slippage.
 *                On ~$1k positions of ~$100 names that min commission ≈ 0.20% round trip.
 * Configurable per bot via rules.costs.round_trip_pct.
 */
const DEFAULTS = { alpaca: 0.0010, alpaca_live: 0.0010, tiger_demo: 0.0020 };

export function roundTripCostPct(broker, bot) {
  const override = Number(bot?.rules?.costs?.round_trip_pct);
  if (Number.isFinite(override) && override >= 0) return override;
  return DEFAULTS[broker] ?? 0.0015;
}

/** Estimated round-trip $ cost for a position of `dollarsInvested` notional. */
export function estimateRoundTripCost(broker, dollarsInvested, bot) {
  const pct = roundTripCostPct(broker, bot);
  return +(Math.abs(Number(dollarsInvested) || 0) * pct).toFixed(2);
}
