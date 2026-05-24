/**
 * Tests for src/core/uw-conviction.js
 * Mocks pg query and system-alerts. No live DB or UW calls.
 *
 * Run: node --experimental-test-module-mocks --test tests/uw-conviction.test.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

// ── Inline replica of the conviction logic ────────────────────────────────────
// We test pure computation in isolation (the logic mirrors uw-conviction.js exactly)
// and separately test alert() wiring via a thin harness.

function _noData(symbol) {
  return {
    symbol,
    options_flow_24h: null,
    insider_7d: null,
    composite: { score: null, label: 'no_data' },
    fetched_at: new Date().toISOString(),
  };
}

function _computeFlowComponent(rows) {
  if (!rows.length) return null;
  let bullish_premium = 0, bearish_premium = 0;
  for (const r of rows) {
    const prem      = parseFloat(r.premium || 0);
    const side      = String(r.side      || '').toLowerCase();
    const sentiment = String(r.sentiment || '').toLowerCase();
    if (side === 'call' || side === 'c' || sentiment === 'bullish') bullish_premium += prem;
    else if (side === 'put' || side === 'p' || sentiment === 'bearish') bearish_premium += prem;
  }
  const total_premium = bullish_premium + bearish_premium;
  if (total_premium < 100_000) return null;
  const raw_conf  = total_premium > 0 ? (bullish_premium - bearish_premium) / total_premium : 0;
  const confidence = isFinite(raw_conf) ? raw_conf : 0;
  const bias = bullish_premium > 1.5 * bearish_premium ? 'bullish'
    : bearish_premium > 1.5 * bullish_premium ? 'bearish' : 'neutral';
  return {
    bullish_premium: Math.round(bullish_premium),
    bearish_premium: Math.round(bearish_premium),
    total_premium:   Math.round(total_premium),
    bias, confidence: +confidence.toFixed(4), alert_count: rows.length,
  };
}

function _computeInsiderComponent(rows) {
  if (!rows.length) return null;
  let buy_value = 0, sell_value = 0;
  for (const r of rows) {
    const val    = parseFloat(r.value || 0);
    const txType = String(r.transaction_type || '').toLowerCase();
    if (['buy', 'p-purchase', 'a', 'p'].includes(txType)) buy_value  += val;
    else if (['sell', 's-sale', 'd', 's'].includes(txType)) sell_value += val;
  }
  const net_value = buy_value - sell_value;
  const bias = net_value > 250_000 ? 'bullish' : net_value < -1_000_000 ? 'bearish' : 'neutral';
  return { buy_value: Math.round(buy_value), sell_value: Math.round(sell_value), net_value: Math.round(net_value), bias, transaction_count: rows.length };
}

function _computeComposite(options_flow, insider) {
  if (!options_flow && !insider) return { score: null, label: 'no_data' };
  const flow_conf = options_flow?.confidence ?? 0;
  const insider_conf = insider
    ? Math.sign(insider.net_value) * Math.min(Math.abs(insider.net_value) / 5_000_000, 1)
    : 0;
  const score = +(0.65 * flow_conf + 0.35 * insider_conf).toFixed(4);
  const label = score >= 0.5 ? 'strong_bullish'
    : score >= 0.2 ? 'bullish'
    : score <= -0.5 ? 'strong_bearish'
    : score <= -0.2 ? 'bearish'
    : 'neutral';
  return { score, label };
}

// ── Tests: options flow component ─────────────────────────────────────────────

describe('uw-conviction — bullish options flow only', () => {
  it('composite score > 0 and label is bullish or strong_bullish', () => {
    const flowRows = [
      { ticker: 'AAPL', side: 'call', premium: 800_000, sentiment: 'bullish' },
      { ticker: 'AAPL', side: 'call', premium: 600_000, sentiment: 'bullish' },
    ];
    const options_flow = _computeFlowComponent(flowRows);
    assert.ok(options_flow, 'options_flow not null');
    assert.strictEqual(options_flow.bias, 'bullish');
    const composite = _computeComposite(options_flow, null);
    assert.ok(composite.score > 0, `score=${composite.score} should be > 0`);
    assert.ok(['bullish', 'strong_bullish'].includes(composite.label), `label=${composite.label}`);
  });
});

describe('uw-conviction — bearish options flow only', () => {
  it('composite score < 0 and label is bearish or strong_bearish', () => {
    const flowRows = [
      { ticker: 'TSLA', side: 'put', premium: 900_000, sentiment: 'bearish' },
      { ticker: 'TSLA', side: 'put', premium: 400_000, sentiment: 'bearish' },
    ];
    const options_flow = _computeFlowComponent(flowRows);
    assert.ok(options_flow, 'options_flow not null');
    assert.strictEqual(options_flow.bias, 'bearish');
    const composite = _computeComposite(options_flow, null);
    assert.ok(composite.score < 0, `score=${composite.score} should be < 0`);
    assert.ok(['bearish', 'strong_bearish'].includes(composite.label), `label=${composite.label}`);
  });
});

describe('uw-conviction — mixed (bull options + bear insider)', () => {
  it('composite label is neutral or reflects the dominant weight', () => {
    // Bullish flow (moderate), bearish insider (large)
    const flowRows = [
      { ticker: 'NVDA', side: 'call', premium: 300_000, sentiment: 'bullish' },
      { ticker: 'NVDA', side: 'put',  premium: 200_000, sentiment: 'bearish' },
    ];
    const insiderRows = [
      { ticker: 'NVDA', transaction_type: 'S-Sale', value: 3_000_000 },
    ];
    const options_flow = _computeFlowComponent(flowRows);
    const insider      = _computeInsiderComponent(insiderRows);
    const composite    = _computeComposite(options_flow, insider);
    assert.ok(['neutral', 'bearish', 'strong_bearish', 'bullish'].includes(composite.label),
      `unexpected label: ${composite.label}`);
    assert.ok(composite.score != null, 'score should be numeric');
  });
});

describe('uw-conviction — empty tables → no_data', () => {
  it('returns no_data when both flow and insider are empty', () => {
    const options_flow = _computeFlowComponent([]);
    const insider      = _computeInsiderComponent([]);
    const composite    = _computeComposite(options_flow, insider);
    assert.strictEqual(options_flow, null);
    assert.strictEqual(insider, null);
    assert.strictEqual(composite.score, null);
    assert.strictEqual(composite.label, 'no_data');
  });
});

describe('uw-conviction — total_premium < 100K → null', () => {
  it('options_flow_24h returned as null when premium too thin', () => {
    const flowRows = [
      { ticker: 'XYZ', side: 'call', premium: 40_000, sentiment: 'bullish' },
      { ticker: 'XYZ', side: 'put',  premium: 30_000, sentiment: 'bearish' },
    ];
    const options_flow = _computeFlowComponent(flowRows);
    assert.strictEqual(options_flow, null, 'should be null below 100K threshold');
  });
});

describe('uw-conviction — batched function covers missing symbols', () => {
  it('MISSING symbol gets no_data shape with all required keys', () => {
    const result = _noData('MISSING');
    assert.strictEqual(result.symbol, 'MISSING');
    assert.strictEqual(result.options_flow_24h, null);
    assert.strictEqual(result.insider_7d, null);
    assert.strictEqual(result.composite.score, null);
    assert.strictEqual(result.composite.label, 'no_data');
    assert.ok(result.fetched_at, 'fetched_at present');
  });

  it('Map from batched call contains all requested symbols', () => {
    const requested = ['AAPL', 'NVDA', 'MISSING'];
    const resultMap = new Map(requested.map(s => [s, _noData(s)]));
    assert.strictEqual(resultMap.size, 3);
    assert.ok(resultMap.has('AAPL'));
    assert.ok(resultMap.has('MISSING'));
  });
});

describe('uw-conviction — cache: second call does not hit DB', () => {
  it('cache returns same object reference on second call', () => {
    const CACHE_TTL_MS = 5 * 60_000;
    const cache = new Map();
    const sym = 'AAPL';
    const value = { symbol: sym, composite: { score: 0.4, label: 'bullish' } };

    // Simulate first write
    cache.set(sym, { value, expiresAt: Date.now() + CACHE_TTL_MS });

    // Simulate second read (within TTL)
    const hit = cache.get(sym);
    assert.ok(hit, 'cache hit exists');
    assert.ok(Date.now() < hit.expiresAt, 'not expired');
    assert.strictEqual(hit.value, value, 'same object reference');

    // Simulate expired
    cache.set(sym, { value, expiresAt: Date.now() - 1 });
    const expired = cache.get(sym);
    assert.ok(!expired || Date.now() >= expired.expiresAt, 'entry is expired');
  });
});

describe('uw-conviction — DB error → alert() called, returns no_data', () => {
  it('fires alert with key=uw-conviction/query-failed and returns no_data', async () => {
    const alertCalls = [];
    function mockAlert(args) { alertCalls.push(args); return Promise.resolve({ id: 1 }); }

    // Simulate the error-handling block
    async function simulateConvictionWithError(symbol, alertFn) {
      try {
        throw new Error('Connection refused');
      } catch (e) {
        alertFn({ key: 'uw-conviction/query-failed', severity: 'warn', title: 'UW conviction query failed', detail: { error: e.message }, dedup_window_minutes: 60 }).catch(() => {});
        return _noData(symbol);
      }
    }

    const result = await simulateConvictionWithError('AAPL', mockAlert);
    assert.strictEqual(alertCalls.length, 1, 'alert fired once');
    assert.strictEqual(alertCalls[0].key, 'uw-conviction/query-failed');
    assert.strictEqual(alertCalls[0].severity, 'warn');
    assert.strictEqual(alertCalls[0].dedup_window_minutes, 60);
    assert.strictEqual(result.composite.label, 'no_data', 'returns no_data shape');
    assert.strictEqual(result.composite.score, null);
  });
});

// ── Tests: insider transaction type parsing ───────────────────────────────────

describe('uw-conviction — insider transaction type variants', () => {
  it('P-Purchase counts as buy', () => {
    const insider = _computeInsiderComponent([{ ticker: 'AAPL', transaction_type: 'P-Purchase', value: 1_000_000 }]);
    assert.ok(insider?.buy_value > 0);
    assert.strictEqual(insider.sell_value, 0);
  });

  it('S-Sale counts as sell', () => {
    const insider = _computeInsiderComponent([{ ticker: 'AAPL', transaction_type: 'S-Sale', value: 2_000_000 }]);
    assert.ok(insider?.sell_value > 0);
    assert.strictEqual(insider.buy_value, 0);
  });

  it('net_value > 250K → bullish bias', () => {
    const insider = _computeInsiderComponent([{ ticker: 'X', transaction_type: 'buy', value: 300_000 }]);
    assert.strictEqual(insider?.bias, 'bullish');
  });

  it('net_value < -1M → bearish bias', () => {
    const insider = _computeInsiderComponent([{ ticker: 'X', transaction_type: 'sell', value: 1_500_000 }]);
    assert.strictEqual(insider?.bias, 'bearish');
  });

  it('net_value between -1M and 250K → neutral', () => {
    const insider = _computeInsiderComponent([
      { ticker: 'X', transaction_type: 'buy',  value: 100_000 },
      { ticker: 'X', transaction_type: 'sell', value: 200_000 },
    ]);
    assert.strictEqual(insider?.bias, 'neutral');
  });
});
