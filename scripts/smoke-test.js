#!/usr/bin/env node
/**
 * Smoke test — verifies all critical routes respond correctly.
 *
 * Usage:
 *   SMOKE_PASS=yourpassword node scripts/smoke-test.js [port]
 *
 * Env vars:
 *   SMOKE_USER  Login username  (default: admin)
 *   SMOKE_PASS  Login password  (required)
 *
 * Exit code 0 = all pass, 1 = any failure.
 * Routes that call AI or external paid APIs are intentionally excluded.
 */

const PORT  = process.argv[2] || 3000;
const BASE  = `http://localhost:${PORT}`;
const USER  = process.env.SMOKE_USER || 'admin';
const PASS  = process.env.SMOKE_PASS;

if (!PASS) {
  console.error('\nError: SMOKE_PASS environment variable is required.');
  console.error('Usage: SMOKE_PASS=yourpassword node scripts/smoke-test.js [port]\n');
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────

let cookie = '';
let passed = 0;
let failed = 0;
const results = [];

async function req(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const t0  = Date.now();
  const res = await fetch(`${BASE}${path}`, opts);
  const ms  = Date.now() - t0;

  if (res.headers.get('set-cookie')) {
    cookie = res.headers.get('set-cookie').split(';')[0];
  }
  return { status: res.status, ms, res };
}

function record(label, status, ms, ok) {
  const icon = ok ? '✓' : '✗';
  const line = `  ${icon}  ${label.padEnd(40)} ${String(status).padEnd(5)} (${ms}ms)`;
  results.push({ line, ok });
  if (ok) passed++; else failed++;
}

async function check(label, method, path, expectedStatus = 200, body) {
  try {
    const { status, ms } = await req(method, path, body);
    record(label, status, ms, status === expectedStatus);
  } catch (e) {
    record(label, 'ERR', 0, false);
    results[results.length - 1].line += `  → ${e.message}`;
  }
}

// ── Test suites ────────────────────────────────────────────────────────────

async function runPublicRoutes() {
  console.log('\n[PUBLIC ROUTES]');
  await check('GET /login.html',  'GET', '/login.html');
}

async function runAuth() {
  console.log('\n[AUTH]');
  const { status, ms, res } = await req('POST', '/auth/login', { username: USER, password: PASS });
  let ok = status === 200;
  if (ok) {
    const json = await res.json().catch(() => ({}));
    ok = json.ok === true;
  }
  record('POST /auth/login', status, ms, ok);
  if (!ok) {
    console.error('\n  Login failed — remaining tests will return 401. Check SMOKE_USER/SMOKE_PASS.\n');
  }
}

async function runAuthenticatedRoutes() {
  const today = new Date().toISOString().split('T')[0];
  console.log('\n[AUTHENTICATED ROUTES]');
  await check('GET /auth/check',                            'GET', '/auth/check');
  await check('GET /api/home',                              'GET', '/api/home');
  await check('GET /api/market-status',                     'GET', '/api/market-status');
  await check('GET /api/scores',                            'GET', '/api/scores');
  await check('GET /api/dashboard',                         'GET', '/api/dashboard');
  await check('GET /api/positions',                         'GET', '/api/positions');
  await check('GET /api/trades',                            'GET', '/api/trades');
  await check('GET /api/briefing',                          'GET', '/api/briefing');
  await check('GET /api/watchlist',                         'GET', '/api/watchlist');
  await check('GET /api/stats',                             'GET', '/api/stats');
  await check('GET /api/rejections',                        'GET', '/api/rejections');
  await check('GET /api/earnings-calendar?date=' + today,   'GET', `/api/earnings-calendar?date=${today}`);
  await check('GET /api/forecast',                          'GET', '/api/forecast');
  await check('GET /api/picks/history',                     'GET', '/api/picks/history');
  await check('GET /api/chat/history',                      'GET', '/api/chat/history');
  await check('GET /api/analyst/state',                     'GET', '/api/analyst/state');
  await check('GET /api/sources',                           'GET', '/api/sources');
}

// ── Main ───────────────────────────────────────────────────────────────────

const DIVIDER = '═'.repeat(52);
const t0 = Date.now();

console.log(`\n${DIVIDER}`);
console.log(`  Smoke Test → ${BASE}`);
console.log(DIVIDER);

await runPublicRoutes();
await runAuth();
await runAuthenticatedRoutes();

const total = Date.now() - t0;

console.log(`\n${DIVIDER}`);
results.forEach(r => console.log(r.line));
console.log(DIVIDER);

if (failed === 0) {
  console.log(`\n  ✓ All ${passed} tests passed (${total}ms)\n`);
  process.exit(0);
} else {
  console.log(`\n  ✗ ${failed} of ${passed + failed} tests FAILED (${total}ms)`);
  console.log('  Do NOT deploy to production until all tests pass.\n');
  process.exit(1);
}
