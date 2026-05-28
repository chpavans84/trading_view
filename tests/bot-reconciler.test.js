/**
 * tests/bot-reconciler.test.js
 *
 * Unit tests for the pure-logic helpers in src/core/bot-reconciler.js.
 *
 * Only `_compareQty` is exported as a testable helper because the rest of
 * reconcileBotPositions() is I/O-coupled (DB, Alpaca, Tiger). The runtime path
 * uses the same helper, so testing _compareQty exercises the qty-mismatch
 * detection logic end-to-end.
 *
 * Run: node --test tests/bot-reconciler.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _compareQty } from '../src/core/bot-reconciler.js';

describe('_compareQty', () => {
  it('matches exact integer equality', () => {
    const { match, dbQty } = _compareQty(5, 5);
    assert.equal(match, true);
    assert.equal(dbQty, 5);
  });

  it('matches string-numeric DB values (NUMERIC → "5.0000")', () => {
    const { match, dbQty } = _compareQty('5.0000', 5);
    assert.equal(match, true);
    assert.equal(dbQty, 5);
  });

  it('matches with float tolerance for fractional shares', () => {
    // 0.1 + 0.2 = 0.30000000000000004 — strict !== would fire phantom mismatch
    const { match } = _compareQty(0.3, 0.1 + 0.2);
    assert.equal(match, true);
  });

  it('matches fractional shares within MIN_FRACTIONAL_INCREMENT', () => {
    const { match } = _compareQty(2.5, 2.50005);
    assert.equal(match, true);
  });

  it('flags real qty discrepancies (delta > tolerance)', () => {
    const { match, dbQty } = _compareQty(5, 9);
    assert.equal(match, false);
    assert.equal(dbQty, 5);
  });

  it('flags fractional discrepancies over tolerance', () => {
    const { match } = _compareQty(2.5, 2.6);
    assert.equal(match, false);
  });

  it('returns dbQty=null when DB value is null (NaN-safe)', () => {
    const { match, dbQty } = _compareQty(null, 9);
    assert.equal(match, false);
    assert.equal(dbQty, null);
  });

  it('returns dbQty=null when DB value is NaN', () => {
    const { match, dbQty } = _compareQty(NaN, 9);
    assert.equal(match, false);
    assert.equal(dbQty, null);
  });

  it('returns dbQty=null when DB value is undefined', () => {
    const { match, dbQty } = _compareQty(undefined, 9);
    assert.equal(match, false);
    assert.equal(dbQty, null);
  });

  it('returns dbQty=null when DB value is unparseable string', () => {
    const { match, dbQty } = _compareQty('not-a-number', 9);
    assert.equal(match, false);
    assert.equal(dbQty, null);
  });

  it('delta sign convention: broker > db ⇒ positive delta in caller', () => {
    // _compareQty returns dbQty; caller computes delta = brokerQty - dbQty.
    // Verify dbQty is exposed correctly so caller can compute the right sign.
    const { dbQty } = _compareQty(5, 9);
    assert.equal(9 - dbQty, 4);   // broker(9) has 4 more than DB(5)
  });

  it('delta sign convention: broker < db ⇒ negative delta in caller', () => {
    const { dbQty } = _compareQty(9, 5);
    assert.equal(5 - dbQty, -4);  // broker(5) has 4 fewer than DB(9)
  });
});
