/**
 * src/core/bot-gates.js
 *
 * Pure-function library of bot entry gates. NO I/O. NO database. NO HTTP.
 * Just `data → { pass, blocker }`. Importable from both:
 *
 *   - _scoreCandidate (bot-engine.js)  — uses pass/fail to early-bail
 *   - diagnoseCandidate (bot-engine.js) — uses blocker[] for the "why blocked" UI
 *
 * This module exists to eliminate the duplicated gate logic that previously
 * lived in both functions, and to make the trade-decision path unit-testable
 * (data in → data out, no mocks required).
 *
 * Adding a new gate?
 *   1. Add the check function below
 *   2. Append it to GATES so both bot-engine functions pick it up automatically
 *   3. Add a test in tests/bot-engine/bot-gates.test.js
 *
 * Grade order: A=4 > B=3 > C=2 > F=1   (D is treated as 0 = block)
 * News sentiment order: positive=2 > neutral=1 > negative=0
 *
 * Each gate function signature:
 *   gateXxx(ctx) → null  (pass)   |   { gate, value, threshold, message }  (block)
 *
 * `ctx` shape:
 *   {
 *     filters:    bot.rules.entry_filters,
 *     indicators: from getAllBotIndicators(),
 *     vix:        number | null,
 *     signals:    { conviction, news, uw_options, gex, insider, distance_52w, predictor },
 *     setup:      result of classifySetup() | null,
 *     enforceSetup: boolean,
 *   }
 */

const GRADE_ORDER = { A: 4, B: 3, C: 2, F: 1 };
const SENTIMENT_ORDER = { negative: 0, neutral: 1, positive: 2 };

// ─── Individual gate checks ─────────────────────────────────────────────────

export function gateEarningsProximity({ filters, indicators }) {
  const limit = filters.avoid_earnings_within_days;
  const days  = indicators?.earnings?.days_until;
  if (limit == null || days == null || days < 0) return null;
  if (days < limit) {
    return {
      gate: 'earnings_proximity',
      value: `${days}d`,
      threshold: `>= ${limit}d`,
      message: `Earnings in ${days} days — bot avoids within ${limit}d (binary event risk)`,
    };
  }
  return null;
}

export function gateLiquidity({ filters, indicators }) {
  const min = filters.min_adv_dollar_vol;
  const adv = indicators?.liquidity?.adv_dollar_vol_30d;
  if (min == null || adv == null) return null;
  if (adv < min) {
    return {
      gate: 'liquidity',
      value: `$${(adv / 1e6).toFixed(1)}M`,
      threshold: `>= $${(min / 1e6).toFixed(1)}M`,
      message: `30-day avg $ vol $${(adv / 1e6).toFixed(1)}M under required $${(min / 1e6).toFixed(1)}M (illiquid)`,
    };
  }
  return null;
}

export function gateMacroBlackout({ filters, indicators }) {
  if (!filters.skip_during_macro_blackout) return null;
  if (!indicators?.macro?.in_blackout) return null;
  return {
    gate: 'macro_blackout',
    value: indicators.macro.blackout_reason || 'active',
    threshold: 'no blackout',
    message: `Today is a macro-event blackout (${indicators.macro.blackout_reason || 'Fed / CPI / etc'})`,
  };
}

/**
 * UNITS CHECK (2026-05-25 audit):
 *   indicators.premarket.gap_pct is stored as PERCENT (e.g. 8.0 = 8% gap)
 *   per src/core/bot-indicators.js: `gap = ((pre - prev) / prev) * 100`
 *   So filters.avoid_premarket_gap_above_pct is also PERCENT (8 = 8%, NOT 0.08).
 *   Defaults: 8 (block on > 8% gaps). Set 12-15 for breakout-friendly bots.
 */
export function gatePremarketGap({ filters, indicators }) {
  const limit = filters.avoid_premarket_gap_above_pct;
  const gap   = indicators?.premarket?.gap_pct;
  if (limit == null || gap == null) return null;
  if (Math.abs(gap) <= limit) return null;
  return {
    gate: 'premarket_gap',
    value: `${gap.toFixed(1)}%`,
    threshold: `±${limit.toFixed(0)}%`,
    message: `Premarket gap ${gap.toFixed(1)}% exceeds ±${limit.toFixed(0)}% (risk profile shifted overnight)`,
  };
}

export function gateShortInterest({ filters, indicators }) {
  if (!filters.skip_high_short_interest) return null;
  const sp = indicators?.short_interest?.short_pct_float;
  if (sp == null || sp <= 0.30) return null;
  return {
    gate: 'short_interest',
    value: `${(sp * 100).toFixed(1)}%`,
    threshold: '< 30%',
    message: `Short interest ${(sp * 100).toFixed(1)}% of float — squeeze risk`,
  };
}

export function gatePriceRange({ filters, indicators }) {
  const price = indicators?.liquidity?.last_price;
  if (price == null) return null;
  if (filters.price_min != null && price < filters.price_min) {
    return {
      gate: 'price_min',
      value: `$${price.toFixed(2)}`,
      threshold: `>= $${filters.price_min}`,
      message: `Price $${price.toFixed(2)} below min $${filters.price_min}`,
    };
  }
  if (filters.price_max != null && price > filters.price_max) {
    return {
      gate: 'price_max',
      value: `$${price.toFixed(2)}`,
      threshold: `<= $${filters.price_max}`,
      message: `Price $${price.toFixed(2)} above max $${filters.price_max}`,
    };
  }
  return null;
}

