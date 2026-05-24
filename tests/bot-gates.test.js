/**
 * tests/bot-gates.test.js
 *
 * Unit tests for src/core/bot-gates.js — the pure-function bot entry-gate library.
 * No DB, no HTTP, no mocks needed: pure data in → data out.
 *
 * Run: node --test tests/bot-gates.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  gateEarningsProximity,
  gateLiquidity,
  gateMacroBlackout,
  gatePremarketGap,
  gateShortInterest,
  gatePriceRange,
  gateVixRange,
  gateConvictionGrade,
  gateUwLabel,
  gateNewsSentiment,
  gateSetupClassification,
  gateStrategyFilter,
  gateCompositeScore,
  PRE_SIGNAL_GATES,
  POST_SIGNAL_GATES,
  SETUP_GATES,
  firstBlocker,
  allBlockers,
} from '../src/core/bot-gates.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────
function ctx(overrides = {}) {
  return {
    filters: {
      avoid_earnings_within_days: 3,
      min_adv_dollar_vol: 5_000_000,
      skip_during_macro_blackout: true,
      avoid_premarket_gap_above_pct: 0.08,
      skip_high_short_interest: false,
      price_min: 5,
      price_max: 500,
      vix_min: 15,
      vix_max: 60,
      conviction_grade_min: 'C',
      require_uw_label_any: ['bullish', 'strong_bullish'],
      require_news_sentiment_min: null,
      min_composite_score: 60,
      strategy: 'composite',
      ...overrides.filters,
    },
    indicators: {
      earnings: { days_until: 10 },
      liquidity: { adv_dollar_vol_30d: 50_000_000, last_price: 100 },
      macro: { in_blackout: false, blackout_reason: null },
      premarket: { gap_pct: 0.01 },
      short_interest: { short_pct_float: 0.05 },
      ...overrides.indicators,
    },
    vix: 20,
    signals: {
      conviction:   { value: 60, grade: 'B' },
      news:         { value: 50, label: 'positive', article_count: 5 },
      uw_options:   { value: 70, label: 'bullish' },
      gex:          { value: 30 },
      insider:      { value: 20, buy_usd: 1e6, sell_usd: 0 },
      distance_52w: { value: 80, pct_off_52w_high: -0.30 },
      predictor:    { value: 0 },
      ...overrides.signals,
    },
    setup: { setup_type: 'momentum', thesis: 'Strong momentum signal', ...overrides.setup },
    enforceSetup: true,
    composite: 75,
    ...overrides,
  };
}

// ─── Earnings ────────────────────────────────────────────────────────────────
describe('gateEarningsProximity', () => {
  it('passes when earnings are far enough away', () => {
    assert.equal(gateEarningsProximity(ctx()), null);
  });

  it('blocks when earnings are within the limit', () => {
    const r = gateEarningsProximity(ctx({ indicators: { earnings: { days_until: 1 } } }));
    assert.equal(r?.gate, 'earnings_proximity');
    assert.match(r.message, /1 days/);
  });

  it('passes when limit is null (disabled)', () => {
    assert.equal(gateEarningsProximity(ctx({
      filters: { avoid_earnings_within_days: null },
      indicators: { earnings: { days_until: 0 } },
    })), null);
  });

  it('passes when days_until is unknown (null/undefined)', () => {
    assert.equal(gateEarningsProximity(ctx({ indicators: { earnings: null } })), null);
  });

  it('passes when earnings already happened (negative days)', () => {
    assert.equal(gateEarningsProximity(ctx({ indicators: { earnings: { days_until: -3 } } })), null);
  });
});

// ─── Liquidity ──────────────────────────────────────────────────────────────
describe('gateLiquidity', () => {
  it('passes when ADV well above threshold', () => {
    assert.equal(gateLiquidity(ctx()), null);
  });

  it('blocks when ADV below threshold', () => {
    const r = gateLiquidity(ctx({ indicators: { liquidity: { adv_dollar_vol_30d: 2_000_000 } } }));
    assert.equal(r?.gate, 'liquidity');
  });

  it('passes when ADV unknown (null indicator)', () => {
    assert.equal(gateLiquidity(ctx({ indicators: { liquidity: null } })), null);
  });

  it('passes when threshold not configured', () => {
    assert.equal(gateLiquidity(ctx({
      filters: { min_adv_dollar_vol: null },
      indicators: { liquidity: { adv_dollar_vol_30d: 100 } },
    })), null);
  });
});

// ─── Macro blackout ──────────────────────────────────────────────────────────
describe('gateMacroBlackout', () => {
  it('passes when not in blackout', () => {
    assert.equal(gateMacroBlackout(ctx()), null);
  });

  it('blocks when in blackout AND filter enabled', () => {
    const r = gateMacroBlackout(ctx({
      indicators: { macro: { in_blackout: true, blackout_reason: 'FOMC meeting' } },
    }));
    assert.equal(r?.gate, 'macro_blackout');
    assert.match(r.message, /FOMC/);
  });

  it('passes even in blackout when filter disabled', () => {
    assert.equal(gateMacroBlackout(ctx({
      filters: { skip_during_macro_blackout: false },
      indicators: { macro: { in_blackout: true } },
    })), null);
  });
});

// ─── Premarket gap ───────────────────────────────────────────────────────────
describe('gatePremarketGap', () => {
  it('passes when gap is small', () => {
    assert.equal(gatePremarketGap(ctx()), null);
  });

  it('blocks when positive gap exceeds threshold', () => {
    const r = gatePremarketGap(ctx({ indicators: { premarket: { gap_pct: 0.15 } } }));
    assert.equal(r?.gate, 'premarket_gap');
  });

  it('blocks when negative gap exceeds threshold (magnitude)', () => {
    const r = gatePremarketGap(ctx({ indicators: { premarket: { gap_pct: -0.20 } } }));
    assert.equal(r?.gate, 'premarket_gap');
  });

  it('passes when gap is unknown', () => {
    assert.equal(gatePremarketGap(ctx({ indicators: { premarket: null } })), null);
  });
});

// ─── Short interest ──────────────────────────────────────────────────────────
describe('gateShortInterest', () => {
  it('passes when filter disabled (default)', () => {
    assert.equal(gateShortInterest(ctx({
      indicators: { short_interest: { short_pct_float: 0.50 } },
    })), null);
  });

  it('blocks when filter enabled AND short% > 30%', () => {
    const r = gateShortInterest(ctx({
      filters: { skip_high_short_interest: true },
      indicators: { short_interest: { short_pct_float: 0.45 } },
    }));
    assert.equal(r?.gate, 'short_interest');
  });

  it('passes when filter enabled but short% <= 30%', () => {
    assert.equal(gateShortInterest(ctx({
      filters: { skip_high_short_interest: true },
      indicators: { short_interest: { short_pct_float: 0.20 } },
    })), null);
  });
});

// ─── Price range ─────────────────────────────────────────────────────────────
describe('gatePriceRange', () => {
  it('passes inside the range', () => {
    assert.equal(gatePriceRange(ctx()), null);
  });

  it('blocks below price_min', () => {
    const r = gatePriceRange(ctx({ indicators: { liquidity: { last_price: 3 } } }));
    assert.equal(r?.gate, 'price_min');
  });

  it('blocks above price_max', () => {
    const r = gatePriceRange(ctx({ indicators: { liquidity: { last_price: 700 } } }));
    assert.equal(r?.gate, 'price_max');
  });

  it('passes when price unknown', () => {
    assert.equal(gatePriceRange(ctx({ indicators: { liquidity: { last_price: null } } })), null);
  });
});

// ─── VIX range ───────────────────────────────────────────────────────────────
describe('gateVixRange', () => {
  it('passes inside the range', () => {
    assert.equal(gateVixRange(ctx()), null);
  });

  it('blocks below vix_min', () => {
    const r = gateVixRange(ctx({ vix: 10 }));
    assert.equal(r?.gate, 'vix_low');
  });

  it('blocks above vix_max', () => {
    const r = gateVixRange(ctx({ vix: 75 }));
    assert.equal(r?.gate, 'vix_high');
  });

  it('passes when vix unknown', () => {
    assert.equal(gateVixRange(ctx({ vix: null })), null);
  });
});

// ─── Conviction grade ────────────────────────────────────────────────────────
describe('gateConvictionGrade', () => {
  it('passes when grade equals minimum', () => {
    assert.equal(gateConvictionGrade(ctx({ signals: { conviction: { grade: 'C' } } })), null);
  });

  it('passes when grade exceeds minimum', () => {
    assert.equal(gateConvictionGrade(ctx({ signals: { conviction: { grade: 'A' } } })), null);
  });

  it('blocks when grade below minimum', () => {
    const r = gateConvictionGrade(ctx({
      filters: { conviction_grade_min: 'B' },
      signals: { conviction: { grade: 'F' } },
    }));
    assert.equal(r?.gate, 'conviction_grade');
  });

  it('passes when no minimum configured', () => {
    assert.equal(gateConvictionGrade(ctx({
      filters: { conviction_grade_min: null },
      signals: { conviction: { grade: 'F' } },
    })), null);
  });

  it('passes when grade unknown', () => {
    assert.equal(gateConvictionGrade(ctx({ signals: { conviction: { grade: null } } })), null);
  });
});

// ─── UW label ────────────────────────────────────────────────────────────────
describe('gateUwLabel', () => {
  it('passes when label in allowed list', () => {
    assert.equal(gateUwLabel(ctx()), null);
  });

  it('blocks when label not in allowed list', () => {
    const r = gateUwLabel(ctx({ signals: { uw_options: { label: 'bearish' } } }));
    assert.equal(r?.gate, 'uw_label');
  });

  it('passes when no allow-list configured', () => {
    assert.equal(gateUwLabel(ctx({
      filters: { require_uw_label_any: [] },
      signals: { uw_options: { label: 'no_data' } },
    })), null);
  });

  it('blocks when label is no_data and allow-list is non-empty', () => {
    const r = gateUwLabel(ctx({ signals: { uw_options: { label: 'no_data' } } }));
    assert.equal(r?.gate, 'uw_label');
  });
});

// ─── News sentiment ─────────────────────────────────────────────────────────
describe('gateNewsSentiment', () => {
  it('passes when no minimum required', () => {
    assert.equal(gateNewsSentiment(ctx()), null);
  });

  it('passes when sentiment meets minimum', () => {
    assert.equal(gateNewsSentiment(ctx({
      filters: { require_news_sentiment_min: 'neutral' },
      signals: { news: { label: 'positive' } },
    })), null);
  });

  it('blocks when sentiment below minimum', () => {
    const r = gateNewsSentiment(ctx({
      filters: { require_news_sentiment_min: 'positive' },
      signals: { news: { label: 'negative' } },
    }));
    assert.equal(r?.gate, 'news_sentiment');
  });

  it('blocks when sentiment is unknown and minimum is set', () => {
    const r = gateNewsSentiment(ctx({
      filters: { require_news_sentiment_min: 'positive' },
      signals: { news: { label: 'no_data' } },
    }));
    assert.equal(r?.gate, 'news_sentiment');
  });
});

// ─── Setup classification ───────────────────────────────────────────────────
describe('gateSetupClassification', () => {
  it('passes when setup classified and enforce is on', () => {
    assert.equal(gateSetupClassification(ctx()), null);
  });

  it('blocks when setup is null and enforce is on', () => {
    const r = gateSetupClassification(ctx({ setup: null }));
    assert.equal(r?.gate, 'setup_classification');
  });

  it('passes when enforce is off, even with null setup', () => {
    assert.equal(gateSetupClassification(ctx({ setup: null, enforceSetup: false })), null);
  });
});

// ─── Strategy filter ────────────────────────────────────────────────────────
describe('gateStrategyFilter', () => {
  it('passes on composite (default) regardless of setup', () => {
    assert.equal(gateStrategyFilter(ctx({ setup: { setup_type: 'breakout' } })), null);
  });

  it('passes when bot strategy matches setup', () => {
    assert.equal(gateStrategyFilter(ctx({
      filters: { strategy: 'momentum' },
      setup: { setup_type: 'momentum' },
    })), null);
  });

  it('blocks when bot strategy does not match setup', () => {
    const r = gateStrategyFilter(ctx({
      filters: { strategy: 'breakout' },
      setup: { setup_type: 'mean_reversion' },
    }));
    assert.equal(r?.gate, 'strategy_filter');
    assert.match(r.message, /breakout/);
  });

  it('passes (defers to setup gate) when setup is null', () => {
    assert.equal(gateStrategyFilter(ctx({
      filters: { strategy: 'momentum' },
      setup: null,
    })), null);
  });
});

// ─── Composite score ────────────────────────────────────────────────────────
describe('gateCompositeScore', () => {
  it('passes when composite meets threshold', () => {
    assert.equal(gateCompositeScore({ filters: { min_composite_score: 60 }, composite: 75 }), null);
  });

  it('blocks when composite below threshold', () => {
    const r = gateCompositeScore({ filters: { min_composite_score: 60 }, composite: 45 });
    assert.equal(r?.gate, 'composite_score');
  });

  it('uses default threshold of 60 when filter not set', () => {
    const r = gateCompositeScore({ filters: {}, composite: 50 });
    assert.equal(r?.gate, 'composite_score');
  });

  it('passes when composite is null (no data — fail open)', () => {
    assert.equal(gateCompositeScore({ filters: { min_composite_score: 60 }, composite: null }), null);
  });
});

// ─── Orchestrator: firstBlocker / allBlockers ───────────────────────────────
describe('firstBlocker / allBlockers', () => {
  it('firstBlocker returns null when all pass', () => {
    assert.equal(firstBlocker(ctx(), PRE_SIGNAL_GATES), null);
  });

  it('firstBlocker returns the FIRST failing gate in order', () => {
    // Liquidity is checked before VIX. If both fail, liquidity wins.
    const r = firstBlocker(ctx({
      vix: 5,                                                    // would fail vix_low
      indicators: { liquidity: { adv_dollar_vol_30d: 100 } },    // also fails liquidity
    }), PRE_SIGNAL_GATES);
    assert.equal(r?.gate, 'liquidity');
  });

  it('allBlockers returns every failing gate', () => {
    const blockers = allBlockers(ctx({
      vix: 5,
      indicators: {
        liquidity: { adv_dollar_vol_30d: 100, last_price: 1000 },
        earnings: { days_until: 1 },
      },
    }), PRE_SIGNAL_GATES);
    const gates = blockers.map(b => b.gate).sort();
    assert.deepEqual(gates, ['earnings_proximity', 'liquidity', 'price_max', 'vix_low']);
  });

  it('allBlockers returns empty when all pass', () => {
    assert.deepEqual(allBlockers(ctx(), PRE_SIGNAL_GATES), []);
  });
});

// ─── Integration: end-to-end happy path through every gate list ─────────────
describe('all-gates integration', () => {
  it('a clean candidate passes every gate', () => {
    const c = ctx();
    assert.equal(firstBlocker(c, PRE_SIGNAL_GATES),  null);
    assert.equal(firstBlocker(c, POST_SIGNAL_GATES), null);
    assert.equal(firstBlocker(c, SETUP_GATES),       null);
    assert.equal(gateCompositeScore(c),              null);
  });

  it('a candidate fails on the composite score even when all other gates pass', () => {
    const c = ctx({ composite: 30 });
    assert.equal(firstBlocker(c, PRE_SIGNAL_GATES), null);
    assert.equal(firstBlocker(c, POST_SIGNAL_GATES), null);
    assert.equal(firstBlocker(c, SETUP_GATES), null);
    assert.equal(gateCompositeScore(c)?.gate, 'composite_score');
  });

  it('a momentum-only bot rejects a breakout setup at the strategy filter', () => {
    const c = ctx({
      filters: { strategy: 'momentum' },
      setup:   { setup_type: 'breakout' },
    });
    assert.equal(firstBlocker(c, PRE_SIGNAL_GATES), null);
    assert.equal(firstBlocker(c, POST_SIGNAL_GATES), null);
    const setupBlock = firstBlocker(c, SETUP_GATES);
    assert.equal(setupBlock?.gate, 'strategy_filter');
  });
});
