/**
 * Regression tests for the trail_pct=0 exit bug (2026-08-12).
 *
 * THE BUG: the mechanical exit used `currentPnl < peakPnl * (1 - trailFraction)`. The insider
 * rule sets trail_pct: 0 meaning "NO trailing stop, hold to the 20-day time stop". But with
 * trailFraction = 0 the condition reduced to `currentPnl < peakPnl` — exit on ANY tick below
 * peak, the tightest possible trail. Result: the 20-day hold never happened; ARTV/ENR/NTSK
 * churned daily (sell-at-open, rebuy-afternoon) and the real Alpaca account went slightly
 * negative while the DB reported phantom wins.
 *
 * Invariant: trail_pct <= 0 ⇒ the trail never fires; only hard_stop and time_stop apply.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { decideMechanicalExit } from '../src/core/bot-advance/executor.js';

// Insider-rule-shaped defaults: $1000 notional, 15% hard stop, 20-day time stop.
const base = {
  hardSlUsd: 150,        // 15% of $1000
  trailMinPeak: 40,      // ~4% arm
  timeStopDays: 20,
};

describe('trail_pct = 0 → NO trailing stop (the bug)', () => {
  test('a profitable position that ticked below peak is HELD, not trail-stopped', () => {
    // peak +$186, now +$120 — a clear give-back. Old code: trail_stop. Fixed: hold.
    const r = decideMechanicalExit({ ...base, trailFraction: 0, currentPnl: 120, peakPnl: 186, heldDays: 0.8 });
    assert.equal(r, null, 'trail_pct=0 must not exit on a pullback from peak');
  });

  test('holds all the way to the 20-day time stop', () => {
    const held = decideMechanicalExit({ ...base, trailFraction: 0, currentPnl: 50, peakPnl: 200, heldDays: 19 });
    assert.equal(held, null, 'still holding at day 19');
    const stop = decideMechanicalExit({ ...base, trailFraction: 0, currentPnl: 50, peakPnl: 200, heldDays: 20 });
    assert.equal(stop, 'time_stop', 'exits at the 20-day time stop');
  });

  test('the 15% hard stop still protects the downside with trail disabled', () => {
    const r = decideMechanicalExit({ ...base, trailFraction: 0, currentPnl: -150, peakPnl: 0, heldDays: 3 });
    assert.equal(r, 'hard_stop');
  });

  test('negative trail_pct is also treated as disabled', () => {
    const r = decideMechanicalExit({ ...base, trailFraction: -0.1, currentPnl: 120, peakPnl: 186, heldDays: 1 });
    assert.equal(r, null);
  });
});

describe('a positive trail_pct still trails (no regression)', () => {
  test('30% trail fires once peak is armed and price gives back past the band', () => {
    // peak +$100 (> $40 arm), 30% band → exit if current < $70. current $60 → trail_stop.
    const r = decideMechanicalExit({ ...base, trailFraction: 0.30, currentPnl: 60, peakPnl: 100, heldDays: 2 });
    assert.equal(r, 'trail_stop');
  });

  test('within the trail band it holds', () => {
    const r = decideMechanicalExit({ ...base, trailFraction: 0.30, currentPnl: 85, peakPnl: 100, heldDays: 2 });
    assert.equal(r, null, 'give-back of 15% is inside the 30% band → hold');
  });

  test('trail does NOT fire before the peak is armed (cost-aware arming preserved)', () => {
    // peak only +$30 (< $40 arm) → trail must not engage even on a pullback.
    const r = decideMechanicalExit({ ...base, trailFraction: 0.30, currentPnl: 5, peakPnl: 30, heldDays: 1 });
    assert.equal(r, null);
  });

  test('hard_stop takes precedence over a would-be trail_stop', () => {
    const r = decideMechanicalExit({ ...base, trailFraction: 0.30, currentPnl: -150, peakPnl: 100, heldDays: 2 });
    assert.equal(r, 'hard_stop');
  });
});

/**
 * Sane-quote guard (2026-08-12): IEX quotes on thin small-caps are frequently broken
 * (a 0 leg, or a 37% spread). Marking positions off ask, or off a mid corrupted by a 0 leg,
 * fabricated exit prices and could trigger false hard-stops.
 */
import { _saneQuotePrice } from '../src/core/bot-advance/executor.js';

describe('_saneQuotePrice — fair value, robust to broken IEX quotes', () => {
  test('wide spread (ARTV 37%) → MID (fair value), not the bid', () => {
    // Marking a flat position at the bid of a garbage-wide quote fabricates a loss and trips a
    // false hard_stop. ARTV bid 9.54 / ask 13.87 → mid 11.705 ≈ entry 11.62 → correctly flat.
    assert.ok(Math.abs(_saneQuotePrice({ bid: 9.54, ask: 13.87 }) - 11.705) < 1e-6);
  });
  test('broken ask=0 (PFE) → bid, ignoring the corrupted mid', () => {
    assert.equal(_saneQuotePrice({ bid: 25.56, ask: 0, mid: 12.78 }), 25.56);
  });
  test('tight two-sided quote → mid', () => {
    assert.ok(Math.abs(_saneQuotePrice({ bid: 20.10, ask: 20.14 }) - 20.12) < 1e-6);
  });
  test('only an ask present → ask', () => {
    assert.equal(_saneQuotePrice({ bid: 0, ask: 15.2 }), 15.2);
  });
  test('nothing valid → null (caller uses last-close fallback)', () => {
    assert.equal(_saneQuotePrice({ bid: 0, ask: 0 }), null);
    assert.equal(_saneQuotePrice(null), null);
  });
});
