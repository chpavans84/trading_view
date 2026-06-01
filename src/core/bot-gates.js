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

/**
 * Bug fix 2026-05-28: TTMI entered at $208 but liquidity cache showed $189 (last_date 5 days stale).
 * Gate price checks (price_min/price_max) use the cached last_price, which is dangerously wrong when
 * the cache is stale. Block when the cache is more than 3 TRADING days stale.
 *
 * 2026-05-28 (review fix): count trading days, not calendar days. Calendar-day count fails on
 * Thanksgiving (Thu+Fri half-day → 4–5 cal days) and Christmas+NY straddles (4 cal days).
 * Trading-day count handles all US-market holidays correctly without needing a holiday list:
 * just count weekdays in the gap. (A 3-day weekend = 1 trading-day-old, still fresh.)
 *
 * Threshold = 3 trading days:
 *   - 1 trading day = data from yesterday's close → pass (normal case)
 *   - 2 trading days = data from 2 sessions ago → pass (worst-case after a holiday)
 *   - 3+ trading days = stale → block (TTMI case: 5 cal days = 3 trading days → blocked ✓)
 */
function _tradingDaysBetween(from, to) {
  // Exclusive of `from`, inclusive of `to`. Counts only Mon-Fri.
  // Does not consult a holiday calendar — overcounts by at most 2-3 days/year, which is acceptable
  // because the gate's tolerance is already 3 days. Wrong direction (false negatives) is safer.
  let days = 0;
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return days;
}

export function gateLiquidityStale({ indicators }) {
  const lastDate = indicators?.liquidity?.last_date;
  if (!lastDate) return null;
  const last = new Date(lastDate);
  if (Number.isNaN(last.getTime())) return null;
  const now = new Date();
  const tradingDays = _tradingDaysBetween(last, now);
  if (tradingDays <= 2) return null;
  const cachedPrice = indicators?.liquidity?.last_price;
  const priceTag = cachedPrice != null ? ` cached_price=$${Number(cachedPrice).toFixed(2)}` : '';
  return {
    gate: 'liquidity_stale',
    value: `last_date=${lastDate} (${tradingDays} trading days ago)${priceTag}`,
    threshold: '<= 2 trading days',
    message: `Price data is ${tradingDays} trading days stale${priceTag} — risk checks (stop-loss, price gates) unreliable`,
  };
}

/**
 * Bug fix 2026-05-28: AMD entered at 19:56 UTC (3:56 PM ET), stopped out 19:59 (3:59 PM ET),
 * 1 min before close. No session-cutoff gate existed. Block new entries after 3:30 PM ET
 * to avoid end-of-day volatility and forced close-at-market-price fills.
 * Only applies when filters.block_late_session !== false (opt-out per-bot if needed).
 *
 * 2026-05-28 (review fix): use ET wall-clock (via toLocaleString) not UTC arithmetic.
 * Original code hard-coded 19:30 UTC = 3:30 PM EDT, which is WRONG during EST (Nov-Mar) when
 * 3:30 PM ET = 20:30 UTC. The DST-naive version blocked entries 90 min early every winter.
 * Also early-out on weekends so non-trading-day cron ticks don't pollute gate-rejection telemetry.
 */
