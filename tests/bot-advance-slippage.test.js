/**
 * Regression test for the bot-advance slippage metric fix (order-path #2, 2026-06-14).
 * Guards: honest slippage from a good reference, and null on a missing/implausible one
 * (the NUVL −14%/share contamination must never be recorded again).
 *   node --test tests/bot-advance-slippage.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlippageCents } from '../src/core/bot-advance/slippage.js';

test('honest slippage from a good reference (cents per share, signed)', () => {
  assert.equal(computeSlippageCents(100.05, 100.00), 5);     // filled 5¢ worse
  assert.equal(computeSlippageCents(99.96, 100.00), -4);     // filled 4¢ better
  assert.equal(computeSlippageCents(60.1694, 60.16), 0.94);  // real IREN-like fill
});

test('implausible reference (>5%/share) records NULL, not a fictional number', () => {
  // NUVL 2026-06-13: fill 123.23 vs a stale 140.73 reference → −14% → must be null
  assert.equal(computeSlippageCents(123.23, 140.73), null);
  assert.equal(computeSlippageCents(32.96, 35.00), null);    // GLXY-like −6%
});

test('missing / zero reference or fill → null', () => {
  assert.equal(computeSlippageCents(100, null), null);
  assert.equal(computeSlippageCents(100, 0), null);
  assert.equal(computeSlippageCents(0, 100), null);
  assert.equal(computeSlippageCents(100, undefined), null);
});

test('boundary: exactly 5% is allowed, just over is not', () => {
  assert.equal(computeSlippageCents(105, 100), 500);         // exactly 5% → kept
  assert.equal(computeSlippageCents(105.01, 100), null);     // just over → null
});
