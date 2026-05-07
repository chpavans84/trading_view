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

export async function getTigerQuote(symbol) {
  const sym = symbol.toUpperCase();
  const cached = _cache.get(sym);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  await ensurePermission();

  const result = await tigerRequest('quote_real_time', {
    symbols: [sym],
    market:  'US',
  });

  const item = result?.data?.items?.[0];
  if (!item) return null;

  const ask  = parseFloat(item.ask_price)    || null;
  const bid  = parseFloat(item.bid_price)    || null;
  const last = parseFloat(item.latest_price) || parseFloat(item.pre_price) || null;

  if (!ask && !bid && !last) return null;

  const data = {
    symbol,
    ask:    ask,
    bid:    bid,
    last:   last,
    mid:    ask && bid ? +((ask + bid) / 2).toFixed(4) : last,
    volume: parseInt(item.volume) || 0,
    source: 'tiger_nbbo',
  };
  _cache.set(sym, { ts: Date.now(), data });
  return data;
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
