/**
 * scripts/capture-landing-shots.mjs
 * Capture real dashboard-tab screenshots for the public landing page panels.
 *
 * How: boots a private server instance on :3097 with a TEMP admin (contract-test
 * pattern — users file backed up/restored), drives HEADLESS Chrome over CDP
 * (chrome-remote-interface, already a dep), logs in, opens each tab, screenshots.
 * Output: screenshots/landing/*.png (raw) — compress + publish handled by caller.
 *
 * NOTE: shots show REAL (paper-trading) data from the live DB. Curate which tabs
 * are safe for the public page — market/screener content, not account internals.
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import bcrypt from 'bcrypt';
import CDP from 'chrome-remote-interface';

const ROOT  = new URL('..', import.meta.url).pathname;
const PORT  = 3097;
const BASE  = `http://localhost:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = 9223;                       // NOT 9222 (TradingView desktop uses it)
const USERS_FILE = ROOT + 'src/web/users.json';          // server reads src/web/users.json
const USERS_BAK  = ROOT + 'src/web/users.json.landing-bak';
const OUT = ROOT + 'screenshots/landing';
const ADMIN_USER = 'landing_shot_admin';
const ADMIN_PASS = 'Landing@Shots#9999';

// [outfile, tabKey (showPage arg) or null for plain url, viewport, extraJs?]
const SHOTS = [
  ['dashboard', 'dashboard',  { w: 1680, h: 1000 }],
  ['toppicks',  'top-picks',  { w: 1680, h: 1000 }],
  ['screener',  'screener',   { w: 1680, h: 1000 }],
  ['bots',      'bots',       { w: 1680, h: 1000 }],
  ['research',  'research',   { w: 1680, h: 1000 }],
  ['mobile',    null,         { w: 412,  h: 915, url: '/mobile.html', mobile: true }],
  // widget-arsenal card backgrounds
  ['home',      'home',          { w: 1680, h: 1000 }],   // Momentum Race lives here
  ['calendar',  'calendar',      { w: 1680, h: 1000 }],   // Upcoming Earnings
  ['advisor',   'advisor',       { w: 1680, h: 1000 }],   // Portfolio Advisor
  ['uwflow',    'uw',            { w: 1680, h: 1000 }],   // Options Flow
  ['uwinsider', 'uw',            { w: 1680, h: 1000 }, "switchUwSubTab('insider')"],
  ['uwcongress','uw',            { w: 1680, h: 1000 }, "switchUwSubTab('congress')"],
  ['backtests', 'backtests',     { w: 1680, h: 1000 }],   // Signal Track Record
  ['exthours',  'ext-hours',     { w: 1680, h: 1000 }],
  ['desk',      'trading-desk',  { w: 1680, h: 1000 }],
  ['health',    'health',        { w: 1680, h: 1000 }],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, tries = 40, ms = 500) {
  for (let i = 0; i < tries; i++) { try { if (await fn()) return true; } catch {} await sleep(ms); }
  return false;
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // 1. temp admin (backup/restore real users file)
  if (existsSync(USERS_FILE)) writeFileSync(USERS_BAK, readFileSync(USERS_FILE, 'utf8'));
  const hash = await bcrypt.hash(ADMIN_PASS, 10);
  writeFileSync(USERS_FILE, JSON.stringify({ [ADMIN_USER]: { hash, role: 'admin' } }, null, 2));

  // 2. private server
  const server = spawn('node', ['--env-file=.env', 'src/web/server.js'], {
    cwd: ROOT,
    env: { ...process.env, DASHBOARD_PORT: String(PORT), DASHBOARD_PASSWORD: ADMIN_PASS,
           SESSION_SECRET: 'landing-shot-session-secret-32chars!!', NODE_ENV: 'test',
           SECURE_COOKIE: 'false' },   // plain http://localhost — secure cookies would be dropped
    stdio: 'ignore',
  });

  // 3. headless chrome
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run',
    '--user-data-dir=/tmp/chrome-landing-shots', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitFor(async () => (await fetch(`${BASE}/login.html`)).ok);
    await waitFor(async () => (await fetch(`http://localhost:${CDP_PORT}/json/version`)).ok);

    const client = await CDP({ port: CDP_PORT });
    const { Page, Runtime, Emulation, Network } = client;
    await Promise.all([Page.enable(), Runtime.enable(), Network.enable()]);

    // login once — session cookie persists in the browser profile
    await Page.navigate({ url: `${BASE}/login.html` });
    await Page.loadEventFired();
    await Runtime.evaluate({ awaitPromise: true, expression: `
      fetch('/auth/login', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ username:'${ADMIN_USER}', password:'${ADMIN_PASS}' }) }).then(r => r.status)` });

    for (const [name, tab, vp, extraJs] of SHOTS) {
      await Emulation.setDeviceMetricsOverride({
        width: vp.w, height: vp.h, deviceScaleFactor: 2, mobile: !!vp.mobile,
      });
      await Page.navigate({ url: BASE + (vp.url || '/?desktop=1') });
      await Page.loadEventFired();
      await sleep(3500);                                  // let data/API calls land
      if (tab) {
        await Runtime.evaluate({ expression: `showPage('${tab}')` });
        await sleep(4500);                                // tab loader + charts
      }
      if (extraJs) { await Runtime.evaluate({ expression: extraJs }); await sleep(2500); }
      const shot = await Page.captureScreenshot({ format: 'png' });
      writeFileSync(`${OUT}/${name}.png`, Buffer.from(shot.data, 'base64'));
      console.log(`📸 ${name}.png (${tab || vp.url})`);
    }
    await client.close();
  } finally {
    chrome.kill('SIGTERM');
    server.kill('SIGTERM');
    if (existsSync(USERS_BAK)) { writeFileSync(USERS_FILE, readFileSync(USERS_BAK, 'utf8')); unlinkSync(USERS_BAK); }
    try { execSync('rm -rf /tmp/chrome-landing-shots'); } catch {}
  }
  console.log('DONE →', OUT);
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