export function gateMarketCloseProximity({ filters }) {
  if (filters.block_late_session === false) return null;
  // Convert current time → America/New_York wall clock (handles DST correctly).
  // toLocaleString('en-US', { timeZone }) returns a parseable date string in the target tz.
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  // Early-out: US equities are closed Sat/Sun, no point firing this gate (would pollute telemetry).
  if (day === 0 || day === 6) return null;
  const minsET = et.getHours() * 60 + et.getMinutes();
  const closeET  = 16 * 60;        // 4:00 PM ET
  const cutoffET = 15 * 60 + 30;   // 3:30 PM ET
  // Only block during the cutoff..close window. Pre-market and after-close also skip;
  // we don't want to block at 8 PM ET (post-close) just because clock < close.
  if (minsET < cutoffET || minsET >= closeET) return null;
  const minsUntilClose = closeET - minsET;
  return {
    gate: 'market_close_proximity',
    value: `${minsUntilClose}min until close`,
    threshold: '>= 30 min remaining',
    message: `Only ${minsUntilClose} min until market close — new entries blocked after 3:30 PM ET`,
  };
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
  const min = filters.min_composite_score ?? 70;   // raised 2026-05-27 from 60 — backtest 90d shows score 70+ has 10% avg 10d return, ~70% win rate
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
/**
 * Retrospective 2026-05-29 — HUT loss post-mortem.
 *
 * HUT was bought at $141.26 while the cached last_price was $117.75 (+20% divergence).
 * TTMI was bought at $208.18 while cached was $189.92 (+9.6%).
 * AMD was bought at $510.20 while cached was $467.51 (+9.2%).
 *
 * In every case the bot entered mid-spike — the live quote had moved significantly
 * above the cached price, meaning the stock had ALREADY made a large move and was
 * at elevated risk of reversal. No gate was checking this divergence.
 *
 * This gate compares the live ask/quote price (available in indicators.liquidity) to
 * the cached last_price. If the live price is > max_gap_from_cache_pct above the
 * cached price, the entry is blocked as a spike-entry risk.
 *
 * Default: 8%. Opt-out per-bot: filters.max_gap_from_cache_pct = null (disable).
 * Opt-in tighter: filters.max_gap_from_cache_pct = 5 for conservative bots.
 *
 * Uses last_price (cache) vs the live quote already in indicators.liquidity.last_price.
 * The ACTUAL fill price is compared at execution time in bot-executor.js — this gate
 * fires before the order is placed, using the quote the scanner fetched.
 *
 * Note: this gate does NOT apply when last_price is null (new listing) or when
 * the symbol has no cache entry. It also does NOT block downward gaps (price below
 * cache) since those are handled by the existing liquidity_stale gate.
 */
export function gatePriceGapFromCache({ filters, indicators }) {
  const maxGapPct = filters.max_gap_from_cache_pct !== undefined
    ? filters.max_gap_from_cache_pct
    : 8;  // default 8%
  if (maxGapPct == null) return null;  // explicitly disabled

  const cachedPrice = indicators?.liquidity?.last_price;
  const lastDate    = indicators?.liquidity?.last_date;
  if (!cachedPrice || cachedPrice <= 0 || !lastDate) return null;

  // ── Path A: pre-market gap (4:00–9:29 AM ET) ──────────────────────────────
  // Yahoo Finance preMarketPrice is only non-null before market open.
  // FIXED 2026-06-01: only block UPWARD gaps (chasing risk). Downward gaps may
  // actually be entry opportunities for mean-reversion — using Math.abs() here
  // was rejecting both directions, which over-filtered candidates.
  const premktGap = indicators?.premarket?.gap_pct;
  if (premktGap != null && premktGap > maxGapPct) {
    return {
      gate: 'price_gap_from_cache',
      value: `premarket_gap=+${premktGap.toFixed(1)}%`,
      threshold: `<= +${maxGapPct}%`,
      message: `Pre-market gap UP +${premktGap.toFixed(1)}% exceeds ${maxGapPct}% — chasing risk`,
    };
  }

  // ── Path B: intraday gap (9:30–16:00 ET) ───────────────────────────────────
  // During regular trading hours Yahoo's regularMarketPrice is the live last-
  // trade price (now in indicators.premarket.live_price via getPreMarketGap).
  // Compare it to the cached last_price from backtest_prices.  If the stock has
  // already surged intraday, the bot would be chasing — block it.
  //
  // Only fires if live_price is clearly ABOVE the cache (upward spike only).
  // A drop from cache (negative gap) is not blocked here; it's handled by the
  // gateLiquidityStale gate which checks staleness regardless of direction.
  // cachedPrice already declared above — reuse it here.
  const livePrice = indicators?.premarket?.live_price;
  if (livePrice != null && cachedPrice != null && cachedPrice > 0) {
    const intradayGap = ((livePrice - cachedPrice) / cachedPrice) * 100;
    if (intradayGap > maxGapPct) {
      return {
        gate: 'price_gap_from_cache',
        value: `live=$${livePrice} cache=$${cachedPrice} gap=+${intradayGap.toFixed(1)}%`,
        threshold: `<= +${maxGapPct}%`,
        message: `Live price $${livePrice} is ${intradayGap.toFixed(1)}% above cached $${cachedPrice} — spike-entry risk (stock already moved)`,
      };
    }
  }

  return null;
}

/**
 * Retrospective 2026-05-29 — HUT loss post-mortem.
 *
 * HUT daily ATR was 8–10% of price. With a 1-minute monitoring loop, any stock
 * that moves more than the stop% in a single minute will gap THROUGH the stop —
 * the bot sees above-stop at tick N and below-stop+exit-price at tick N+1 with no
 * fill at the stop level. Crypto miners (HUT, IREN, MARA), leveraged ETFs (TQQQ),
 * and meme stocks regularly move 5–15% intraday on single news items.
 *
 * These stocks are untradeable at the 1-min monitoring frequency with any reasonable
 * stop percentage. The fix is to simply refuse entry.
 *
 * Implementation: uses ATR(14) from backtest_prices (via trade.atr_pct in trades,
 * but here we receive it in indicators.atr if pre-computed, or skip if unavailable).
 * For the scanner path, we inject `indicators.atr_pct` from the pre-scan ATR fetch.
 *
 * Default threshold: 7%.  Configurable per bot: filters.max_atr_pct.
 *
 * Opt-out: filters.max_atr_pct = null → disables the gate (for high-vol strategies).
 */
export function gateHighVolatility({ filters, indicators }) {
  const maxAtrPct = filters.max_atr_pct !== undefined
    ? filters.max_atr_pct
    : 7;  // default 7% — blocks crypto miners, meme stocks, leveraged ETFs
  if (maxAtrPct == null) return null;  // explicitly disabled

  const atrPct = indicators?.atr_pct;
  if (atrPct == null) return null;  // no ATR data — skip gate

  if (atrPct > maxAtrPct) {
    return {
      gate: 'high_volatility',
      value: `atr_pct=${atrPct.toFixed(2)}%`,
      threshold: `<= ${maxAtrPct}%`,
      message: `ATR ${atrPct.toFixed(2)}% exceeds ${maxAtrPct}% — stop-hunting risk with 1-min monitoring loop`,
    };
  }

  return null;
}

export const PRE_SIGNAL_GATES = [
  gateEarningsProximity,
  gateLiquidity,
  gateLiquidityStale,         // 2026-05-28: block on stale price data (> 2 trading days)
  gatePriceGapFromCache,      // 2026-05-29: block when live quote > cached price × 1.08 (spike-entry prevention)
  gateHighVolatility,         // 2026-05-29: block when ATR% > 7% (crypto miners, meme stocks)
  gateMacroBlackout,
  gatePremarketGap,
  gateShortInterest,
  gatePriceRange,
  gateVixRange,
  gateMarketCloseProximity,   // 2026-05-28: block entries after 3:30 PM ET
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
 * Retrospective 2026-05-29 — RSI overbought block for price_breakout entries.
 *
 * HUT was classified as `price_breakout` and had RSI 77.73 at entry.
 * A stock at RSI 77 has typically already made 70-80% of its near-term move —
 * the momentum edge is in the 40-65 RSI range (early breakout) not the 75+
 * range (exhaustion / climax). This gate exists to prevent chasing.
 *
 * TTMI had RSI 69.4 and was allowed by the momentum_flip RSI < 68 guard
 * (it was blocked at 69.4, just above the cap).  For price_breakout, we are
 * even stricter: RSI > 75 = block.  Momentum can run to 80+ in strong trends,
 * so that ceiling is set higher.
 *
 * Per-setup ceilings (default):
 *   price_breakout: 75  — chasing risk is highest for breakout entries
 *   momentum:       80  — strong trends can sustain higher RSI for longer
 *   (all other setup types: no cap — catalyst / news / value setups don't
 *   have an RSI-exhaustion thesis)
 *
 * Opt-out per-bot: filters.max_rsi_overbought = null (disables the gate entirely).
 * Custom ceilings: filters.max_rsi_by_setup = { price_breakout: 70, momentum: 85 }
 */
const DEFAULT_MAX_RSI_BY_SETUP = {
  price_breakout: 75,
  momentum:       80,
};

export function gateOverboughtEntry({ filters, setup, rsi14 }) {
  if (filters.max_rsi_overbought === null) return null;   // gate disabled for this bot
  if (!setup?.setup_type || rsi14 == null) return null;   // no setup or no RSI data

  const maxRsiBySetup = filters.max_rsi_by_setup ?? DEFAULT_MAX_RSI_BY_SETUP;
  const ceiling = maxRsiBySetup[setup.setup_type];
  if (ceiling == null) return null;  // this setup type has no RSI ceiling

  if (rsi14 > ceiling) {
    return {
      gate: 'overbought_entry',
      value: `rsi14=${rsi14.toFixed(1)} setup=${setup.setup_type}`,
      threshold: `<= ${ceiling}`,
      message: `RSI ${rsi14.toFixed(1)} exceeds ${setup.setup_type} ceiling ${ceiling} — entry likely chasing exhausted move`,
    };
  }
  return null;
}

export const SETUP_GATES = [
  gateSetupClassification,
  gateStrategyFilter,
  gateOverboughtEntry,        // 2026-05-29: block RSI>75 for price_breakout, RSI>80 for momentum
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
