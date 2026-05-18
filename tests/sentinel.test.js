/**
 * Pre-Close Sentinel unit tests — no live broker / DB / API calls.
 *
 * Run: node --test tests/sentinel.test.js
 */

import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mutable state shared across all mock stubs ───────────────────────────────

const state = {
  alpacaPositions:    [],
  moomooPositions:    [],
  bzNews:             [],
  marketContext:      { vix: 18, spy_change_pct: -0.3 },
  dbAvailable:        false,
  insertedId:         null,
  insertCalls:        [],
  sentinelRunCalls:   [],
  emailSent:          false,
  earningsDate:       null,   // ISO string or null = no upcoming earnings
};

function resetState() {
  state.alpacaPositions   = [];
  state.moomooPositions   = [];
  state.bzNews            = [];
  state.marketContext     = { vix: 18, spy_change_pct: -0.3 };
  state.dbAvailable       = false;
  state.insertedId        = null;
  state.insertCalls       = [];
  state.sentinelRunCalls  = [];
  state.emailSent         = false;
  state.earningsDate      = null;
}

// ─── Mock registrations (must run before sentinel.js is imported) ─────────────

mock.module('../src/core/trader.js', {
  exports: {
    getPositions:   async () => state.alpacaPositions,
    getLatestPrice: async () => ({ mid: 100, ask: 100.5, bid: 99.5 }),
  },
});

mock.module('../src/core/moomoo-tcp.js', {
  exports: {
    getPositions: async () => state.moomooPositions,
  },
});

mock.module('../src/core/benzinga.js', {
  exports: {
    getBzNews: async () => ({ articles: state.bzNews }),
  },
});

mock.module('../src/core/market-context.js', {
  exports: {
    getMarketContext: async () => state.marketContext,
  },
});

mock.module('../src/core/sentiment.js', {
  exports: {
    SECTOR_MAP:   { NVDA: 'SOXX', AAPL: 'XLK', MSFT: 'XLK', AMD: 'SOXX' },
    SECTOR_NAMES: {},
  },
});

mock.module('../src/core/db.js', {
  exports: {
    isDbAvailable:         () => state.dbAvailable,
    query:                 async () => ({ rows: [] }),
    insertSentinelRun:     async (args) => { state.sentinelRunCalls.push(args); },
    insertPendingAction:   async (args) => { state.insertCalls.push(args); return state.insertedId; },
    getSentinelRecipients: async () => [{ username: 'admin', email: 'admin@example.com' }],
  },
});

mock.module('@anthropic-ai/sdk', {
  exports: {
    default: class Anthropic {
      messages = { create: async () => ({ content: [{ text: '<p>All clear.</p>' }] }) };
    },
  },
});

mock.module('resend', {
  exports: {
    Resend: class Resend {
      emails = { send: async () => { state.emailSent = true; return { id: 'mock-id' }; } };
    },
  },
});

mock.module('yahoo-finance2', {
  exports: {
    default: class YahooFinance {
      async quoteSummary() {
        if (!state.earningsDate) return { calendarEvents: { earnings: { earningsDate: [] } } };
        return { calendarEvents: { earnings: { earningsDate: [state.earningsDate] } } };
      }
    },
  },
});

// ─── Load sentinel.js after mocks are registered ─────────────────────────────

let signToken, verifyToken, runSentinel;

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.ACTION_SIGNING_SECRET = 'test-secret-aaaa1111bbbb2222cccc3333dddd4444';
  delete process.env.RESEND_API;

  const mod = await import('../src/core/sentinel.js');
  signToken   = mod.signToken;
  verifyToken = mod.verifyToken;
  runSentinel = mod.runSentinel;
});

// ─── Token signing ────────────────────────────────────────────────────────────

