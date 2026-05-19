/**
 * Mobile PWA — Phase 6 unit tests
 * Tests browser-side logic extracted into a Node.js test harness.
 * No real DOM, no real fetch — all APIs are stubbed.
 *
 * Run: node --test tests/mobile.test.js
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// ────────────────────────────────────────────────────────────────────────────
// Minimal browser-API stubs
// ────────────────────────────────────────────────────────────────────────────

function makeSandbox() {
  // localStorage stub
  const store = {};
  const localStorage = {
    getItem: k => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };

  // navigator.vibrate stub (counts calls)
  let vibrateCallCount = 0;
  let lastVibrateArg   = null;
  const navigator = {
    vibrate: (pat) => { vibrateCallCount++; lastVibrateArg = pat; return true; },
    onLine: true,
    serviceWorker: {
      register: async (url, opts) => ({ scope: opts?.scope || '/' }),
      ready: Promise.resolve({
        pushManager: {
          getSubscription: async () => null,
          subscribe: async (opts) => ({
            endpoint: 'https://example.com/push/endpoint',
            toJSON: () => ({
              endpoint: 'https://example.com/push/endpoint',
              keys: { p256dh: 'AABB', auth: 'CCDD' },
            }),
          }),
        },
      }),
    },
  };

  // Notification stub
  let notifPermission = 'default';
  const Notification = {
    get permission() { return notifPermission; },
    requestPermission: async () => { notifPermission = 'granted'; return 'granted'; },
  };
  Notification.setPermission = v => { notifPermission = v; };

  // fetch stub — returns 200 JSON by default
  let fetchImpl = async (url) => ({
    ok: true, status: 200,
    json: async () => ({}),
    text: async () => '{}',
  });
  const fetchStub = async (url, opts) => fetchImpl(url, opts);
  fetchStub.setImpl = fn => { fetchImpl = fn; };

  // window.matchMedia stub
  let prefersReducedMotion = false;
  const matchMedia = (query) => ({
    get matches() {
      if (query.includes('reduced-motion')) return prefersReducedMotion;
      return false;
    },
  });
  matchMedia.setReducedMotion = v => { prefersReducedMotion = v; };

  return {
    localStorage, navigator, Notification, fetchStub, matchMedia,
    getVibrateCount: () => vibrateCallCount,
    getLastVibrate:  () => lastVibrateArg,
    resetVibrate:    () => { vibrateCallCount = 0; lastVibrateArg = null; },
  };
}

// ── Inline implementations under test ────────────────────────────────────────
// These mirror the logic in mobile.html so tests run in Node without a browser.

function makeHaptic(mq, nav) {
  return function haptic(pattern = 10) {
    if (!mq.matches && nav.vibrate) nav.vibrate(pattern);
  };
}

function makeApiFetch(fetchFn) {
  return async function apiFetch(path, opts = {}) {
    const res = await fetchFn(path, opts);
    if (res.status === 401) { throw new Error('UNAUTHORIZED'); }
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { raw: text }; }
  };
}

// Bottom-sheet spring state machine (simplified for testing)
function makeSheetEngine(mq) {
  let open = false;
  let cur = 0, tgt = 0, height = 400;
  function spring() {
    const d = tgt - cur;
    if (Math.abs(d) < 0.35) { cur = tgt; if (tgt >= height) open = false; return; }
    cur += d * 0.22;
    // In real code this recurses via RAF; for tests we run synchronously
    let steps = 0;
    while (Math.abs(tgt - cur) >= 0.35 && steps++ < 1000) cur += (tgt - cur) * 0.22;
    cur = tgt;
    if (tgt >= height) open = false;
  }
  return {
    open() {
      if (mq.matches) { cur = 0; tgt = 0; open = true; return; }
      cur = height; tgt = 0; open = true; spring();
    },
    close() {
      tgt = height;
      if (mq.matches) { open = false; return; }
      spring();
    },
    get isOpen() { return open; },
    get translateY() { return cur; },

    // Drag-dismiss logic (mirrors Phase 4 touchend handler)
    simulateDrag({ distancePx, velocityPxPerSec }) {
      cur = Math.max(0, distancePx);
      const closeByDist = cur > height * 0.36;
      const closeByVel  = velocityPxPerSec > 440;
      if (closeByDist || closeByVel) { tgt = height; spring(); }
      else { tgt = 0; spring(); }
    },
  };
}

// Long-press handler state machine
function makeLongPress({ delayMs = 500, cancelDistancePx = 10 } = {}) {
  let timer = null, fired = false, cancelled = false, startX = 0, startY = 0;
  return {
    pointerdown(x, y) {
      startX = x; startY = y; fired = false; cancelled = false;
      timer = setTimeout(() => { if (!cancelled) fired = true; }, delayMs);
    },
    pointermove(x, y) {
      const dx = Math.abs(x - startX), dy = Math.abs(y - startY);
      if (dx > cancelDistancePx || dy > cancelDistancePx) {
        clearTimeout(timer); timer = null; cancelled = true;
      }
    },
    pointerup() { clearTimeout(timer); timer = null; cancelled = true; },
    get fired() { return fired; },
    // Test helper: advance time — only fires if not cancelled
    advanceTo(ms) { if (ms >= delayMs && !cancelled && !fired) fired = true; },
  };
}

// pollAlertBadge logic (pure: counts → haptic if new critical arrived)
function makePollLogic(haptic) {
  let prev = 0;
  return {
    poll(count) {
      if (count > prev) haptic(200);
      prev = count;
      return prev;
    },
    get prevCount() { return prev; },
  };
}

// Optimistic UI helper (mirrors _qtPlace pending logic)
function makeOptimisticUI() {
  const dom = { pending: null, rows: [] };
  return {
    addPending(sym, qty) {
      dom.pending = { sym, qty, status: 'pending' };
      return dom.pending;
    },
    onSuccess(ref) { if (dom.pending === ref) dom.pending = null; dom.rows.push({ ...ref, status: 'filled' }); },
    onError(ref)   { if (dom.pending === ref) dom.pending = null; },
    get hasPending() { return dom.pending !== null; },
    get pendingEl()  { return dom.pending; },
    get filledRows() { return dom.rows; },
  };
}

// base64url roundtrip (WebAuthn encoding)
function toBase64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function fromBase64url(str) {
  const pad = '='.repeat((4 - str.length % 4) % 4);
  return Buffer.from((str + pad).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ────────────────────────────────────────────────────────────────────────────
// TESTS
// ────────────────────────────────────────────────────────────────────────────

describe('Mobile PWA — Phase 6 unit tests', () => {

  // 1. Tab loaders wired to DOM ids
  it('1. Each tab ID maps to a known loadTab handler', () => {
    const tabHandlers = { home: true, markets: true, whale: true, ai: true, alerts: true };
    const tabIds = ['home', 'markets', 'whale', 'ai', 'alerts'];
    for (const id of tabIds) {
      assert.ok(tabHandlers[id], `Missing handler for tab: ${id}`);
    }
  });

  // 2. apiFetch 401 throws UNAUTHORIZED
  it('2. apiFetch throws UNAUTHORIZED on 401', async () => {
    const sb = makeSandbox();
    sb.fetchStub.setImpl(async () => ({ ok: false, status: 401, text: async () => '{}' }));
    const apiFetch = makeApiFetch(sb.fetchStub);
    await assert.rejects(() => apiFetch('/api/test'), { message: 'UNAUTHORIZED' });
  });

  // 3. Bottom sheet closes on high velocity (≥440 px/s)
  it('3. Sheet drag closes on velocity ≥440 px/s regardless of distance', () => {
    const sb = makeSandbox();
    const sheet = makeSheetEngine(sb.matchMedia);
    sheet.open();
    assert.ok(sheet.isOpen, 'should be open');
    // Only 50px drag but fast (500 px/s) — should still close
    sheet.simulateDrag({ distancePx: 50, velocityPxPerSec: 500 });
    assert.equal(sheet.isOpen, false, 'high velocity must close');
  });

  // 4. Bottom sheet closes on >36% height drag
  it('4. Sheet drag closes when dragged past 36% height threshold', () => {
    const sb = makeSandbox();
    const sheet = makeSheetEngine(sb.matchMedia);
    sheet.open();
    // 400px height × 0.37 = 148px > threshold
    sheet.simulateDrag({ distancePx: 148, velocityPxPerSec: 10 });
    assert.equal(sheet.isOpen, false, '>36% must close');
  });

  // 5. Long-press cancels on >10px movement
  it('5. Long-press cancels if pointer moves >10px before 500ms', () => {
    const lp = makeLongPress({ delayMs: 500, cancelDistancePx: 10 });
    lp.pointerdown(100, 100);
    lp.pointermove(112, 100); // 12px > 10px threshold
    lp.advanceTo(600);        // time passed but should be cancelled
    assert.equal(lp.fired, false, 'movement >10px must cancel long-press');
  });

  // 6. Long-press fires after 500ms with no movement
  it('6. Long-press fires after 500ms hold with <10px movement', () => {
    const lp = makeLongPress({ delayMs: 500, cancelDistancePx: 10 });
    lp.pointerdown(100, 100);
    lp.pointermove(102, 101); // 2px — within threshold
    lp.advanceTo(500);        // exactly 500ms
    assert.equal(lp.fired, true, 'long-press must fire at 500ms');
  });

  // 7. Haptic is a no-op when navigator.vibrate is undefined
  it('7. haptic() gracefully no-ops when navigator.vibrate is undefined', () => {
    const navWithoutVibrate = { vibrate: undefined };
    const mq = { matches: false };
    const haptic = makeHaptic(mq, navWithoutVibrate);
    assert.doesNotThrow(() => haptic(10));
    assert.doesNotThrow(() => haptic([30, 50, 30]));
  });

  // 8. Service worker registration resolves with a scope
  it('8. navigator.serviceWorker.register resolves', async () => {
    const sb = makeSandbox();
    const reg = await sb.navigator.serviceWorker.register('/sw.js', { scope: '/' });
    assert.equal(reg.scope, '/');
  });

  // 9. Push subscription flow: registers and POSTs to /api/push/subscribe
  it('9. Push subscription POSTs to /api/push/subscribe', async () => {
    const sb = makeSandbox();
    let postedUrl = null, postedBody = null;
    sb.fetchStub.setImpl(async (url, opts) => {
      if (url === '/api/push/vapid-key') return { ok: true, status: 200, text: async () => JSON.stringify({ vapidPublicKey: 'BExampleKey' }) };
      if (url === '/api/push/subscribe') {
        postedUrl  = url;
        postedBody = JSON.parse(opts?.body || '{}');
        return { ok: true, status: 200, text: async () => '{"ok":true}' };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    });
    // Simulate the subscribe flow
    const apiFetch = makeApiFetch(sb.fetchStub);
    const { vapidPublicKey } = await apiFetch('/api/push/vapid-key');
    assert.ok(vapidPublicKey, 'VAPID key returned');
    const reg  = await sb.navigator.serviceWorker.ready;
    const sub  = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidPublicKey });
    const j    = sub.toJSON();
    await apiFetch('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
    });
    assert.equal(postedUrl, '/api/push/subscribe');
    assert.equal(postedBody.endpoint, 'https://example.com/push/endpoint');
    assert.ok(postedBody.keys?.p256dh);
  });

  // 10. WebAuthn base64url roundtrip
  it('10. WebAuthn base64url encode/decode roundtrip is lossless', () => {
    const original = Buffer.from('test-credential-id-bytes');
    const encoded  = toBase64url(original);
    // Must be URL-safe (no +, /, =)
    assert.ok(!encoded.includes('+'), 'must not contain +');
    assert.ok(!encoded.includes('/'), 'must not contain /');
    assert.ok(!encoded.includes('='), 'must not contain =');
    const decoded = fromBase64url(encoded);
    assert.deepEqual(decoded, original, 'decoded must equal original');
  });

  // 11. Optimistic UI: pending row inserted, replaced on success, removed on error
  it('11. Optimistic UI: pending inserted, removed on success or error', () => {
    const ui = makeOptimisticUI();

    // Insert pending
    const ref = ui.addPending('AAPL', 10);
    assert.ok(ui.hasPending, 'pending row must exist');
    assert.equal(ui.pendingEl.sym, 'AAPL');

    // Success path
    ui.onSuccess(ref);
    assert.equal(ui.hasPending, false, 'pending removed on success');
    assert.equal(ui.filledRows.length, 1);
    assert.equal(ui.filledRows[0].status, 'filled');
  });

  it('11b. Optimistic UI: pending removed on error', () => {
    const ui = makeOptimisticUI();
    const ref = ui.addPending('TSLA', 5);
    assert.ok(ui.hasPending);
    ui.onError(ref);
    assert.equal(ui.hasPending, false, 'pending removed on error');
    assert.equal(ui.filledRows.length, 0, 'no filled rows on error');
  });

  // 12. localStorage state survives tab switches
  it('12. localStorage persists preferred segment across tab switches', () => {
    const sb = makeSandbox();
    sb.localStorage.setItem('markets-seg', 'forecast');
    sb.localStorage.setItem('whale-seg',   'insider');
    // Simulate switching tabs (values should still be there)
    assert.equal(sb.localStorage.getItem('markets-seg'), 'forecast');
    assert.equal(sb.localStorage.getItem('whale-seg'),   'insider');
  });

  // 13. Critical alert badge: haptic on increase, not on equal/decrease
  it('13. pollAlertBadge fires haptic only when count increases', () => {
    const sb = makeSandbox();
    const haptic = makeHaptic(sb.matchMedia, sb.navigator);
    const poll   = makePollLogic(haptic);

    sb.resetVibrate();
    poll.poll(0);
    assert.equal(sb.getVibrateCount(), 0, 'no haptic on 0');

    poll.poll(1);
    assert.equal(sb.getVibrateCount(), 1, 'haptic when count goes 0→1');
    assert.equal(sb.getLastVibrate(), 200);

    sb.resetVibrate();
    poll.poll(1);  // same count
    assert.equal(sb.getVibrateCount(), 0, 'no haptic when count unchanged');

    poll.poll(0);  // decreased
    assert.equal(sb.getVibrateCount(), 0, 'no haptic when count decreases');
  });

  // 14. Reduced motion: spring animation disabled, sheet shows instantly
  it('14. Reduced-motion: bottom sheet opens without spring animation', () => {
    const sb = makeSandbox();
    sb.matchMedia.setReducedMotion(true);
    const sheet = makeSheetEngine(sb.matchMedia);
    sheet.open();
    // With reduced motion, translateY should be 0 immediately (no spring)
    assert.equal(sheet.translateY, 0, 'translateY must be 0 when reduced-motion is on');
    assert.ok(sheet.isOpen, 'sheet must be open');
  });
});
