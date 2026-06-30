/**
 * Registry contract / smoke test.
 *
 * Walks src/web/registry.js ENDPOINT_CONTRACTS and asserts every endpoint the dashboard
 * depends on still responds — fails only on 404 (route removed) or 500 (route crashed),
 * the two failure modes that cause silent dashboard breakage. Also checks registry structure.
 *
 * This is the guardrail against "Claude removed/broke an endpoint" recurring.
 *
 * Run:  npm run test:contract
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import { ALL_TABS, ALL_WIDGETS, DEFAULT_PERMISSIONS, ENDPOINT_CONTRACTS } from '../src/web/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const PORT      = 3098;                       // distinct from dashboard.test.js (3099)
const BASE      = `http://localhost:${PORT}`;
const ADMIN_USER = 'testadmin_contract';
const ADMIN_PASS = 'Contract@9999';
const USERS_FILE = join(ROOT, 'src/web/users.json');
const USERS_BAK  = join(ROOT, 'src/web/users.json.contractbak');

let server;
let adminCookie = '';

function parseCookieValue(sc) { return sc ? sc.split(';')[0].trim() : ''; }

async function req(path, cookie = '', timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(BASE + path, { headers: { Cookie: cookie || '' }, signal: ac.signal });
  } finally { clearTimeout(t); }
}

async function login(u, p) {
  const r = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: '' },
    body: JSON.stringify({ username: u, password: p }),
  });
  return { res: r, cookie: parseCookieValue(r.headers.get('set-cookie') || '') };
}

function waitForServer(ms = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const poll = () => fetch(BASE + '/auth/check', { headers: { Cookie: '' } })
      .then(() => resolve())
      .catch(() => Date.now() > deadline ? reject(new Error('server did not start')) : setTimeout(poll, 300));
    poll();
  });
}

before(async () => {
  if (existsSync(USERS_FILE)) writeFileSync(USERS_BAK, readFileSync(USERS_FILE, 'utf8'));
  const hash = await bcrypt.hash(ADMIN_PASS, 10);
  writeFileSync(USERS_FILE, JSON.stringify({ [ADMIN_USER]: { hash, role: 'admin' } }, null, 2));

  server = spawn('node', ['--env-file=.env', 'src/web/server.js'], {
    cwd: ROOT,
    env: { ...process.env, DASHBOARD_PORT: String(PORT), DASHBOARD_PASSWORD: ADMIN_PASS,
           SESSION_SECRET: 'contract-test-session-secret-32chars-min', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => { const m = d.toString(); if (!m.includes('Warning')) process.stderr.write('[srv] ' + m); });

  await waitForServer();
  const a = await login(ADMIN_USER, ADMIN_PASS);
  assert.equal(a.res.status, 200, 'admin login failed');
  adminCookie = a.cookie;
});

after(() => {
  server?.kill('SIGTERM');
  if (existsSync(USERS_BAK)) { writeFileSync(USERS_FILE, readFileSync(USERS_BAK, 'utf8')); unlinkSync(USERS_BAK); }
});

// ── Pre-auth shell gate ────────────────────────────────────────────────────────
// The 1.6MB app shells must never ship to anonymous visitors (info disclosure).
// Regression guard for the gate added 2026-06-11. Login page + PWA assets stay public.
describe('pre-auth shell gate', () => {
  const SHELLS = ['/', '/index.html', '/mobile.html', '/mobile-v1.html'];
  for (const p of SHELLS) {
    test(`anonymous ${p} redirects to /login.html`, async () => {
      const r = await fetch(BASE + p, { redirect: 'manual' });
      assert.equal(r.status, 302, `${p} should 302 for anonymous`);
      assert.ok((r.headers.get('location') || '').includes('/login.html'), `${p} should redirect to login`);
    });
  }
  test('login.html stays public', async () => {
    const r = await fetch(BASE + '/login.html');
    assert.equal(r.status, 200);
  });
  test('manifest.json + sw.js stay public (PWA)', async () => {
    for (const p of ['/manifest.json', '/sw.js']) {
      const r = await fetch(BASE + p);
      assert.equal(r.status, 200, `${p} must remain public`);
    }
  });
  test('authenticated / serves the app shell', async () => {
    const r = await fetch(BASE + '/?desktop=1', { headers: { Cookie: adminCookie }, redirect: 'manual' });
    assert.equal(r.status, 200, 'authed user should get index.html');
  });
});

// ── Registry structure invariants ──────────────────────────────────────────────
describe('registry structure', () => {
  test('ALL_TABS non-empty and unique', () => {
    assert.ok(ALL_TABS.length > 0);
    assert.equal(new Set(ALL_TABS).size, ALL_TABS.length, 'duplicate tab id');
  });
  test('ALL_WIDGETS unique', () => {
    assert.equal(new Set(ALL_WIDGETS).size, ALL_WIDGETS.length, 'duplicate widget id');
  });
  test('viewer perms are a subset of the full lists', () => {
    for (const t of DEFAULT_PERMISSIONS.viewer.tabs) assert.ok(ALL_TABS.includes(t), `viewer tab not in ALL_TABS: ${t}`);
    for (const w of DEFAULT_PERMISSIONS.viewer.widgets) assert.ok(ALL_WIDGETS.includes(w), `viewer widget not in ALL_WIDGETS: ${w}`);
  });
  test('endpoint contracts have unique keys and paths', () => {
    assert.equal(new Set(ENDPOINT_CONTRACTS.map(c => c.key)).size, ENDPOINT_CONTRACTS.length, 'dup contract key');
    assert.equal(new Set(ENDPOINT_CONTRACTS.map(c => c.path)).size, ENDPOINT_CONTRACTS.length, 'dup contract path');
  });
});

// ── Endpoint liveness contract ──────────────────────────────────────────────────
describe('endpoint contracts (live)', () => {
  for (const c of ENDPOINT_CONTRACTS) {
    test(`${c.key} → ${c.path}`, async () => {
      const r = await req(c.path, adminCookie);
      const body = await r.text();                              // read ONCE
      assert.notEqual(r.status, 404, `route MISSING (404): ${c.path}`);
      assert.notEqual(r.status, 500, `route CRASHED (500): ${c.path} — ${body.slice(0, 160)}`);
      if (r.status === 200 && (r.headers.get('content-type') || '').includes('application/json')) {
        assert.doesNotThrow(() => JSON.parse(body), `200 but invalid JSON: ${c.path}`);
      }
    });
  }
});
