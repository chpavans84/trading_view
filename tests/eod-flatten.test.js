/**
 * Regression tests for the 3:50 PM ET EOD flatten.
 *
 * THE BUG (2026-07-14): eodFlatten closed EVERY position in the Alpaca account with no
 * bot/strategy scoping. Bot 4's `insider_director_cluster` rule is a 20-DAY swing hold
 * (15% stop, no trail — the only strategy with a proven edge). The flatten liquidated it
 * the same afternoon it opened, every day: FISV was bought 09:31 ET and sold 15:50 ET on
 * Jul-6/9/10/13, round-tripped 15 times. The swing thesis never once expressed itself.
 *
 * The tests below lock in that a swing hold is NEVER flattened.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  selectFlattenTargets,
  shouldFlattenAt,
  isFlattenEnabled,
  runFlatten,
  SWING_MIN_TIME_STOP_DAYS,
} from '../src/core/eod-flatten.js';

const pos = (symbol, qty = 10) => ({ symbol, qty, unrealized_pl: 0 });

describe('selectFlattenTargets — swing holds are protected', () => {
  test('THE REGRESSION: a swing-held symbol is never flattened', () => {
    const r = selectFlattenTargets([pos('FISV'), pos('AAPL')], new Set(['FISV']));
    assert.deepEqual(r.flatten.map(p => p.symbol), ['AAPL'], 'AAPL (day trade) should flatten');
    assert.deepEqual(r.protected.map(p => p.symbol), ['FISV'], 'FISV (20d insider hold) must be kept');
  });

  test('day-trade positions still flatten (guardrail preserved)', () => {
    const r = selectFlattenTargets([pos('TSLA'), pos('NVDA')], new Set());
    assert.equal(r.flatten.length, 2);
    assert.equal(r.protected.length, 0);
  });

  test('symbol matching is case-insensitive', () => {
    const r = selectFlattenTargets([{ symbol: 'fisv', qty: 1 }], new Set(['FISV']));
    assert.equal(r.protected.length, 1, 'lowercase broker symbol must still match');
    assert.equal(r.flatten.length, 0);
  });

  test('empty / missing position list is safe', () => {
    assert.equal(selectFlattenTargets([], new Set()).flatten.length, 0);
    assert.equal(selectFlattenTargets(null, new Set()).flatten.length, 0);
  });

  test('accepts a plain array of protected symbols, not just a Set', () => {
    const r = selectFlattenTargets([pos('FISV')], ['FISV']);
    assert.equal(r.protected.length, 1);
  });
});

describe('shouldFlattenAt — fires only at 3:50 PM ET on a weekday', () => {
  // 2026-07-14 is a Tuesday; 2026-07-18 is a Saturday.
  const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi);

  test('fires at exactly 15:50 on a weekday', () => {
    assert.equal(shouldFlattenAt(at(2026, 6, 14, 15, 50)), true);
  });

  test('does not fire a minute early or late', () => {
    assert.equal(shouldFlattenAt(at(2026, 6, 14, 15, 49)), false);
    assert.equal(shouldFlattenAt(at(2026, 6, 14, 15, 51)), false);
  });

  test('does not fire at the same minute of a different hour', () => {
    assert.equal(shouldFlattenAt(at(2026, 6, 14, 14, 50)), false);
  });

  test('never fires on a weekend', () => {
    assert.equal(shouldFlattenAt(at(2026, 6, 18, 15, 50)), false, 'Saturday');
    assert.equal(shouldFlattenAt(at(2026, 6, 19, 15, 50)), false, 'Sunday');
  });
});

describe('isFlattenEnabled — kill switch', () => {
  test('enabled by default (preserves the day-trade guardrail)', () => {
    assert.equal(isFlattenEnabled({}), true);
  });
  test('EOD_FLATTEN_ENABLED=false disables it', () => {
    assert.equal(isFlattenEnabled({ EOD_FLATTEN_ENABLED: 'false' }), false);
    assert.equal(isFlattenEnabled({ EOD_FLATTEN_ENABLED: 'FALSE' }), false);
  });
});

describe('runFlatten — end to end with injected broker', () => {
  test('closes day trades, leaves the swing hold alone', async () => {
    const closed = [];
    const res = await runFlatten({
      getPositions: async () => [pos('FISV'), pos('TSLA')],
      closePosition: async (s) => { closed.push(s); },
      getProtectedSymbols: async () => ({ symbols: new Set(['FISV']), ok: true }),
    });
    assert.deepEqual(closed, ['TSLA'], 'only the day trade should hit the broker');
    assert.deepEqual(res.protected, ['FISV']);
    assert.equal(res.aborted, false);
  });

  test('FAILS CLOSED: aborts without closing anything if swing symbols cannot be loaded', async () => {
    const closed = [];
    const res = await runFlatten({
      getPositions: async () => [pos('FISV'), pos('TSLA')],
      closePosition: async (s) => { closed.push(s); },
      getProtectedSymbols: async () => ({ symbols: new Set(), ok: false }), // DB down
    });
    assert.deepEqual(closed, [], 'a DB failure must NOT cause a blind liquidation');
    assert.equal(res.aborted, true);
  });

  test('one symbol failing to close does not abort the rest', async () => {
    const closed = [];
    await runFlatten({
      getPositions: async () => [pos('AAA'), pos('BBB'), pos('CCC')],
      closePosition: async (s) => {
        if (s === 'BBB') throw new Error('broker rejected');
        closed.push(s);
      },
      getProtectedSymbols: async () => ({ symbols: new Set(), ok: true }),
    });
    assert.deepEqual(closed, ['AAA', 'CCC']);
  });

  test('a broker outage (no positions) is a no-op, not a crash', async () => {
    const res = await runFlatten({
      getPositions: async () => { throw new Error('alpaca 500'); },
      closePosition: async () => { throw new Error('should not be called'); },
      getProtectedSymbols: async () => ({ symbols: new Set(), ok: true }),
    });
    assert.deepEqual(res.flattened, []);
  });
});

describe('SWING_MIN_TIME_STOP_DAYS', () => {
  test('a 20-day insider hold qualifies as swing; a 1-day intraday rule does not', () => {
    assert.ok(20 >= SWING_MIN_TIME_STOP_DAYS, 'insider_director_cluster (20d) must be protected');
    assert.ok(!(1 >= SWING_MIN_TIME_STOP_DAYS), 'a 1-day rule should still flatten at EOD');
  });
});
