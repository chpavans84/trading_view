/**
 * Regression tests for the insider candidate quality gate (2026-07-24).
 *
 * THE BUG IT REPLACES: bot 4 (insider_director_cluster only) went 7 days with ZERO picks. The
 * rule found 8-9 valid insider cluster-buys every scan, but the S&P500/NDX100 `index_only`
 * filter dropped all of them (`8 → 0`). Backtest showed the insider edge lives OFF-index in
 * mid/small caps (+11.4% excess vs SPY @20d) — index-only left n=13 signals in 2.5y at −1.0%
 * excess. The quality gate keeps the mid/small edge while excluding the "junk" the index filter
 * was meant to remove: funds/CEFs/BDCs, sub-$5 names, and illiquid (<$3M ADV) names.
 *
 * These lock the classification: liquid operating companies KEPT, junk DROPPED with a reason.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { classifyForGate } from '../src/core/bot-advance/entry-rules.js';

const m = (last_price, adv_dollar_30d, industry) => ({ last_price, adv_dollar_30d, industry });

describe('classifyForGate — KEEP liquid operating companies (null = keep)', () => {
  test('ENR — mid-cap, liquid → kept', () => {
    assert.equal(classifyForGate(m(20.65, 20_690_000, 'Electrical Equipment & Parts')), null);
  });
  test('NTSK — $4.5B, very liquid → kept', () => {
    assert.equal(classifyForGate(m(11.17, 66_070_000, 'Software - Infrastructure')), null);
  });
  test('ARTV — small biotech but >$5 and >$3M ADV → kept', () => {
    assert.equal(classifyForGate(m(10.13, 5_960_000, 'Biotechnology')), null);
  });
  test('null industry does not by itself drop a name', () => {
    assert.equal(classifyForGate(m(12, 10_000_000, null)), null);
  });
});

describe('classifyForGate — DROP the junk the index filter was meant to exclude', () => {
  test('TYG — closed-end fund (industry Asset Management) → fund', () => {
    assert.equal(classifyForGate(m(44.98, 8_180_000, 'Asset Management')), 'fund');
  });
  test('PSBD — BDC → fund (fund check precedes price/liquidity)', () => {
    assert.equal(classifyForGate(m(9.45, 1_460_000, 'Asset Management')), 'fund');
  });
  test('FULC — sub-$5 → price', () => {
    assert.equal(classifyForGate(m(3.76, 5_790_000, 'Biotechnology')), 'price<5');
  });
  test('BOLD — sub-$5 micro-cap → price', () => {
    assert.equal(classifyForGate(m(2.52, 310_000, 'Biotechnology')), 'price<5');
  });
  test('HDSN — >$5 but ADV below threshold → adv (fail-closed)', () => {
    assert.equal(classifyForGate(m(6.33, 1_000_000, 'Specialty Chemicals')), 'adv<3M');
  });
  test('null ADV is treated as illiquid, not passed silently', () => {
    assert.equal(classifyForGate(m(6.33, null, 'Specialty Chemicals')), 'adv<3M');
  });
  test('missing universe row → not_in_universe (fail-closed)', () => {
    assert.equal(classifyForGate(undefined), 'not_in_universe');
    assert.equal(classifyForGate(null), 'not_in_universe');
  });
});

describe('classifyForGate — thresholds are configurable', () => {
  test('lowering min_price keeps a $3.76 name', () => {
    assert.equal(classifyForGate(m(3.76, 5_790_000, 'Biotechnology'), { minPrice: 3 }), null);
  });
  test('raising min_adv_usd drops a $5.9M-ADV name', () => {
    assert.equal(classifyForGate(m(10.13, 5_960_000, 'Biotechnology'), { minAdvUsd: 10_000_000 }), 'adv<10M');
  });
  test('custom exclude_industries can drop e.g. Biotechnology', () => {
    assert.equal(classifyForGate(m(10.13, 5_960_000, 'Biotechnology'), { excludeIndustries: ['Biotechnology'] }), 'fund');
  });
  test('empty exclude list lets a fund through the industry check (then price/adv apply)', () => {
    // Asset Management name with good price/liquidity, funds-exclusion disabled → kept.
    assert.equal(classifyForGate(m(44.98, 8_180_000, 'Asset Management'), { excludeIndustries: [] }), null);
  });
});

describe('the exact 2026-07-24 blocked-candidate set resolves correctly', () => {
  test('9 blocked candidates → keep ENR/NTSK/ARTV, drop the rest', () => {
    const cands = {
      TYG:  m(44.98, 8_180_000, 'Asset Management'),
      ENR:  m(20.65, 20_690_000, 'Electrical Equipment & Parts'),
      HDSN: m(6.33, null, 'Specialty Chemicals'),
      NTSK: m(11.17, 66_070_000, 'Software - Infrastructure'),
      ARTV: m(10.13, 5_960_000, 'Biotechnology'),
      PSBD: m(9.45, 1_460_000, 'Asset Management'),
      FULC: m(3.76, 5_790_000, 'Biotechnology'),
      BOLD: m(2.52, 310_000, 'Biotechnology'),
      MXF:  m(21.15, 1_120_000, 'Asset Management'),
    };
    const kept = Object.entries(cands).filter(([, meta]) => classifyForGate(meta) === null).map(([t]) => t);
    assert.deepEqual(kept.sort(), ['ARTV', 'ENR', 'NTSK']);
  });
});
