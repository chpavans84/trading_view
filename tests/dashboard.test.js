/**
 * Dashboard integration tests.
 * Spawns the server on port 3099 with test credentials, runs all checks, then shuts down.
 *
 * Run:  npm run test:dashboard
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn }  from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import bcrypt from 'bcrypt';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const PORT      = 3099;
const BASE      = `http://localhost:${PORT}`;

const ADMIN_USER  = 'testadmin';
const ADMIN_PASS  = 'DashTest@999';
const VIEWER_USER = 'testviewer';
const VIEWER_PASS = 'ViewOnly@888';
const USERS_FILE  = join(ROOT, 'src/web/users.json');
const USERS_BAK   = join(ROOT, 'src/web/users.json.bak');

let server;

// Sessions established once and reused across all tests
let adminCookie  = '';
let viewerCookie = '';
// Raw Set-Cookie header for flag inspection
let adminSetCookie = '';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract just the `name=value` pair from a Set-Cookie header */
function parseCookieValue(setCookie) {
  return setCookie ? setCookie.split(';')[0].trim() : '';
}

/** Make an HTTP request; optionally attach a session cookie */
async function req(path, opts = {}, cookie = '') {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  // Always set Cookie header explicitly so Node's undici cookie jar doesn't interfere
  headers['Cookie'] = cookie || '';
  return fetch(BASE + path, { ...opts, headers });
}

/** POST /auth/login and return {res, cookie, setCookie} */
async function login(username, password) {
  const r = await req('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  const setCookie = r.headers.get('set-cookie') || '';
  return { res: r, cookie: parseCookieValue(setCookie), setCookie };
}

/** Wait for the test server to accept connections */
function waitForServer(ms = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const poll = () => fetch(BASE + '/auth/check', { headers: { Cookie: '' } })
      .then(() => resolve())
      .catch(() => {
        if (Date.now() > deadline) return reject(new Error('Server did not start'));
        setTimeout(poll, 300);
      });
    poll();
  });
}

// ── Global setup ─────────────────────────────────────────────────────────────

before(async () => {
  // Back up real users.json
  if (existsSync(USERS_FILE)) writeFileSync(USERS_BAK, readFileSync(USERS_FILE, 'utf8'));

  // Write test users
  const [adminHash, viewerHash] = await Promise.all([
    bcrypt.hash(ADMIN_PASS, 10),
    bcrypt.hash(VIEWER_PASS, 10),
  ]);
  writeFileSync(USERS_FILE, JSON.stringify({
    [ADMIN_USER]:  { hash: adminHash,  role: 'admin'  },
    [VIEWER_USER]: { hash: viewerHash, role: 'viewer' },
  }, null, 2));

  // Spawn test server
  server = spawn('node', ['--env-file=.env', 'src/web/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DASHBOARD_PORT:    String(PORT),
      DASHBOARD_PASSWORD: ADMIN_PASS,
      SESSION_SECRET:    'test-session-secret-long-enough-32chars-yes',
      NODE_ENV:          'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => {
    const msg = d.toString();
    if (!msg.includes('DeprecationWarning')) process.stderr.write('[srv] ' + msg);
  });

  await waitForServer();

  // Login once — reuse sessions for all tests to avoid rate-limit exhaustion
  const a = await login(ADMIN_USER, ADMIN_PASS);
  const v = await login(VIEWER_USER, VIEWER_PASS);
  assert.equal(a.res.status, 200, `Admin login failed: ${await a.res.text()}`);
  assert.equal(v.res.status, 200, `Viewer login failed: ${await v.res.text()}`);
  adminCookie    = a.cookie;
  viewerCookie   = v.cookie;
  adminSetCookie = a.setCookie;
});

