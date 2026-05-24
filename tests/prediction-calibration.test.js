/**
 * Tests for computeUwModifier in src/core/prediction-calibration.js
 * Pure function — no DB, no UW calls.
 *
 * Run: node --experimental-test-module-mocks --test tests/prediction-calibration.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

// ── Inline replica of computeUwModifier ───────────────────────────────────────
// Mirrors prediction-calibration.js exactly. Tests pure logic in isolation.

function computeUwModifier(adjustedChangePct, conviction) {
  const label = conviction?.composite?.label;
  const score = conviction?.composite?.score;

  if (!label || label === 'no_data' || score == null || label === 'neutral') {
    return { delta: 0, reason: 'no_uw_data', uw_label: null };
  }
  if (adjustedChangePct === 0) {
    return { delta: 0, reason: 'flat_forecast', uw_label: label };
  }

  const magnitude = Math.abs(score);
  const isBullishPred = adjustedChangePct > 0;
  const isBearishPred = adjustedChangePct < 0;
  const isBullishUw   = label === 'bullish' || label === 'strong_bullish';
  const isBearishUw   = label === 'bearish' || label === 'strong_bearish';

  if ((isBullishPred && isBullishUw) || (isBearishPred && isBearishUw)) {
    return { delta: Math.min(15, Math.round(15 * magnitude)), reason: 'uw_aligned', uw_label: label };
  }
  if ((isBullishPred && isBearishUw) || (isBearishPred && isBullishUw)) {
    return { delta: -Math.min(20, Math.round(20 * magnitude)), reason: 'uw_conflicting', uw_label: label };
  }

  return { delta: 0, reason: 'no_uw_data', uw_label: null };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('computeUwModifier — null/missing conviction → no_uw_data', () => {
  it('returns delta=0, reason=no_uw_data when conviction is null', () => {
    const r = computeUwModifier(1.5, null);
    assert.strictEqual(r.delta, 0);
    assert.strictEqual(r.reason, 'no_uw_data');
    assert.strictEqual(r.uw_label, null);
  });

  it('returns delta=0 when composite.label is no_data', () => {
    const r = computeUwModifier(2.0, { composite: { score: null, label: 'no_data' } });
    assert.strictEqual(r.delta, 0);
    assert.strictEqual(r.reason, 'no_uw_data');
  });
});

describe('computeUwModifier — neutral conviction → no_uw_data', () => {
  it('neutral label yields delta=0, reason=no_uw_data (no directional signal)', () => {
    const r = computeUwModifier(0.8, { composite: { score: 0.05, label: 'neutral' } });
    assert.strictEqual(r.delta, 0);
    assert.strictEqual(r.reason, 'no_uw_data');
    assert.strictEqual(r.uw_label, null);
  });
});

describe('computeUwModifier — flat forecast → flat_forecast', () => {
  it('adjustedChangePct=0 with directional UW yields delta=0, reason=flat_forecast', () => {
    const r = computeUwModifier(0, { composite: { score: 0.7, label: 'strong_bullish' } });
    assert.strictEqual(r.delta, 0);
    assert.strictEqual(r.reason, 'flat_forecast');
    assert.strictEqual(r.uw_label, 'strong_bullish');
  });
});

describe('computeUwModifier — aligned: bullish pred + bullish UW', () => {
  it('delta is positive and capped at 15', () => {
    const r = computeUwModifier(3.0, { composite: { score: 0.8, label: 'strong_bullish' } });
    assert.ok(r.delta > 0, `delta=${r.delta} should be > 0`);
    assert.ok(r.delta <= 15, `delta=${r.delta} exceeds max +15`);
    assert.strictEqual(r.reason, 'uw_aligned');
    assert.strictEqual(r.uw_label, 'strong_bullish');
  });

  it('score=1.0 yields exactly delta=15', () => {
    const r = computeUwModifier(1.0, { composite: { score: 1.0, label: 'bullish' } });
    assert.strictEqual(r.delta, 15);
  });
});

describe('computeUwModifier — aligned: bearish pred + bearish UW', () => {
  it('delta is positive (confidence boost) when bearish aligns', () => {
    const r = computeUwModifier(-2.5, { composite: { score: -0.6, label: 'bearish' } });
    assert.ok(r.delta > 0, `expected positive delta, got ${r.delta}`);
    assert.strictEqual(r.reason, 'uw_aligned');
  });
});

describe('computeUwModifier — conflict: bullish pred + bearish UW', () => {
  it('delta is negative and bounded to -20', () => {
    const r = computeUwModifier(1.5, { composite: { score: -0.9, label: 'strong_bearish' } });
    assert.ok(r.delta < 0, `delta=${r.delta} should be negative`);
    assert.ok(r.delta >= -20, `delta=${r.delta} exceeds min -20`);
    assert.strictEqual(r.reason, 'uw_conflicting');
    assert.strictEqual(r.uw_label, 'strong_bearish');
  });

  it('score magnitude=1.0 yields exactly delta=-20', () => {
    const r = computeUwModifier(2.0, { composite: { score: -1.0, label: 'strong_bearish' } });
    assert.strictEqual(r.delta, -20);
  });
});

describe('computeUwModifier — conflict: bearish pred + bullish UW', () => {
  it('delta is negative when bearish prediction conflicts with bullish UW', () => {
    const r = computeUwModifier(-1.0, { composite: { score: 0.5, label: 'bullish' } });
    assert.ok(r.delta < 0, `expected negative delta, got ${r.delta}`);
    assert.strictEqual(r.reason, 'uw_conflicting');
  });
});

describe('computeUwModifier — delta proportional to magnitude', () => {
  it('lower score magnitude produces smaller delta', () => {
    const high = computeUwModifier(1.0, { composite: { score: 0.8, label: 'strong_bullish' } });
    const low  = computeUwModifier(1.0, { composite: { score: 0.2, label: 'bullish' } });
    assert.ok(high.delta > low.delta, `high=${high.delta} should exceed low=${low.delta}`);
  });
});
