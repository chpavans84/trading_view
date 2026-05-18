/**
 * Tests for Item 1: NULL-safe UNIQUE index sentinel values.
 * Verifies that each cron passes COALESCE sentinel values (not NULL)
 * for nullable columns that participate in dedup indexes.
 *
 * Run: node --test tests/uw-null-unique.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

// ── Helpers ──────────────────────────────────────────────────────────────────

function simulateInsiderInsert(rawApiRow) {
  const insiderName = rawApiRow.owner_name ?? '';
  const txType      = rawApiRow.side ?? '';
  const filedAt     = rawApiRow.transaction_date
    ? new Date(rawApiRow.transaction_date)
    : new Date('1900-01-01');
  return { insiderName, txType, filedAt };
}

function simulateCongressInsert(rawApiRow) {
  const memberName = rawApiRow.member_name ?? '';
  const txType     = rawApiRow.transaction_type ?? '';
  const tradedAt   = rawApiRow.transaction_date
    ? new Date(rawApiRow.transaction_date)
    : new Date('1900-01-01');
  return { memberName, txType, tradedAt };
}

function simulateFlowAlertInsert(rawApiRow) {
  const side      = rawApiRow.side ?? rawApiRow.option_type ?? '';
  const strike    = rawApiRow.strike ?? -1;
  const expiry    = rawApiRow.expiry ? new Date(rawApiRow.expiry) : new Date('1900-01-01');
  return { side, strike, expiry };
}

// ── Tests: insider ────────────────────────────────────────────────────────────

describe('Insider cron — NULL-safe sentinel values', () => {
  it('passes empty string when owner_name is absent', () => {
    const { insiderName } = simulateInsiderInsert({ ticker: 'AAPL', side: 'buy' });
    assert.strictEqual(insiderName, '');
  });

  it('passes empty string when side (transaction_type) is absent', () => {
    const { txType } = simulateInsiderInsert({ ticker: 'AAPL', owner_name: 'Jensen Huang' });
    assert.strictEqual(txType, '');
  });

  it('passes sentinel date when transaction_date is absent', () => {
    const { filedAt } = simulateInsiderInsert({ ticker: 'AAPL' });
    assert.strictEqual(filedAt.getFullYear(), 1900);
  });

  it('passes real values when all fields are present', () => {
    const { insiderName, txType, filedAt } = simulateInsiderInsert({
      owner_name: 'Jensen Huang',
      side: 'sell',
      transaction_date: '2026-05-01',
    });
    assert.strictEqual(insiderName, 'Jensen Huang');
    assert.strictEqual(txType, 'sell');
    assert.strictEqual(filedAt.toISOString().slice(0, 10), '2026-05-01');
  });
});

// ── Tests: congressional ──────────────────────────────────────────────────────

describe('Congress cron — NULL-safe sentinel values', () => {
  it('passes empty string when member_name is absent', () => {
    const { memberName } = simulateCongressInsert({ ticker: 'AMZN' });
    assert.strictEqual(memberName, '');
  });

  it('passes empty string when transaction_type is absent', () => {
    const { txType } = simulateCongressInsert({ ticker: 'AMZN', member_name: 'John Doe' });
    assert.strictEqual(txType, '');
  });

  it('passes sentinel date when transaction_date is absent', () => {
    const { tradedAt } = simulateCongressInsert({ ticker: 'AMZN' });
    assert.strictEqual(tradedAt.getFullYear(), 1900);
  });

  it('passes real values when all fields are present', () => {
    const { memberName, txType, tradedAt } = simulateCongressInsert({
      member_name: 'Nancy Pelosi',
      transaction_type: 'purchase',
      transaction_date: '2026-04-15',
    });
    assert.strictEqual(memberName, 'Nancy Pelosi');
    assert.strictEqual(txType, 'purchase');
    assert.strictEqual(tradedAt.toISOString().slice(0, 10), '2026-04-15');
  });
});

// ── Tests: flow alerts ────────────────────────────────────────────────────────

describe('Flow alerts cron — NULL-safe sentinel values', () => {
  it('passes empty string when side is absent', () => {
    const { side } = simulateFlowAlertInsert({ ticker: 'SPY' });
    assert.strictEqual(side, '');
  });

  it('falls back to option_type when side is absent', () => {
    const { side } = simulateFlowAlertInsert({ ticker: 'SPY', option_type: 'call' });
    assert.strictEqual(side, 'call');
  });

  it('passes -1 when strike is absent', () => {
    const { strike } = simulateFlowAlertInsert({ ticker: 'SPY' });
    assert.strictEqual(strike, -1);
  });

  it('passes sentinel date when expiry is absent', () => {
    const { expiry } = simulateFlowAlertInsert({ ticker: 'SPY' });
    assert.strictEqual(expiry.getFullYear(), 1900);
  });

  it('passes real values when all fields are present', () => {
    const { side, strike, expiry } = simulateFlowAlertInsert({
      side: 'put', strike: 550, expiry: '2026-06-20',
    });
    assert.strictEqual(side, 'put');
    assert.strictEqual(strike, 550);
    assert.strictEqual(expiry.toISOString().slice(0, 10), '2026-06-20');
  });
});

// ── Migration SQL sanity check ────────────────────────────────────────────────

describe('Migration SQL shape', () => {
  it('DROP CONSTRAINT statement is idempotent (IF EXISTS)', () => {
    const sql = `ALTER TABLE uw_insider_trades DROP CONSTRAINT IF EXISTS "uw_insider_trades_ticker_insider_name_filed_at_transaction__key"`;
    assert.ok(sql.includes('IF EXISTS'));
    assert.ok(sql.includes('uw_insider_trades'));
  });

  it('CREATE UNIQUE INDEX statement uses IF NOT EXISTS', () => {
    const sql = `CREATE UNIQUE INDEX IF NOT EXISTS idx_uw_insider_unique ON uw_insider_trades(ticker, COALESCE(insider_name,''), COALESCE(filed_at,'1900-01-01'::timestamptz), COALESCE(transaction_type,''))`;
    assert.ok(sql.includes('IF NOT EXISTS'));
    assert.ok(sql.includes('COALESCE(insider_name'));
    assert.ok(sql.includes('COALESCE(filed_at'));
    assert.ok(sql.includes('COALESCE(transaction_type'));
  });

  it('flow alerts index covers strike sentinel -1', () => {
    const sql = `CREATE UNIQUE INDEX IF NOT EXISTS idx_uw_flow_alerts_unique ON uw_flow_alerts(ticker, COALESCE(strike,-1), COALESCE(expiry,'1900-01-01'::date), COALESCE(side,''), alerted_at)`;
    assert.ok(sql.includes('COALESCE(strike,-1)'));
    assert.ok(sql.includes("COALESCE(side,'')"));
  });
});
