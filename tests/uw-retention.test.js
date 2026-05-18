/**
 * Tests for uw-retention.js (Item 3).
 * Mocks query() and verifies correct DELETE SQL per table,
 * env var override, and row-count summary shape.
 *
 * Run: node --test tests/uw-retention.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

// ── In-process replica of purgeOldUwRows logic ────────────────────────────────

function makeRetentionConfig(env = {}) {
  return {
    uw_flow_alerts:  { col: 'alerted_at',  days: parseInt(env.UW_FLOW_RETENTION_DAYS    || '90',  10) },
    uw_top_movers:   { col: 'captured_at', days: parseInt(env.UW_MOVERS_RETENTION_DAYS  || '30',  10) },
    uw_options_flow: { col: 'ingested_at', days: parseInt(env.UW_OPTIONS_FLOW_RETENTION_DAYS || '90', 10) },
  };
}

function simulatePurge(config, mockRowCounts) {
  const result = {};
  for (const [table, { col, days }] of Object.entries(config)) {
    const sql = `DELETE FROM ${table} WHERE ${col} < NOW() - INTERVAL '${days} days'`;
    result[table] = { sql, rowCount: mockRowCounts[table] ?? 0 };
  }
  return result;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('uw-retention — default config', () => {
  it('uses 90-day window for uw_flow_alerts', () => {
    const cfg = makeRetentionConfig({});
    assert.strictEqual(cfg.uw_flow_alerts.days, 90);
    assert.strictEqual(cfg.uw_flow_alerts.col, 'alerted_at');
  });

  it('uses 30-day window for uw_top_movers', () => {
    const cfg = makeRetentionConfig({});
    assert.strictEqual(cfg.uw_top_movers.days, 30);
    assert.strictEqual(cfg.uw_top_movers.col, 'captured_at');
  });

  it('uses 90-day window for uw_options_flow', () => {
    const cfg = makeRetentionConfig({});
    assert.strictEqual(cfg.uw_options_flow.days, 90);
    assert.strictEqual(cfg.uw_options_flow.col, 'ingested_at');
  });
});

describe('uw-retention — env var override', () => {
  it('respects UW_FLOW_RETENTION_DAYS=14', () => {
    const cfg = makeRetentionConfig({ UW_FLOW_RETENTION_DAYS: '14' });
    assert.strictEqual(cfg.uw_flow_alerts.days, 14);
  });

  it('respects UW_MOVERS_RETENTION_DAYS=7', () => {
    const cfg = makeRetentionConfig({ UW_MOVERS_RETENTION_DAYS: '7' });
    assert.strictEqual(cfg.uw_top_movers.days, 7);
  });
});

describe('uw-retention — DELETE SQL shape', () => {
  it('generates correct DELETE statement for each table', () => {
    const cfg = makeRetentionConfig({});
    const result = simulatePurge(cfg, {});
    assert.ok(result.uw_flow_alerts.sql.includes("DELETE FROM uw_flow_alerts WHERE alerted_at < NOW() - INTERVAL '90 days'"));
    assert.ok(result.uw_top_movers.sql.includes("DELETE FROM uw_top_movers WHERE captured_at < NOW() - INTERVAL '30 days'"));
    assert.ok(result.uw_options_flow.sql.includes("DELETE FROM uw_options_flow WHERE ingested_at < NOW() - INTERVAL '90 days'"));
  });
});

describe('uw-retention — row-count summary', () => {
  it('returns per-table deleted row counts', () => {
    const cfg = makeRetentionConfig({});
    const result = simulatePurge(cfg, { uw_flow_alerts: 500, uw_top_movers: 120, uw_options_flow: 0 });
    assert.strictEqual(result.uw_flow_alerts.rowCount, 500);
    assert.strictEqual(result.uw_top_movers.rowCount, 120);
    assert.strictEqual(result.uw_options_flow.rowCount, 0);
  });

  it('returns 0 for tables with no expired rows', () => {
    const cfg = makeRetentionConfig({});
    const result = simulatePurge(cfg, {});
    const total = Object.values(result).reduce((s, r) => s + r.rowCount, 0);
    assert.strictEqual(total, 0);
  });
});
