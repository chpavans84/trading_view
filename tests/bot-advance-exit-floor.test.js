/**
 * tests/bot-advance-exit-floor.test.js
 *
 * Regression tests for the 2026-07-07 retrospective fixes:
 *   1. shouldVetoExit()        — min-hold floor (executor.js)      → stop 34-min scalping
 *   2. phantomTerminalStatus() — phantom accounting (drift-detector) → stop zeroing P&L
 *
 * Both are pure functions: data in → data out, no DB/HTTP/mocks.
 * Run: node --test tests/bot-advance-exit-floor.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { shouldVetoExit } from '../src/core/bot-advance/executor.js';
import { phantomTerminalStatus } from '../src/core/drift-detector.js';

describe('shouldVetoExit — minimum-hold floor', () => {
  const H = 24; // an arbitrary floor value under test (live default is 6h, BOT_SIM-calibrated)

  it('vetoes a trail_stop taken 34 minutes in (the exact scalping bug)', () => {
    assert.equal(shouldVetoExit({ exitReason: 'trail_stop', heldHours: 0.57, minHoldHours: H }), true);
  });

  it('vetoes a thesis_broken taken at 0h (open+close same scan)', () => {
    assert.equal(shouldVetoExit({ exitReason: 'thesis_broken', heldHours: 0, minHoldHours: H }), true);
  });

  it('NEVER traps risk: hard_stop always passes through', () => {
    assert.equal(shouldVetoExit({ exitReason: 'hard_stop', heldHours: 0.1, minHoldHours: H }), false);
  });

  it('NEVER traps risk: catastrophic exit always passes through', () => {
    assert.equal(shouldVetoExit({ exitReason: 'catastrophic_-15pct', heldHours: 0.1, minHoldHours: H }), false);
    assert.equal(shouldVetoExit({ exitReason: 'stop_loss', heldHours: 0.1, minHoldHours: H }), false);
  });

  it('allows a non-risk exit once the trade has aged past the floor', () => {
    assert.equal(shouldVetoExit({ exitReason: 'trail_stop', heldHours: 25, minHoldHours: H }), false);
    assert.equal(shouldVetoExit({ exitReason: 'time_stop',  heldHours: 120, minHoldHours: H }), false);
  });

  it('floor of 0 disables the veto entirely (per-bot opt-out)', () => {
    assert.equal(shouldVetoExit({ exitReason: 'trail_stop', heldHours: 0.1, minHoldHours: 0 }), false);
  });

  it('no exitReason → never vetoes (nothing to hold)', () => {
    assert.equal(shouldVetoExit({ exitReason: null, heldHours: 0, minHoldHours: H }), false);
  });

  it('boundary: exactly at the floor is allowed (not < floor)', () => {
    assert.equal(shouldVetoExit({ exitReason: 'trail_stop', heldHours: 24, minHoldHours: 24 }), false);
    assert.equal(shouldVetoExit({ exitReason: 'trail_stop', heldHours: 23.99, minHoldHours: 24 }), true);
  });
});

describe('phantomTerminalStatus — phantom accounting', () => {
  it('books a FILLED advance phantom as a real close (had a position → carries P&L)', () => {
    assert.equal(phantomTerminalStatus('bot_advance_trades', 941.01), 'closed');
    assert.equal(phantomTerminalStatus('bot_advance_trades', 0.01), 'closed');
  });

  it('leaves a NEVER-FILLED advance phantom as failed (order never became a position)', () => {
    assert.equal(phantomTerminalStatus('bot_advance_trades', 0), 'failed');
    assert.equal(phantomTerminalStatus('bot_advance_trades', null), 'failed');
    assert.equal(phantomTerminalStatus('bot_advance_trades', undefined), 'failed');
  });

  it('never books P&L for the legacy trades table (ambiguous columns) → always failed', () => {
    assert.equal(phantomTerminalStatus('trades', 941.01), 'failed');
    assert.equal(phantomTerminalStatus('trades', 0), 'failed');
  });
});
