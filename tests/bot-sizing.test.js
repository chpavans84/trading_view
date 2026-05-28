/**
 * tests/bot-sizing.test.js
 *
 * Unit tests for src/core/bot-sizing.js — pure position-sizing math.
 * No DB, no broker, no mocks.
 *
 * Run: node --test tests/bot-sizing.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDollarBudget,
  computeQty,
  computeStopPct,
  computeStopPrice,
  planEntry,
  isCircuitBreakerTripped,
} from '../src/core/bot-sizing.js';

// ─── computeDollarBudget ────────────────────────────────────────────────────
describe('computeDollarBudget', () => {
  it('returns 95% of capital by default', () => {
    assert.equal(computeDollarBudget(1000), 950);
  });

  it('respects custom size_pct', () => {
    assert.equal(computeDollarBudget(1000, 50), 500);
  });

  it('floors to whole dollars', () => {
    assert.equal(computeDollarBudget(123.45, 95), 117);   // 123.45 * 0.95 = 117.27 → 117
  });

  it('caps size_pct at 100', () => {
    assert.equal(computeDollarBudget(1000, 150), 1000);
  });

  it('returns 0 for invalid capital', () => {
    assert.equal(computeDollarBudget(0), 0);
    assert.equal(computeDollarBudget(-100), 0);
    assert.equal(computeDollarBudget(NaN), 0);
    assert.equal(computeDollarBudget(null), 0);
    assert.equal(computeDollarBudget(undefined), 0);
  });

  it('returns 0 for invalid size_pct', () => {
    assert.equal(computeDollarBudget(1000, 0), 0);
    assert.equal(computeDollarBudget(1000, -10), 0);
    assert.equal(computeDollarBudget(1000, NaN), 0);
  });
});

// ─── computeQty ─────────────────────────────────────────────────────────────
describe('computeQty', () => {
  it('floors shares to integer', () => {
    assert.equal(computeQty(1000, 33), 30);   // 30.30… → 30
  });

  it('returns 0 when budget < price', () => {
    assert.equal(computeQty(50, 100), 0);
  });

  it('returns 0 for invalid inputs', () => {
    assert.equal(computeQty(0, 100), 0);
    assert.equal(computeQty(1000, 0), 0);
    assert.equal(computeQty(1000, -50), 0);
    assert.equal(computeQty(NaN, 100), 0);
    assert.equal(computeQty(1000, NaN), 0);
  });

  it('handles fractional inputs', () => {
    assert.equal(computeQty(1000.50, 100.25), 9);   // 9.98… → 9
  });
});

// ─── computeStopPct ─────────────────────────────────────────────────────────
describe('computeStopPct', () => {
  it('computes 5% stop for $50 risk on $1000 invested', () => {
    assert.equal(computeStopPct(50, 1000), 5);
  });

  it('rounds to 2 decimals', () => {
    assert.equal(computeStopPct(50, 1234.56), 4.05);
  });

  it('returns FALLBACK 3% when dollarsInvested is 0 or invalid', () => {
    assert.equal(computeStopPct(50, 0), 3);
    assert.equal(computeStopPct(50, -100), 3);
    assert.equal(computeStopPct(50, NaN), 3);
  });

  it('uses default $50 stop when stopLossUsd is invalid', () => {
    // Default $50 / $1000 invested = 5%
    assert.equal(computeStopPct(NaN, 1000), 5);
    assert.equal(computeStopPct(null, 1000), 5);
  });
});

// ─── computeStopPrice ───────────────────────────────────────────────────────
describe('computeStopPrice', () => {
  it('drops by stop_pct from fill price', () => {
    assert.equal(computeStopPrice(100, 5), 95);
    assert.equal(computeStopPrice(180, 6), 169.20);
  });

  it('returns fill price when stop_pct is 0', () => {
    assert.equal(computeStopPrice(100, 0), 100);
  });

  it('rounds to 2 decimals', () => {
    assert.equal(computeStopPrice(33.33, 7), 31.00);  // 31.0001 → 31.00
  });

  it('returns 0 for invalid price', () => {
    assert.equal(computeStopPrice(0, 5), 0);
    assert.equal(computeStopPrice(-50, 5), 0);
    assert.equal(computeStopPrice(NaN, 5), 0);
  });
});

// ─── planEntry (full pipeline) ───────────────────────────────────────────────
describe('planEntry', () => {
  it('happy path: $5000 capital, $180 price, 95% size', () => {
    const r = planEntry({ capitalUsd: 5000, price: 180 });
    assert.equal(r.dollarBudget, 4750);
    assert.equal(r.qty, 26);                       // 4750 / 180 = 26.38 → 26
    assert.equal(r.dollarsInvested, 4680);         // 26 * 180
    assert.equal(r.stopPct, 1.07);                 // 50 / 4680 = 1.068... → 1.07
    assert.equal(r.stopPrice, 178.07);             // 180 * (1 - 0.0107)
    assert.equal(r.skip, undefined);
  });

  it('returns skip=no_capital when capital is 0', () => {
    const r = planEntry({ capitalUsd: 0, price: 180 });
    assert.equal(r.skip, 'no_capital');
    assert.equal(r.qty, 0);
  });

  it('returns skip=no_price when price is missing', () => {
    const r = planEntry({ capitalUsd: 5000, price: null });
    assert.equal(r.skip, 'no_price');
  });

  it('returns skip=insufficient_capital when 1 share costs more than budget', () => {
    const r = planEntry({ capitalUsd: 100, price: 200 });
    assert.equal(r.skip, 'insufficient_capital');
    assert.equal(r.dollarBudget, 95);
    assert.equal(r.qty, 0);
  });

  it('respects custom size_pct override', () => {
    const r = planEntry({ capitalUsd: 10000, price: 100, sizePct: 50 });
    assert.equal(r.dollarBudget, 5000);
    assert.equal(r.qty, 50);
    assert.equal(r.dollarsInvested, 5000);
  });

  it('respects custom stop_loss_usd', () => {
    const r = planEntry({ capitalUsd: 10000, price: 100, sizePct: 100, stopLossUsd: 200 });
    // qty=100, invested=10000, stop_pct = 200/10000 = 2%
    assert.equal(r.stopPct, 2);
    assert.equal(r.stopPrice, 98);
  });

  it('uses default $50 stop_loss when not provided', () => {
    const r = planEntry({ capitalUsd: 1000, price: 10 });
    // qty=95 (1000*0.95/10), invested=950, stop_pct = 50/950 = 5.26%
    assert.equal(r.qty, 95);
    assert.equal(r.stopPct, 5.26);
  });

  // ─── 2026-05-28: maxPositionUsd cap ────────────────────────────────────────
  it('caps dollarBudget at maxPositionUsd when set', () => {
    const r = planEntry({ capitalUsd: 10000, price: 100, maxPositionUsd: 1000 });
    assert.equal(r.dollarBudget, 1000);
    assert.equal(r.qty, 10);
  });

  it('does not raise dollarBudget if maxPositionUsd > computed budget', () => {
    const r = planEntry({ capitalUsd: 1000, price: 50, maxPositionUsd: 100000 });
    assert.equal(r.dollarBudget, 950);   // 95% of 1000, NOT 100000
  });

  it('floors fractional maxPositionUsd', () => {
    const r = planEntry({ capitalUsd: 10000, price: 100, maxPositionUsd: 1000.99 });
    assert.equal(r.dollarBudget, 1000);
  });

  it('ignores maxPositionUsd=null', () => {
    const r = planEntry({ capitalUsd: 10000, price: 100, maxPositionUsd: null });
    assert.equal(r.dollarBudget, 9500);
  });

  it('ignores maxPositionUsd<=0', () => {
    assert.equal(planEntry({ capitalUsd: 10000, price: 100, maxPositionUsd: 0    }).dollarBudget, 9500);
    assert.equal(planEntry({ capitalUsd: 10000, price: 100, maxPositionUsd: -500 }).dollarBudget, 9500);
  });

  it('ignores non-finite maxPositionUsd', () => {
    assert.equal(planEntry({ capitalUsd: 10000, price: 100, maxPositionUsd: NaN }).dollarBudget, 9500);
    assert.equal(planEntry({ capitalUsd: 10000, price: 100, maxPositionUsd: 'abc' }).dollarBudget, 9500);
  });
});

// ─── isCircuitBreakerTripped ─────────────────────────────────────────────────
describe('isCircuitBreakerTripped', () => {
  it('false when no losses yet', () => {
    assert.equal(isCircuitBreakerTripped(0,    100), false);
    assert.equal(isCircuitBreakerTripped(50,   100), false);  // up $50, not down
  });

  it('false when losses below limit', () => {
    assert.equal(isCircuitBreakerTripped(-50,  100), false);
    assert.equal(isCircuitBreakerTripped(-99,  100), false);
  });

  it('TRUE when losses exactly hit limit', () => {
    assert.equal(isCircuitBreakerTripped(-100, 100), true);
  });

  it('TRUE when losses exceed limit', () => {
    assert.equal(isCircuitBreakerTripped(-150, 100), true);
  });

  it('false when maxLossUsd is negative (treated as disabled — config-typo safety)', () => {
    // A negative cap is almost certainly a config typo. Safer to treat it as
    // disabled than to "helpfully" abs() it and lock the bot at a value the
    // user didn't actually intend.
    assert.equal(isCircuitBreakerTripped(-150, -100), false);
  });

  it('false when maxLossUsd is 0 or invalid (disabled)', () => {
    assert.equal(isCircuitBreakerTripped(-1000, 0), false);
    assert.equal(isCircuitBreakerTripped(-1000, null), false);
    assert.equal(isCircuitBreakerTripped(-1000, NaN), false);
  });

  it('false when cumulative_pnl is missing/invalid', () => {
    assert.equal(isCircuitBreakerTripped(NaN,  100), false);
    assert.equal(isCircuitBreakerTripped(null, 100), false);
  });
});
