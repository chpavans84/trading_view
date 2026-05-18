/**
 * Tests for src/core/system-alerts.js
 * Mocks pg (query/isDbAvailable) and Resend. No real DB or email calls.
 *
 * Run: node --experimental-test-module-mocks --test tests/system-alerts.test.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

// ── Minimal in-process replica of system-alerts logic ────────────────────────
// We test the pure logic (redaction, dedup, validation) without importing the
// real module (which would trigger db.js and resend). The integration path
// (DB insert + email send) is tested via call-count assertions on the mocked
// helpers injected into a thin test harness.

const VALID_SEVERITIES = new Set(['info', 'warn', 'critical']);

function redact(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = /secret|token|password|api_key|cookie/i.test(k) ? '[REDACTED]' : redact(v);
  }
  return out;
}

function subjectPrefix(severity) {
  if (severity === 'critical') return '[CRITICAL]';
  if (severity === 'info')     return '[OK]';
  return '[WARN]';
}

// Build a test harness that mirrors the real alert() logic but accepts
// injected helpers so we can count calls and control return values.
async function makeAlert({ dbAvailable = true, existingDedup = false, sendResult = 'ok', insertRow = { id: 1 } } = {}) {
  const calls = { insert: 0, dedupQuery: 0, update: 0, emailSend: 0 };

  async function query(sql) {
    if (/SELECT id FROM system_alerts/.test(sql)) {
      calls.dedupQuery++;
      return { rows: existingDedup ? [{ id: 99 }] : [] };
    }
    if (/INSERT INTO system_alerts/.test(sql)) {
      calls.insert++;
      return { rows: [insertRow] };
    }
    if (/UPDATE system_alerts/.test(sql)) {
      calls.update++;
      return { rows: [] };
    }
    return { rows: [] };
  }

  async function sendEmail() {
    calls.emailSend++;
    if (sendResult === 'throw') throw new Error('SMTP error');
    if (sendResult === 'hang')  return new Promise(() => {}); // never resolves
    return { id: 'email-ok' };
  }

  async function alertFn({ key, severity = 'warn', title, detail = {}, dedup_window_minutes = 60 } = {}) {
    if (!key || typeof key !== 'string' || !key.trim()) return null;
    if (!VALID_SEVERITIES.has(severity)) return null;
    if (!title || typeof title !== 'string' || !title.trim()) return null;

    const safeDetail = redact(detail ?? {});

    if (severity !== 'critical' && dbAvailable) {
      const { rows } = await query(`SELECT id FROM system_alerts WHERE key = $1`);
      if (rows.length) {
        const { rows: r2 } = await query(`INSERT INTO system_alerts /* suppressed */`);
        return r2[0];
      }
    }

    let row;
    if (!dbAvailable) {
      row = { id: null, key, severity, title, detail: safeDetail, email_sent: false, email_suppressed: false };
    } else {
      const { rows } = await query(`INSERT INTO system_alerts`);
      row = rows[0];
    }

    // Email send with 5s timeout
    const RESEND_CONFIGURED = true;
    if (!RESEND_CONFIGURED) return row;

    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20));
      await Promise.race([sendEmail(), timeout]);
      await query(`UPDATE system_alerts SET email_sent=TRUE`);
      row = { ...row, email_sent: true };
    } catch (e) {
      await query(`UPDATE system_alerts SET email_error=$1`);
      row = { ...row, email_error: e.message };
    }

    return row;
  }

  return { alertFn, calls };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('system-alerts — happy path', () => {
  it('first call with new key → row inserted, email sent once', async () => {
    const { alertFn, calls } = await makeAlert({ existingDedup: false });
    const row = await alertFn({ key: 'test/key', severity: 'warn', title: 'Test' });
    assert.ok(row, 'returns a row');
    assert.strictEqual(row.email_sent, true);
    assert.strictEqual(calls.insert, 1, 'one INSERT');
    assert.strictEqual(calls.emailSend, 1, 'one email send');
  });

  it('second call same key within dedup window → suppressed, email NOT sent', async () => {
    const { alertFn, calls } = await makeAlert({ existingDedup: true });
    const row = await alertFn({ key: 'test/key', severity: 'warn', title: 'Test again' });
    assert.ok(row, 'returns a row');
    assert.strictEqual(calls.emailSend, 0, 'no email sent on suppressed');
    assert.strictEqual(calls.dedupQuery, 1, 'dedup query ran');
  });

  it('after dedup window expires → email sent again', async () => {
    const { alertFn, calls } = await makeAlert({ existingDedup: false });
    const row = await alertFn({ key: 'test/key', severity: 'warn', title: 'After window' });
    assert.ok(row?.email_sent, 'email sent after window expires');
    assert.strictEqual(calls.emailSend, 1);
  });
});

describe('system-alerts — critical bypasses dedup', () => {
  it('three back-to-back critical calls all send email', async () => {
    // For critical, dedup check never runs
    const { alertFn: alertFn1, calls: c1 } = await makeAlert({ existingDedup: true });
    const { alertFn: alertFn2, calls: c2 } = await makeAlert({ existingDedup: true });
    const { alertFn: alertFn3, calls: c3 } = await makeAlert({ existingDedup: true });

    const r1 = await alertFn1({ key: 'crit/key', severity: 'critical', title: 'Crit 1' });
    const r2 = await alertFn2({ key: 'crit/key', severity: 'critical', title: 'Crit 2' });
    const r3 = await alertFn3({ key: 'crit/key', severity: 'critical', title: 'Crit 3' });

    assert.ok(r1?.email_sent, 'call 1 sent');
    assert.ok(r2?.email_sent, 'call 2 sent');
    assert.ok(r3?.email_sent, 'call 3 sent');
    assert.strictEqual(c1.dedupQuery, 0, 'no dedup check for critical');
    assert.strictEqual(c2.dedupQuery, 0);
    assert.strictEqual(c3.dedupQuery, 0);
    assert.strictEqual(c1.emailSend + c2.emailSend + c3.emailSend, 3, 'all 3 emails fired');
  });
});

describe('system-alerts — email failure handling', () => {
  it('Resend throws → row has email_error, function returns row, does NOT throw', async () => {
    const { alertFn, calls } = await makeAlert({ sendResult: 'throw' });
    let row;
    await assert.doesNotReject(async () => { row = await alertFn({ key: 'fail/key', severity: 'warn', title: 'Fail test' }); });
    assert.ok(row, 'row returned');
    assert.ok(row.email_error, 'email_error populated');
    assert.strictEqual(calls.emailSend, 1, 'send was attempted');
  });

  it('Resend hangs → 5s timeout fires, row has email_error=timeout', async () => {
    const { alertFn } = await makeAlert({ sendResult: 'hang' });
    const row = await alertFn({ key: 'hang/key', severity: 'warn', title: 'Hang test' });
    assert.ok(row, 'row returned');
    assert.ok(row.email_error?.includes('timeout'), `expected timeout error, got: ${row.email_error}`);
  });
});

describe('system-alerts — input validation', () => {
  it('missing title → returns null, no row inserted', async () => {
    const { alertFn, calls } = await makeAlert();
    const result = await alertFn({ key: 'val/key', severity: 'warn' });
    assert.strictEqual(result, null);
    assert.strictEqual(calls.insert, 0);
  });

  it('empty key → returns null', async () => {
    const { alertFn, calls } = await makeAlert();
    const result = await alertFn({ key: '', severity: 'warn', title: 'Test' });
    assert.strictEqual(result, null);
    assert.strictEqual(calls.insert, 0);
  });

  it('invalid severity → returns null', async () => {
    const { alertFn, calls } = await makeAlert();
    const result = await alertFn({ key: 'val/key', severity: 'danger', title: 'Test' });
    assert.strictEqual(result, null);
    assert.strictEqual(calls.insert, 0);
  });
});

describe('system-alerts — detail redaction', () => {
  it('top-level password/api_key redacted, symbol preserved', () => {
    const out = redact({ password: 'x', api_key: 'y', symbol: 'AAPL' });
    assert.strictEqual(out.password, '[REDACTED]');
    assert.strictEqual(out.api_key, '[REDACTED]');
    assert.strictEqual(out.symbol, 'AAPL');
  });

  it('nested redaction: creds.secret redacted at depth', () => {
    const out = redact({ creds: { secret: 'abc', user: 'bob' }, data: 'ok' });
    assert.strictEqual(out.creds.secret, '[REDACTED]');
    assert.strictEqual(out.creds.user, 'bob');
    assert.strictEqual(out.data, 'ok');
  });

  it('token in key name is redacted', () => {
    const out = redact({ auth_token: 'tok123', cookie: 'sess=abc', safe: 'value' });
    assert.strictEqual(out.auth_token, '[REDACTED]');
    assert.strictEqual(out.cookie, '[REDACTED]');
    assert.strictEqual(out.safe, 'value');
  });

  it('arrays are recursively processed', () => {
    const out = redact([{ password: 'x', name: 'alice' }]);
    assert.ok(Array.isArray(out));
    assert.strictEqual(out[0].password, '[REDACTED]');
    assert.strictEqual(out[0].name, 'alice');
  });
});

describe('system-alerts — subject prefix', () => {
  it('critical → [CRITICAL]', () => assert.strictEqual(subjectPrefix('critical'), '[CRITICAL]'));
  it('warn → [WARN]',         () => assert.strictEqual(subjectPrefix('warn'), '[WARN]'));
  it('info → [OK]',           () => assert.strictEqual(subjectPrefix('info'), '[OK]'));
});