export function gateVixRange({ filters, vix }) {
  if (vix == null) return null;
  if (filters.vix_min != null && vix < filters.vix_min) {
    return {
      gate: 'vix_low',
      value: vix.toFixed(1),
      threshold: `>= ${filters.vix_min}`,
      message: `VIX ${vix.toFixed(1)} below ${filters.vix_min} (regime too calm for this strategy)`,
    };
  }
  if (filters.vix_max != null && vix > filters.vix_max) {
    return {
      gate: 'vix_high',
      value: vix.toFixed(1),
      threshold: `<= ${filters.vix_max}`,
      message: `VIX ${vix.toFixed(1)} above ${filters.vix_max} (regime too volatile)`,
    };
  }
  return null;
}

export function gateConvictionGrade({ filters, signals }) {
  const min = filters.conviction_grade_min;
  const grade = signals?.conviction?.grade;
  if (!min || !grade) return null;
  if ((GRADE_ORDER[grade] ?? 0) >= (GRADE_ORDER[min] ?? 0)) return null;
  return {
    gate: 'conviction_grade',
    value: grade,
    threshold: `>= ${min}`,
    message: `Conviction grade ${grade} below required minimum ${min}`,
  };
}

export function gateUwLabel({ filters, signals }) {
  const allowed = filters.require_uw_label_any;
  if (!Array.isArray(allowed) || allowed.length === 0) return null;
  const got = signals?.uw_options?.label;
  if (allowed.includes(got)) return null;
  return {
    gate: 'uw_label',
    value: got || 'none',
    threshold: allowed.join(' or '),
    message: `UW flow label "${got || 'none'}" not in required [${allowed.join(', ')}] — smart money not aligned`,
  };
}

export function gateNewsSentiment({ filters, signals }) {
  const min = filters.require_news_sentiment_min;
  if (!min) return null;
  const reqRank = SENTIMENT_ORDER[min];
  const gotRank = SENTIMENT_ORDER[signals?.news?.label];
  if (gotRank != null && gotRank >= reqRank) return null;
  return {
    gate: 'news_sentiment',
    value: signals?.news?.label || 'none',
    threshold: `>= ${min}`,
    message: `News sentiment "${signals?.news?.label || 'none'}" below required "${min}"`,
  };
}

export function gateSetupClassification({ enforceSetup, setup }) {
  if (!enforceSetup) return null;
  if (setup?.setup_type) return null;
  return {
    gate: 'setup_classification',
    value: 'unclassified',
    threshold: 'one of: catalyst/breakout/momentum/value_contrarian/mean_reversion',
    message: 'Could not classify into any of the 5 setup types — no clear thesis for the trade',
  };
}

export function gateStrategyFilter({ filters, setup }) {
  const desired = filters.strategy ?? 'composite';
  if (desired === 'composite') return null;
  if (!setup?.setup_type) return null;  // not classifiable → already handled by gateSetupClassification
  if (setup.setup_type === desired) return null;
  return {
    gate: 'strategy_filter',
    value: setup.setup_type,
    threshold: desired,
    message: `Setup type "${setup.setup_type}" doesn't match bot strategy "${desired}" — bot is focused on ${desired} setups only`,
  };
}

// Composite score is a special case — it's computed from the weights, so we
// can't fully evaluate it here without doing the weighted-sum math. The caller
// computes it then asks us to validate. Keeping the API symmetric.
export function gateCompositeScore({ filters, composite }) {
  const min = filters.min_composite_score ?? 60;
  if (composite == null || composite >= min) return null;
  return {
    gate: 'composite_score',
    value: composite.toFixed(1),
    threshold: `>= ${min}`,
    message: `Composite ${composite.toFixed(1)} below threshold ${min} (signals don't align strongly enough)`,
  };
}

// ─── Orchestrators ──────────────────────────────────────────────────────────

/**
 * Pre-signal gates — the ones that can be checked BEFORE running expensive
 * signal queries. _scoreCandidate uses these to bail early.
 */
export const PRE_SIGNAL_GATES = [
  gateEarningsProximity,
  gateLiquidity,
  gateMacroBlackout,
  gatePremarketGap,
  gateShortInterest,
  gatePriceRange,
  gateVixRange,
];

/**
 * Post-signal gates — need conviction/UW/news signals to be already computed.
 */
export const POST_SIGNAL_GATES = [
  gateConvictionGrade,
  gateUwLabel,
  gateNewsSentiment,
];

/**
 * Setup gates — need classifySetup() output.
 */
export const SETUP_GATES = [
  gateSetupClassification,
  gateStrategyFilter,
];

/**
 * Run a list of gates and return the FIRST blocker, or null if all pass.
 * Used by _scoreCandidate to early-exit on hard fails.
 */
export function firstBlocker(ctx, gateList) {
  for (const gate of gateList) {
    const result = gate(ctx);
    if (result) return result;
  }
  return null;
}

/**
 * Run a list of gates and return ALL blockers (no early-exit).
 * Used by diagnoseCandidate for the "why blocked" UI.
 */
export function allBlockers(ctx, gateList) {
  const blockers = [];
  for (const gate of gateList) {
    const result = gate(ctx);
    if (result) blockers.push(result);
  }
  return blockers;
}