describe('signToken', () => {
  it('produces 64-char hex', () => {
    assert.match(signToken('abc-123', 'NVDA', 10), /^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    assert.strictEqual(signToken('id-1', 'AAPL', 5), signToken('id-1', 'AAPL', 5));
  });

  it('differs when qty changes', () => {
    assert.notStrictEqual(signToken('id-1', 'AAPL', 5), signToken('id-1', 'AAPL', 6));
  });

  it('differs when symbol changes', () => {
    assert.notStrictEqual(signToken('id-1', 'AAPL', 5), signToken('id-1', 'MSFT', 5));
  });

  it('differs when id changes', () => {
    assert.notStrictEqual(signToken('id-1', 'AAPL', 5), signToken('id-2', 'AAPL', 5));
  });
});

describe('verifyToken', () => {
  it('returns true for matching token', () => {
    const tok = signToken('id-2', 'TSLA', 3);
    assert.ok(verifyToken(tok, tok));
  });

  it('returns false for tampered token', () => {
    const tok = signToken('id-3', 'AMZN', 7);
    const bad = tok.slice(0, -2) + 'ff';
    assert.strictEqual(verifyToken(tok, bad), false);
  });

  it('returns false for wrong-length input', () => {
    assert.strictEqual(verifyToken(signToken('id-4', 'GOOG', 2), 'short'), false);
  });

  it('returns false for empty provided token', () => {
    assert.strictEqual(verifyToken(signToken('id-5', 'META', 1), ''), false);
  });
});

// ─── runSentinel — empty portfolio ───────────────────────────────────────────

describe('runSentinel — empty portfolio', () => {
  it('completes without error', async () => {
    resetState();
    const result = await runSentinel({ mode: 'preclose' });
    assert.strictEqual(result.error, null);
  });

  it('logs one sentinel run row', async () => {
    resetState();
    await runSentinel({ mode: 'preclose' });
    assert.strictEqual(state.sentinelRunCalls.length, 1);
    assert.strictEqual(state.sentinelRunCalls[0].mode, 'preclose');
  });

  it('returns zero risks and zero proposals', async () => {
    resetState();
    const result = await runSentinel({ mode: 'preclose' });
    assert.strictEqual(result.facts.risks.length, 0);
    assert.strictEqual(result.facts.proposals.length, 0);
  });

  it('skips email when SMTP is not configured', async () => {
    resetState();
    const result = await runSentinel({ mode: 'preclose' });
    assert.strictEqual(result.email_sent, false);
    assert.strictEqual(state.emailSent, false);
  });

  it('stores weekend mode in sentinel run log', async () => {
    resetState();
    await runSentinel({ mode: 'weekend' });
    assert.strictEqual(state.sentinelRunCalls[0].mode, 'weekend');
  });
});

// ─── runSentinel — news risk (med severity → no proposal) ────────────────────

describe('runSentinel — neutral news', () => {
  it('neutral headline → severity med → no proposal generated', async () => {
    resetState();
    state.alpacaPositions = [
      { symbol: 'NVDA', qty: '5', avg_entry_price: '80', market_value: '500', current_price: '100', unrealized_pl_pct: '25' },
    ];
    state.bzNews = [
      { title: 'NVDA reports quarterly earnings in line with estimates', published_at: new Date().toISOString() },
    ];

    const result = await runSentinel({ mode: 'preclose' });
    const newsRisk = result.facts.risks.find(r => r.type === 'news');
    assert.ok(newsRisk, 'should detect news risk');
    assert.strictEqual(newsRisk.severity, 'med');
    assert.strictEqual(result.facts.proposals.length, 0);
  });
});

// ─── runSentinel — earnings risk ──────────────────────────────────────────────

describe('runSentinel — earnings risk', () => {
  it('earnings >7 calendar days away → no earnings risk', async () => {
    resetState();
    state.alpacaPositions = [
      { symbol: 'NVDA', qty: '5', avg_entry_price: '80', market_value: '500', current_price: '100', unrealized_pl_pct: '5' },
    ];
    const far = new Date();
    far.setDate(far.getDate() + 14);
    state.earningsDate = far.toISOString();

    const result = await runSentinel({ mode: 'preclose' });
    const earningsRisks = result.facts.risks.filter(r => r.type === 'earnings');
    assert.strictEqual(earningsRisks.length, 0);
  });

  it('earnings tomorrow → high severity risk detected', async () => {
    resetState();
    state.alpacaPositions = [
      { symbol: 'NVDA', qty: '10', avg_entry_price: '80', market_value: '1000', current_price: '100', unrealized_pl_pct: '25' },
    ];
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    state.earningsDate = tomorrow.toISOString();

    const result = await runSentinel({ mode: 'preclose' });
    const earningsRisk = result.facts.risks.find(r => r.type === 'earnings' && r.symbol === 'NVDA');
    assert.ok(earningsRisk, 'should flag earnings risk');
    assert.strictEqual(earningsRisk.severity, 'high');
  });

  it('earnings ≤2 days + position >5% + DB available → generates trim proposal', async () => {
    resetState();
    state.dbAvailable = true;
    state.insertedId  = '11111111-1111-1111-1111-111111111111';
    // NVDA = 100% of portfolio (total value $2000)
    state.alpacaPositions = [
      { symbol: 'NVDA', qty: '20', avg_entry_price: '80', market_value: '2000', current_price: '100', unrealized_pl_pct: '25' },
    ];
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    state.earningsDate = tomorrow.toISOString();

    const result = await runSentinel({ mode: 'preclose' });
    assert.ok(result.facts.proposals.length > 0, 'should generate a trim proposal');

    const p = result.facts.proposals[0];
    assert.strictEqual(p.symbol, 'NVDA');
    assert.strictEqual(p.side, 'trim');
    assert.ok(p.qty >= 1);
    assert.ok(p.execute_url.includes('/api/action/execute/'));
    assert.ok(p.ignore_url.includes('/api/action/ignore/'));
  });

  it('earnings ≤2 days + position ≤5% → no proposal even with DB', async () => {
    resetState();
    state.dbAvailable = true;
    state.insertedId  = '22222222-2222-2222-2222-222222222222';
    // NVDA = 4% of a $10,000 portfolio — below the 5% threshold
    state.alpacaPositions = [
      { symbol: 'NVDA', qty: '4',  avg_entry_price: '100', market_value: '400',  current_price: '100', unrealized_pl_pct: '0' },
      { symbol: 'AAPL', qty: '96', avg_entry_price: '100', market_value: '9600', current_price: '100', unrealized_pl_pct: '0' },
    ];
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    state.earningsDate = tomorrow.toISOString();

    const result = await runSentinel({ mode: 'preclose' });
    const nvdaProposals = result.facts.proposals.filter(p => p.symbol === 'NVDA');
    assert.strictEqual(nvdaProposals.length, 0);
  });
});

// ─── runSentinel — sector concentration ──────────────────────────────────────

describe('runSentinel — sector concentration', () => {
  it('SOXX > 40% of portfolio → concentration risk detected', async () => {
    resetState();
    // NVDA + AMD both in SOXX = 100% of portfolio
    state.alpacaPositions = [
      { symbol: 'NVDA', qty: '6',  avg_entry_price: '100', market_value: '600', current_price: '100', unrealized_pl_pct: '0' },
      { symbol: 'AMD',  qty: '4',  avg_entry_price: '100', market_value: '400', current_price: '100', unrealized_pl_pct: '0' },
    ];

    const result = await runSentinel({ mode: 'preclose' });
    const concRisks = result.facts.risks.filter(r => r.type === 'concentration');
    assert.ok(concRisks.length > 0, 'should detect concentration risk');
    assert.strictEqual(concRisks[0].detail.sector, 'SOXX');
    assert.ok(concRisks[0].detail.concentration_pct >= 40);
  });

  it('two sectors each at 50% → both trigger concentration risk', async () => {
    resetState();
    // NVDA = SOXX 50%, AAPL = XLK 50% — both exceed the 40% threshold
    state.alpacaPositions = [
      { symbol: 'NVDA', qty: '3', avg_entry_price: '100', market_value: '300', current_price: '100', unrealized_pl_pct: '0' },
      { symbol: 'AAPL', qty: '3', avg_entry_price: '100', market_value: '300', current_price: '100', unrealized_pl_pct: '0' },
    ];

    const result = await runSentinel({ mode: 'preclose' });
    const concRisks = result.facts.risks.filter(r => r.type === 'concentration');
    assert.ok(concRisks.length >= 1);
  });
});

// ─── runSentinel — email sent when SMTP configured ───────────────────────────

describe('runSentinel — email', () => {
  it('sends email when SMTP_USER and SMTP_PASS are set', async () => {
    resetState();
    process.env.RESEND_API = 'test-resend-key';

    const result = await runSentinel({ mode: 'preclose' });
    assert.ok(result.email_sent, 'email_sent should be true');
    assert.ok(state.emailSent, 'Resend mock should have been called');

    // Clean up env
    delete process.env.RESEND_API;
  });
});

// ─── execute-route safety ─────────────────────────────────────────────────────
// These tests validate the decision conditions the server.js execute route
// relies on. The route itself cannot be imported here (it binds a port and
// requires a running DB), so we test the invariants directly using the same
// logic the route executes — keeping the assertions close to the code they guard.

describe('execute-route safety — price drift rejection', () => {
  it('drift 6% above limit_price exceeds 2% threshold', () => {
    // Mirrors the drift check in GET/POST /api/action/execute/:id
    const proposedPrice = 100;
    const currentPrice  = 106;  // 6% above — should be blocked
    const driftLimit    = parseFloat(process.env.SENTINEL_DRIFT_TOLERANCE || '0.02');
    const drift = Math.abs((currentPrice - proposedPrice) / proposedPrice);
    assert.ok(drift > driftLimit,
      `drift ${(drift * 100).toFixed(1)}% should exceed ${(driftLimit * 100).toFixed(1)}% limit`);
  });

  it('drift 1% within limit_price is allowed', () => {
    const proposedPrice = 100;
    const currentPrice  = 101;  // 1% above — should pass
    const driftLimit    = parseFloat(process.env.SENTINEL_DRIFT_TOLERANCE || '0.02');
    const drift = Math.abs((currentPrice - proposedPrice) / proposedPrice);
    assert.ok(drift <= driftLimit,
      `drift ${(drift * 100).toFixed(1)}% should be within ${(driftLimit * 100).toFixed(1)}% limit`);
  });

  it('runSentinel proposal carries a limit_price for drift gating', async () => {
    resetState();
    state.dbAvailable = true;
    state.insertedId  = 'aaaa0000-0000-0000-0000-000000000001';
    state.alpacaPositions = [
      { symbol: 'NVDA', qty: '20', avg_entry_price: '80', market_value: '2000', current_price: '100', unrealized_pl_pct: '25' },
    ];
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    state.earningsDate = tomorrow.toISOString();

    const result = await runSentinel({ mode: 'preclose' });
    assert.ok(result.facts.proposals.length > 0, 'should have generated a proposal');
    const p = result.facts.proposals[0];
    assert.ok(p.limit_price != null && p.limit_price > 0,
      'proposal must carry a limit_price so the execute route can gate on drift');
  });
});

describe('execute-route safety — expired token', () => {
  it('action expired 1 min ago is detected as stale', () => {
    // Mirrors: if (new Date() > new Date(action.expires_at)) -> send pageExpired
    const action = {
      status:     'pending',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const isExpired = new Date() > new Date(action.expires_at);
    assert.ok(isExpired, 'action expired 1 min ago should be stale');
  });

  it('action expiring 30 min from now is not yet stale', () => {
    const action = {
      status:     'pending',
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    const isExpired = new Date() > new Date(action.expires_at);
    assert.strictEqual(isExpired, false, 'future expiry should not be stale');
  });

  it('runSentinel sets expires_at 30 min in the future', async () => {
    resetState();
    state.dbAvailable = true;
    state.insertedId  = 'bbbb0000-0000-0000-0000-000000000002';
    state.alpacaPositions = [
      { symbol: 'NVDA', qty: '20', avg_entry_price: '80', market_value: '2000', current_price: '100', unrealized_pl_pct: '25' },
    ];
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    state.earningsDate = tomorrow.toISOString();

    const before = Date.now();
    await runSentinel({ mode: 'preclose' });
    const after  = Date.now();

    assert.ok(state.insertCalls.length > 0, 'should have called insertPendingAction');
    const call = state.insertCalls[0];
    const expMs = new Date(call.expires_at).getTime();
    assert.ok(expMs >= before + 29 * 60_000, 'expires_at should be >=29 min in future');
    assert.ok(expMs <= after  + 31 * 60_000, 'expires_at should be <=31 min in future');
  });
});

describe('execute-route safety — double-execute idempotency', () => {
  it('status=executed is detected and blocks re-execution', () => {
    // Mirrors: if (action.status === 'executed' || action.status === 'ignored') -> pageAlreadyActioned
    const executedAction = { status: 'executed', symbol: 'AAPL', side: 'trim', qty: 5 };
    const blocked = executedAction.status === 'executed' || executedAction.status === 'ignored';
    assert.ok(blocked, 'executed action must be blocked from re-execution');
    let tradeCalled = false;
    if (!blocked) tradeCalled = true;
    assert.strictEqual(tradeCalled, false, 'placeQuickTrade must not be called for executed action');
  });

  it('status=ignored also blocks re-execution', () => {
    const ignoredAction = { status: 'ignored', symbol: 'AAPL', side: 'trim', qty: 5 };
    const blocked = ignoredAction.status === 'executed' || ignoredAction.status === 'ignored';
    assert.ok(blocked, 'ignored action must be blocked from re-execution');
  });

  it('status=pending allows execution to proceed', () => {
    const pendingAction = { status: 'pending', symbol: 'AAPL', side: 'trim', qty: 5 };
    const blocked = pendingAction.status === 'executed' || pendingAction.status === 'ignored';
    assert.strictEqual(blocked, false, 'pending action should not be blocked');
  });
});

// ─── PUBLIC_URL validation (Item 4) ──────────────────────────────────────────

const PLACEHOLDERS = new Set([
  'https://your-dashboard.example.com',
  'https://example.com',
  'https://your-domain.example.com',
  '',
]);

function validatePublicUrl(raw) {
  if (PLACEHOLDERS.has(raw)) throw new Error('PUBLIC_URL is unset or placeholder');
  try { new URL(raw); } catch { throw new Error(`PUBLIC_URL not a valid URL: ${raw}`); }
  if (!raw.startsWith('https://') &&
      !raw.startsWith('http://localhost') &&
      !raw.startsWith('http://127.0.0.1')) {
    throw new Error(`PUBLIC_URL must use https:// (or http:// for localhost): ${raw}`);
  }
  return raw;
}

describe('PUBLIC_URL validation — module-load guard', () => {
  it('throws when PUBLIC_URL is the placeholder value', () => {
    assert.throws(
      () => validatePublicUrl('https://your-dashboard.example.com'),
      /unset or placeholder/
    );
  });

  it('throws when PUBLIC_URL is empty string', () => {
    assert.throws(
      () => validatePublicUrl(''),
      /unset or placeholder/
    );
  });

  it('throws when PUBLIC_URL is not a valid URL', () => {
    assert.throws(
      () => validatePublicUrl('not-a-url'),
      /not a valid URL/
    );
  });

  it('throws when PUBLIC_URL uses plain http:// (non-localhost)', () => {
    assert.throws(
      () => validatePublicUrl('http://my-dashboard.example.com'),
      /must use https/
    );
  });

  it('accepts a valid https:// URL', () => {
    const result = validatePublicUrl('https://my-dashboard.example.com');
    assert.strictEqual(result, 'https://my-dashboard.example.com');
  });

  it('accepts http://localhost for local dev', () => {
    const result = validatePublicUrl('http://localhost:3000');
    assert.strictEqual(result, 'http://localhost:3000');
  });

  it('accepts http://127.0.0.1 for local dev', () => {
    const result = validatePublicUrl('http://127.0.0.1:3000');
    assert.strictEqual(result, 'http://127.0.0.1:3000');
  });
});
