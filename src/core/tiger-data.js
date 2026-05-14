import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TIGER_ID  = process.env.TIGER_ID;
const KEY_PATH  = process.env.TIGER_PRIVATE_KEY;
const BASE_URL  = 'https://openapi.tigerfintech.com/gateway';

// Load private key once at startup
let _privateKey = null;
function getPrivateKey() {
  if (_privateKey) return _privateKey;
  if (!KEY_PATH) return null;
  try {
    _privateKey = fs.readFileSync(path.resolve(KEY_PATH), 'utf8');
    return _privateKey;
  } catch { return null; }
}

// MAC address — Tiger uses this as device_id to gate market data permissions
function getDeviceId() {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') return addr.mac;
    }
  }
  return null;
}

// RSA-SHA1 signing (Tiger uses SHA1 not SHA256)
function buildSign(params) {
  const pk = getPrivateKey();
  if (!pk) return '';
  const sortedKeys = Object.keys(params).filter(k => k !== 'sign' && params[k] != null && params[k] !== '').sort();
  const signStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
  const signer = crypto.createSign('SHA1');
  signer.update(signStr, 'utf8');
  return signer.sign(pk, 'base64');
}

// Generic Tiger API request
async function tigerRequest(method, bizContent) {
  if (!TIGER_ID || !getPrivateKey()) return null;
  const params = {
    tiger_id:    TIGER_ID,
    charset:     'UTF-8',
    sign_type:   'RSA',
    version:     '1.0',
    method,
    timestamp:   Date.now().toString(),
    biz_content: JSON.stringify(bizContent),
    device_id:   getDeviceId(),
  };
  params.sign = buildSign(params);
  try {
    const res = await fetch(BASE_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body:    JSON.stringify(params),
      signal:  AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// 30-second in-memory cache
const _cache = new Map();
const CACHE_TTL = 30_000;

// Tiger requires grab_quote_permission before any market data call (activates the session)
let _permGrabbed = false;
async function ensurePermission() {
  if (_permGrabbed) return;
  await tigerRequest('grab_quote_permission', {});
  _permGrabbed = true;
}

// getTigerQuote — uses kline/1min (last bar close) as a price proxy.
// usQuoteBasic does NOT support quote_real_time; kline is what the permission actually covers.
export async function getTigerQuote(symbol) {
  const sym = symbol.toUpperCase();
  const cached = _cache.get(sym);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  await ensurePermission();

  const result = await tigerRequest('kline', {
    symbol:     sym,
    period:     '1min',
    begin_time: -1,
    end_time:   -1,
    right:      'br',
    limit:      2,          // last 2 bars: [prev, current]
  });

  let raw;
  try { raw = typeof result?.data === 'string' ? JSON.parse(result.data) : result?.data; } catch { raw = null; }
  const items = raw?.items ?? [];
  if (!items.length) return null;

  const bar  = items[items.length - 1];
  const prev = items.length >= 2 ? items[items.length - 2] : null;
  const last = bar.close ?? null;
  if (!last) return null;

  const data = {
    symbol:   sym,
    last,
    open:     bar.open    ?? null,
    high:     bar.high    ?? null,
    low:      bar.low     ?? null,
    close:    last,
    volume:   bar.volume  ?? 0,
    chg_pct:  prev?.close ? +((last - prev.close) / prev.close * 100).toFixed(2) : null,
    bar_time: bar.time    ?? null,
    source:   'tiger_kline_1min',
  };
  _cache.set(sym, { ts: Date.now(), data });
  return data;
}

// getTigerKLines — historical OHLCV bars for any timeframe.
// period: '1min'|'3min'|'5min'|'15min'|'30min'|'60min'|'day'|'week'|'month'
export async function getTigerKLines(symbol, { period = 'day', limit = 100, right = 'br' } = {}) {
  const sym = symbol.toUpperCase();
  await ensurePermission();

  const result = await tigerRequest('kline', {
    symbol:     sym,
    period,
    begin_time: -1,
    end_time:   -1,
    right,
    limit,
  });

  let raw;
  try { raw = typeof result?.data === 'string' ? JSON.parse(result.data) : result?.data; } catch { raw = null; }
  const items = raw?.items ?? [];

  return items.map(b => ({
    time:   b.time,
    open:   b.open,
    high:   b.high,
    low:    b.low,
    close:  b.close,
    volume: b.volume,
    amount: b.amount ?? null,
  }));
}

// getTigerOptionExpiry — list of upcoming expiration dates for a symbol.
export async function getTigerOptionExpiry(symbol) {
  await ensurePermission();
  const result = await tigerRequest('option_expiration', { symbols: [symbol.toUpperCase()], market: 'US' });
  const item = Array.isArray(result?.data) ? result.data[0] : null;
  return item?.dates ?? [];
}

export function isTigerConfigured() {
  return !!(TIGER_ID && KEY_PATH && getPrivateKey());
}

// Self-test: node src/core/tiger-data.js
if (process.argv[1]?.endsWith('tiger-data.js')) {
  const syms = ['AAPL', 'NVDA', 'TSLA'];
  console.log('Tiger configured:', isTigerConfigured());
  for (const s of syms) {
    const q = await getTigerQuote(s);
    console.log(s, q ?? 'null');
  }
}
