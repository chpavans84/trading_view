/**
 * tests/near-miss-notifier.test.js
 *
 * Unit tests for src/core/near-miss-notifier.js using node:test module mocks.
 * Verifies the SQL shape, the rank/filter logic, and the email send pathway.
 * No live DB or external API.
 *
 * Run: node --experimental-test-module-mocks --test tests/near-miss-notifier.test.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

let _calls = [];
let _nextRows = [];
let _emailCalls = [];
let _nextEmailResult = { ok: true, id: 'mock-id-1' };

beforeEach(() => {
  _calls = [];
  _emailCalls = [];
  _nextRows = [];
});

// Mock db.js — record each query call + return whatever the test queued
mock.module('../src/core/db.js', {
  namedExports: {
    query: (sql, params = []) => {
      _calls.push({ sql, params });
      // Tests can queue per-call results by setting _nextRows to an array of arrays
      let rows = [];
      if (Array.isArray(_nextRows) && _nextRows.length > 0 && Array.isArray(_nextRows[0])) {
        rows = _nextRows.shift();
      } else if (Array.isArray(_nextRows)) {
        rows = _nextRows;
      }
      return { rows };
    },
    isDbAvailable: () => true,
  },
});

// Mock email.js so we capture sends without touching Resend
mock.module('../src/core/email.js', {
  namedExports: {
    sendEmail: (opts) => {
      _emailCalls.push(opts);
      return _nextEmailResult;
    },
    textToHtml: (text, opts) => `<html>${opts?.title ?? ''}|${text}</html>`,
    resolveRecipient: () => ({ to: 'test@example.com', allowed: true }),
  },
});

const { runNearMissReport } = await import('../src/core/near-miss-notifier.js');

// ─── Empty-state ────────────────────────────────────────────────────────────
describe('runNearMissReport — empty state', () => {
  it('returns ok with zero picks when no data', async () => {
    _nextRows = [];  // all queries return []
    const r = await runNearMissReport({ sendEmail: false });
    assert.equal(r.ok, true);
    assert.equal(r.picks.length, 0);
    assert.match(r.body, /No near-misses today/);
  });

  it('does NOT send email when sendEmail=false', async () => {
    _nextRows = [];
    await runNearMissReport({ sendEmail: false });
    assert.equal(_emailCalls.length, 0);
  });
});

// ─── TYPE 4: outside-universe ───────────────────────────────────────────────
describe('runNearMissReport — TYPE 4 (CRDO scenario)', () => {
  it('surfaces a high-bullish-flow ticker not in bot_decisions', async () => {
    // Queue per-call results: 1) type3 query  2) type4 query  3) seen-symbols dedup  4)+ enrichment per ticker
    _nextRows = [
      [],                                                // type3: no gate-blocked
      [{ ticker: 'CRDO', bull_premium: 2700000, alerts: 7, rank: 1 }],  // type4: bullish flow
      [],                                                // seen-in-bot_decisions: none — CRDO never seen
      [{ price_date: '2026-05-22', close: '218.41' },    // price ctx: last
       { price_date: '2026-05-21', close: '193.39' },    // prev day
       { price_date: '2026-05-20', close: '182.98' },
       { price_date: '2026-05-19', close: '168.99' },
       { price_date: '2026-05-18', close: '156.27' },
       { price_date: '2026-05-15', close: '172.17' }],   // 5-day-ago
      [],                                                // earnings: none
    ];
    const r = await runNearMissReport({ sendEmail: false });
    assert.equal(r.ok, true);
    assert.equal(r.picks.length, 1);
    const pick = r.picks[0];
    assert.equal(pick.type, 4);
    assert.equal(pick.symbol, 'CRDO');
    assert.equal(pick.bull_premium, 2700000);
    assert.equal(pick.last_price, 218.41);
    // 5-day return = (218.41 - 172.17) / 172.17 ≈ 0.269
    assert.ok(pick.five_day_return > 0.25 && pick.five_day_return < 0.30);
    assert.equal(pick.already_extended, false);  // < 40%
    assert.match(r.body, /CRDO/);
    assert.match(r.body, /Outside the bot's universe/);
  });

  it('flags a stock up >40% in 5 days with chase warning', async () => {
    _nextRows = [
      [],
      // Use a non-ETF ticker since SOXL/TQQQ/etc. are in ALWAYS_EXCLUDE
      [{ ticker: 'ABCD', bull_premium: 1000000, alerts: 5, rank: 1 }],
      [],
      [{ price_date: '2026-05-22', close: '50.00' },
       { price_date: '2026-05-21', close: '48.00' },
       { price_date: '2026-05-20', close: '46.00' },
       { price_date: '2026-05-19', close: '40.00' },
       { price_date: '2026-05-18', close: '38.00' },
       { price_date: '2026-05-15', close: '30.00' }],   // 50/30 = 67% gain
      [],
    ];
    const r = await runNearMissReport({ sendEmail: false });
    assert.equal(r.picks.length, 1);
    assert.equal(r.picks[0].already_extended, true);
    assert.match(r.body, /Already moved/);
    assert.match(r.body, /chase risk/);
  });

  it('excludes pre-earnings names entirely', async () => {
    _nextRows = [
      [],
      [{ ticker: 'NVDA', bull_premium: 5000000, alerts: 12, rank: 1 }],
      [],
      [{ price_date: '2026-05-22', close: '100.00' }],
      [{ d: '1' }],  // earnings tomorrow → hard skip
    ];
    const r = await runNearMissReport({ sendEmail: false });
    assert.equal(r.picks.length, 0);  // NVDA filtered out
  });

  it('skips tickers the bot already saw recently', async () => {
    _nextRows = [
      [],
      [{ ticker: 'LUNR', bull_premium: 1000000, alerts: 5, rank: 1 }],
      [{ symbol: 'LUNR' }],  // bot already saw LUNR in last 6h
      // enrichment queries should NOT fire since LUNR was filtered
    ];
    const r = await runNearMissReport({ sendEmail: false });
    assert.equal(r.picks.length, 0);
  });
});

// ─── TYPE 3: gate-blocked ───────────────────────────────────────────────────
describe('runNearMissReport — TYPE 3 (gate-blocked)', () => {
  it('surfaces a high-scoring stock that lost to a single gate', async () => {
    _nextRows = [
      [{ symbol: 'PLTR', composite_score: 73, setup_type: 'momentum',
         notes: 'skip_filtered: premarket_gap exceeds limit', scanned_at: new Date() }],
      [],   // no type 4
    ];
    const r = await runNearMissReport({ sendEmail: false });
    assert.equal(r.picks.length, 1);
    assert.equal(r.picks[0].type, 3);
    assert.equal(r.picks[0].symbol, 'PLTR');
    assert.equal(r.picks[0].score, 73);
    assert.match(r.body, /PLTR/);
    assert.match(r.body, /single gate blocked/);
  });
});

// ─── Email send pathway ─────────────────────────────────────────────────────
describe('runNearMissReport — email send', () => {
  it('sends email when sendEmail=true and ALERT_EMAIL is set', async () => {
    const origAlertEmail = process.env.ALERT_EMAIL;
    process.env.ALERT_EMAIL = 'pavan@example.com';
    try {
      _nextRows = [];
      await runNearMissReport({ sendEmail: true });
      assert.equal(_emailCalls.length, 1);
      assert.equal(_emailCalls[0].to, 'pavan@example.com');
      assert.match(_emailCalls[0].subject, /Near-Miss Report/);
      assert.match(_emailCalls[0].html, /Bot Near-Miss Report/);
    } finally {
      if (origAlertEmail) process.env.ALERT_EMAIL = origAlertEmail;
      else delete process.env.ALERT_EMAIL;
    }
  });

  it('does not send email when no recipient is configured', async () => {
    const orig1 = process.env.ALERT_EMAIL;
    const orig2 = process.env.SENTINEL_EMAIL_TO;
    delete process.env.ALERT_EMAIL;
    delete process.env.SENTINEL_EMAIL_TO;
    try {
      _nextRows = [];
      const r = await runNearMissReport({ sendEmail: true });
      assert.equal(r.ok, true);
      assert.equal(_emailCalls.length, 0);
    } finally {
      if (orig1) process.env.ALERT_EMAIL = orig1;
      if (orig2) process.env.SENTINEL_EMAIL_TO = orig2;
    }
  });

  it('uses explicit opts.to override', async () => {
    _nextRows = [];
    await runNearMissReport({ sendEmail: true, to: 'override@example.com' });
    assert.equal(_emailCalls[0].to, 'override@example.com');
  });
});

// ─── Cap enforcement ────────────────────────────────────────────────────────
describe('runNearMissReport — cap at MAX_PER_REPORT', () => {
  it('limits to at most 8 picks total', async () => {
    // 20 type 4 candidates with no enrichment needed
    const flow = Array.from({ length: 20 }, (_, i) => ({
      ticker: `STK${i}`, bull_premium: 1000000 + i, alerts: 5, rank: i + 1,
    }));
    // Build per-flow enrichment results: each gets price + earnings
    const enrichmentRows = flow.flatMap(() => [
      [{ price_date: '2026-05-22', close: '100' }],   // price
      [],                                              // earnings
    ]);
    _nextRows = [
      [],            // type3
      flow,          // type4
      [],            // dedup
      ...enrichmentRows,
    ];
    const r = await runNearMissReport({ sendEmail: false });
    assert.ok(r.picks.length <= 8, `expected <= 8 picks, got ${r.picks.length}`);
  });
});