after(() => {
  server?.kill('SIGTERM');
  if (existsSync(USERS_BAK)) {
    writeFileSync(USERS_FILE, readFileSync(USERS_BAK, 'utf8'));
    unlinkSync(USERS_BAK);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Security headers
// ═════════════════════════════════════════════════════════════════════════════

describe('Security headers', () => {
  let csp = '';
  before(async () => {
    const r = await req('/');
    csp = r.headers.get('content-security-policy') || '';
  });

  test('CSP header is present', () => {
    assert.ok(csp.length > 0, 'CSP header missing');
  });

  test('CSP script-src-attr is NOT "none" — onclick handlers must work', () => {
    assert.ok(
      !csp.includes("script-src-attr 'none'"),
      `script-src-attr must not be 'none'. CSP: ${csp}`
    );
  });

  test('CSP allows unsafe-inline for script attributes', () => {
    assert.ok(
      csp.includes("script-src-attr 'unsafe-inline'"),
      `script-src-attr 'unsafe-inline' missing. CSP: ${csp}`
    );
  });

  test('CSP blocks object-src (no plugins)', () => {
    assert.ok(csp.includes("object-src 'none'"), 'object-src none missing');
  });

  test('Framing is restricted (frame-ancestors or X-Frame-Options)', async () => {
    const r   = await req('/');
    const xfo = r.headers.get('x-frame-options') || '';
    assert.ok(
      csp.includes('frame-ancestors') || xfo.length > 0,
      'No framing protection found'
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Static files
// ═════════════════════════════════════════════════════════════════════════════

describe('Static files', () => {
  test('GET / returns 200 HTML', async () => {
    const r = await req('/');
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes('<html'));
  });

  test('GET /login.html returns 200', async () => {
    const r = await req('/login.html');
    assert.equal(r.status, 200);
  });

  test('login.html has both username and password fields', async () => {
    const body = await (await req('/login.html')).text();
    assert.ok(body.includes('id="un"'),          'Username field missing');
    assert.ok(body.includes('type="password"'),  'Password field missing');
  });

  test('index.html contains showPage function', async () => {
    const body = await (await req('/')).text();
    assert.ok(body.includes('function showPage'), 'showPage missing');
  });

  test('index.html tab buttons pass "this" to showPage (not relying on window.event)', async () => {
    const body = await (await req('/')).text();
    assert.ok(body.includes("showPage('dashboard',this)"), "dashboard tab must pass 'this'");
    assert.ok(body.includes("showPage('trades',this)"),    "trades tab must pass 'this'");
    assert.ok(body.includes("showPage('scores',this)"),    "scores tab must pass 'this'");
    // None should use old pattern without this
    assert.ok(!body.match(/showPage\('[a-z]+'\)/),         "No tab should omit 'this'");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Auth — login behaviour
// ═════════════════════════════════════════════════════════════════════════════

describe('Auth — login', () => {
  test('missing credentials returns 400', async () => {
    const r = await req('/auth/login', { method: 'POST', body: '{}' });
    assert.equal(r.status, 400);
  });

  test('wrong password returns 401', async () => {
    const { res } = await login(ADMIN_USER, 'wrongpassword');
    assert.equal(res.status, 401);
  });

  test('wrong username returns 401', async () => {
    const { res } = await login('nobody', ADMIN_PASS);
    assert.equal(res.status, 401);
  });

  test('error message does not reveal whether username or password was wrong', async () => {
    const { res } = await login(ADMIN_USER, 'wrongpassword');
    const body = await res.json();
    assert.ok(!body.error?.toLowerCase().includes('password'), 'Must not say "password"');
    assert.ok(!body.error?.toLowerCase().includes('username'), 'Must not say "username"');
  });

  test('session cookie has HttpOnly flag', () => {
    assert.ok(
      adminSetCookie.toLowerCase().includes('httponly'),
      `HttpOnly missing from Set-Cookie: ${adminSetCookie}`
    );
  });

  test('session cookie has SameSite=Strict', () => {
    assert.ok(
      adminSetCookie.toLowerCase().includes('samesite=strict'),
      `SameSite=Strict missing from Set-Cookie: ${adminSetCookie}`
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Auth — session & logout
// ═════════════════════════════════════════════════════════════════════════════

describe('Auth — session & logout', () => {
  test('auth/check without cookie returns authenticated:false', async () => {
    const r    = await req('/auth/check');
    const body = await r.json();
    assert.equal(body.authenticated, false);
  });

  test('auth/check with admin session returns authenticated:true + role:admin', async () => {
    const r    = await req('/auth/check', {}, adminCookie);
    const body = await r.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.username, ADMIN_USER);
    assert.equal(body.role, 'admin');
  });

  test('auth/check with viewer session returns role:viewer', async () => {
    const r    = await req('/auth/check', {}, viewerCookie);
    const body = await r.json();
    assert.equal(body.role, 'viewer');
  });

  test('logout invalidates the session', async () => {
    // Create a fresh throwaway session so we don't break adminCookie
    const { cookie } = await login(ADMIN_USER, ADMIN_PASS);
    await req('/auth/logout', { method: 'POST' }, cookie);
    const r    = await req('/auth/check', {}, cookie);
    const body = await r.json();
    assert.equal(body.authenticated, false, 'Session must be gone after logout');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. API — authentication enforced
// ═════════════════════════════════════════════════════════════════════════════

describe('API — auth required', () => {
  const routes = [
    ['GET',  '/api/dashboard'],
    ['GET',  '/api/home-news'],
    ['GET',  '/api/trades'],
    ['GET',  '/api/scores'],
    ['GET',  '/api/pnl'],
    ['POST', '/api/chat'],
  ];

  for (const [method, path] of routes) {
    test(`${method} ${path} → 401 without session`, async () => {
      const body = method === 'POST' ? JSON.stringify({ message: 'hi' }) : undefined;
      const r = await req(path, { method, body });
      assert.equal(r.status, 401, `${path} must require auth`);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. User management
// ═════════════════════════════════════════════════════════════════════════════

describe('User management', () => {
  test('admin can list users', async () => {
    const r    = await req('/api/users/list', {}, adminCookie);
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(body));
    assert.ok(body.some(u => u.username === ADMIN_USER));
  });

  test('viewer cannot list users (403)', async () => {
    const r = await req('/api/users/list', {}, viewerCookie);
    assert.equal(r.status, 403);
  });

  test('unauthenticated cannot list users (401)', async () => {
    // Use raw http.request to guarantee zero cookies are sent (bypasses Node's fetch cookie jar)
    const status = await new Promise((resolve, reject) => {
      const r = http.request(
        { hostname: 'localhost', port: PORT, path: '/api/users/list', method: 'GET' },
        res => resolve(res.statusCode)
      );
      r.on('error', reject);
      r.end();
    });
    assert.equal(status, 401);
  });

  test('admin can add a new user', async () => {
    const r    = await req('/api/users/add', {
      method: 'POST',
      body: JSON.stringify({ username: 'tmpuser', password: 'TmpPass@123', role: 'viewer' }),
    }, adminCookie);
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.username, 'tmpuser');
  });

  test('new user can log in', async () => {
    const { res } = await login('tmpuser', 'TmpPass@123');
    assert.equal(res.status, 200);
  });

  test('duplicate username returns 409', async () => {
    const r = await req('/api/users/add', {
      method: 'POST',
      body: JSON.stringify({ username: VIEWER_USER, password: 'any', role: 'viewer' }),
    }, adminCookie);
    assert.equal(r.status, 409);
  });

  test('invalid username format returns 400', async () => {
    const r = await req('/api/users/add', {
      method: 'POST',
      body: JSON.stringify({ username: 'bad user!', password: 'any', role: 'viewer' }),
    }, adminCookie);
    assert.equal(r.status, 400);
  });

  test('viewer cannot add users (403)', async () => {
    const r = await req('/api/users/add', {
      method: 'POST',
      body: JSON.stringify({ username: 'x', password: 'y', role: 'viewer' }),
    }, viewerCookie);
    assert.equal(r.status, 403);
  });

  test('admin can remove a user', async () => {
    const r = await req('/api/users/remove', {
      method: 'POST',
      body: JSON.stringify({ username: 'tmpuser' }),
    }, adminCookie);
    assert.equal(r.status, 200);
  });

  test('removed user cannot log in', async () => {
    const { res } = await login('tmpuser', 'TmpPass@123');
    assert.equal(res.status, 401);
  });

  test('admin cannot delete their own account', async () => {
    const r = await req('/api/users/remove', {
      method: 'POST',
      body: JSON.stringify({ username: ADMIN_USER }),
    }, adminCookie);
    assert.equal(r.status, 400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Rate limiting
// ═════════════════════════════════════════════════════════════════════════════

describe('Rate limiting', () => {
  test('login rate limiter blocks after 5 failed attempts', async () => {
    // skipSuccessfulRequests:true means only failures count — hammer with bad password
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      const { res } = await login('ratelimituser', 'badpass');
      statuses.push(res.status);
    }
    assert.ok(
      statuses.includes(429),
      `Expected 429 after 5 failed logins, got: ${statuses.join(',')}`
    );
  });

  test('JSON body over 50 KB is rejected', async () => {
    const r = await req('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'x'.repeat(60_000) }),
    });
    assert.ok([400, 413].includes(r.status), `Expected 400 or 413, got ${r.status}`);
  });
});
