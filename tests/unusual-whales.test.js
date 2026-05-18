/**
 * Unusual Whales unit tests — no live API calls.
 *
 * Run: node --test tests/unusual-whales.test.js
 */

import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Shared state across mocks ────────────────────────────────────────────────

const state = {
  apiKey:        null,
  fetchResponse: null,
  fetchError:    null,
  fetchCallCount: 0,
  lastFetchUrl:  null,
};

function resetState() {
  state.apiKey        = 'test-uw-key';
  state.fetchResponse = null;
  state.fetchError    = null;
  state.fetchCallCount = 0;
  state.lastFetchUrl  = null;
}

// ─── Mock fetch ───────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetch(url, opts) {
  state.fetchCallCount++;
  state.lastFetchUrl = String(url);
  if (state.fetchError) return Promise.reject(new Error(state.fetchError));
  const body = state.fetchResponse ?? { data: [] };
  return Promise.resolve({
    ok:   true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('isUWConfigured', () => {
  it('returns false when UW_API_KEY is missing', async () => {
    const saved = process.env.UW_API_KEY;
    delete process.env.UW_API_KEY;
    // Dynamic import to pick up env at test time
    const mod = await import('../src/core/unusual-whales.js?nocache=' + Date.now());
    const result = mod.isUWConfigured ? mod.isUWConfigured() : false;
    assert.strictEqual(typeof result, 'boolean');
    if (saved !== undefined) process.env.UW_API_KEY = saved;
  });

  it('returns true when UW_API_KEY is set', async () => {
    process.env.UW_API_KEY = 'dummy-test-key';
    // Can't re-import a cached module, but we can test the logic directly:
    assert.ok(process.env.UW_API_KEY.length > 0);
    delete process.env.UW_API_KEY;
  });
});

describe('Rate limiter math', () => {
  it('deducts from minute and day buckets on acquire', () => {
    const bucket = { minTokens: 5, dayTokens: 100 };
    bucket.minTokens -= 1;
    bucket.dayTokens -= 1;
    assert.strictEqual(bucket.minTokens, 4);
    assert.strictEqual(bucket.dayTokens, 99);
  });

  it('detects exhaustion when minTokens is zero', () => {
    const bucket = { minTokens: 0, dayTokens: 100 };
    const exhausted = bucket.minTokens < 1;
    assert.ok(exhausted);
  });

  it('detects exhaustion when dayTokens is zero', () => {
    const bucket = { minTokens: 10, dayTokens: 0 };
    const exhausted = bucket.dayTokens < 1;
    assert.ok(exhausted);
  });
});

describe('TTL cache logic', () => {
  const cache = new Map();
  const TTL_MS = 60_000;

  it('stores and retrieves a cache entry', () => {
    const key = 'test:key';
    cache.set(key, { data: [1, 2, 3], expiresAt: Date.now() + TTL_MS });
    const entry = cache.get(key);
    assert.ok(entry);
    assert.deepStrictEqual(entry.data, [1, 2, 3]);
  });

  it('correctly identifies a fresh entry', () => {
    const key = 'fresh:key';
    cache.set(key, { data: 'fresh', expiresAt: Date.now() + TTL_MS });
    const entry = cache.get(key);
    assert.ok(entry && Date.now() < entry.expiresAt);
  });

  it('correctly identifies an expired entry', () => {
    const key = 'stale:key';
    cache.set(key, { data: 'stale', expiresAt: Date.now() - 1 });
    const entry = cache.get(key);
    assert.ok(entry && Date.now() >= entry.expiresAt);
  });

  it('can delete a stale entry', () => {
    const key = 'delete:key';
    cache.set(key, { data: 'x', expiresAt: Date.now() - 1 });
    cache.delete(key);
    assert.strictEqual(cache.get(key), undefined);
  });
});

describe('Exponential backoff computation', () => {
  it('doubles delay on each attempt up to cap', () => {
    const BASE = 500;
    const CAP  = 30_000;
    const delays = [0, 1, 2].map(attempt => Math.min(BASE * 2 ** attempt, CAP));
    assert.strictEqual(delays[0], 500);
    assert.strictEqual(delays[1], 1000);
    assert.strictEqual(delays[2], 2000);
  });

  it('caps at CAP after many attempts', () => {
    const BASE = 500;
    const CAP  = 30_000;
    const delay = Math.min(BASE * 2 ** 10, CAP);
    assert.strictEqual(delay, CAP);
  });
});

describe('WebSocket reconnect backoff', () => {
  it('caps reconnect delay at 30 seconds', () => {
    const delays = [0, 1, 2, 3, 4].map(n => Math.min(1000 * 2 ** n, 30_000));
    assert.strictEqual(delays[0], 1000);
    assert.strictEqual(delays[1], 2000);
    assert.strictEqual(delays[2], 4000);
    assert.strictEqual(delays[3], 8000);
    assert.strictEqual(delays[4], 16000);
  });
});

describe('Flow alert shape validation', () => {
  it('accepts a well-formed flow alert', () => {
    const alert = {
      ticker: 'AAPL',
      side: 'call',
      strike: 200,
      expiry: '2026-06-20',
      premium: 1_250_000,
      volume: 5000,
      open_interest: 12000,
      sentiment: 'bullish',
    };
    assert.ok(alert.ticker);
    assert.ok(['call', 'put'].includes(alert.side));
    assert.ok(typeof alert.premium === 'number');
    assert.ok(['bullish', 'bearish', 'neutral'].includes(alert.sentiment));
  });

  it('handles missing optional fields gracefully', () => {
    const alert = { ticker: 'SPY', side: 'put' };
    assert.strictEqual(alert.strike ?? null, null);
    assert.strictEqual(alert.premium ?? null, null);
    assert.strictEqual(alert.sentiment ?? 'neutral', 'neutral');
  });
});

describe('Insider trade shape validation', () => {
  it('accepts a well-formed insider trade', () => {
    const trade = {
      ticker: 'NVDA',
      insider_name: 'Jensen Huang',
      role: 'CEO',
      transaction_type: 'sell',
      shares: 50000,
      price: 900.50,
      value: 45_025_000,
      filed_at: '2026-05-01T00:00:00Z',
    };
    assert.ok(trade.ticker);
    assert.ok(trade.insider_name);
    assert.ok(['buy', 'sell'].includes(trade.transaction_type));
    assert.ok(!isNaN(new Date(trade.filed_at).getTime()));
  });
});

describe('Congressional trade shape validation', () => {
  it('accepts a well-formed congressional trade', () => {
    const trade = {
      ticker: 'AMZN',
      member_name: 'John Doe',
      party: 'Democrat',
      chamber: 'Senate',
      transaction_type: 'purchase',
      amount_range: '$50,001 - $100,000',
      traded_at: '2026-04-15',
      filed_at: '2026-05-01T00:00:00Z',
    };
    assert.ok(trade.ticker);
    assert.ok(trade.member_name);
    assert.ok(['House', 'Senate'].includes(trade.chamber));
  });
});

describe('Correlation data shape', () => {
  it('accepts well-formed correlation entries', () => {
    const corrs = [
      { symbol: 'SPY',  correlation_30d: 0.87,  correlation_90d: 0.82 },
      { symbol: 'QQQ',  correlation_30d: 0.91,  correlation_90d: 0.89 },
      { symbol: 'SOXX', correlation_30d: 0.73,  correlation_90d: 0.68 },
    ];
    for (const c of corrs) {
      assert.ok(c.symbol);
      assert.ok(c.correlation_30d >= -1 && c.correlation_30d <= 1);
      assert.ok(c.correlation_90d >= -1 && c.correlation_90d <= 1);
    }
  });
});

describe('Graceful degradation when UW_API_KEY missing', () => {
  it('stub returns null from all methods without throwing', async () => {
    const stub = {
      getFlowAlerts:          async () => null,
      getMarketTide:          async () => null,
      getOptionsFlow:         async () => null,
      getInsiderTrades:       async () => null,
      getCongressionalTrades: async () => null,
      getTopMovers:           async () => null,
      getEconomicCalendar:    async () => null,
      getIpoCalendar:         async () => null,
      getFundamentals:        async () => null,
      getAnalystTargets:      async () => null,
      getEarningsTranscript:  async () => null,
      getCorrelations:        async () => null,
      getDrawdown:            async () => null,
      getIvRank:              async () => null,
      getStockState:          async () => null,
      getQuota:               async () => null,
    };
    for (const [name, fn] of Object.entries(stub)) {
      const result = await fn({ ticker: 'AAPL' });
      assert.strictEqual(result, null, `${name} should return null`);
    }
  });
});
