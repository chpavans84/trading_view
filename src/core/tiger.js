import crypto from 'crypto';

const BASE_URL = 'https://openapi.tigerfintech.com';
const ENDPOINT = '/gateway';

function timestamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Sort params alphabetically, concat as key=value& (excludes sign field)
function buildSignStr(params) {
  return Object.keys(params)
    .filter(k => k !== 'sign' && params[k] != null && params[k] !== '')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
}

// Tiger uses RSA + SHA1 (PKCS1v15). Private key must be PKCS#1 PEM.
// The portal gives a raw base64 string — wrap it here.
function normalisePem(rawKey) {
  // Already a full PEM — pass through
  if (rawKey.includes('-----')) return rawKey;
  // Raw base64 from Tiger portal — wrap as PKCS#1
  const clean = rawKey.replace(/[\s\r\n]/g, '');
  const lines  = clean.match(/.{1,64}/g).join('\n');
  return `-----BEGIN RSA PRIVATE KEY-----\n${lines}\n-----END RSA PRIVATE KEY-----`;
}

function signData(rawKey, data) {
  const pem = normalisePem(rawKey);
  const s = crypto.createSign('RSA-SHA1');
  s.update(data, 'utf8');
  return s.sign(pem, 'base64');
}

// Compact JSON with sorted keys — matches Python SDK json.dumps(sort_keys=True, separators=(',',':'))
function compactJson(obj) {
  return JSON.stringify(
    Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]]))
  );
}

async function request(creds, method, bizExtra = {}) {
  const { tiger_id, private_key, account } = creds;
  const biz_content = compactJson({ account, ...bizExtra });

  const params = {
    tiger_id,
    charset:   'UTF-8',
    sign_type: 'RSA',
    version:   '1.0',
    timestamp: timestamp(),
    method,
    biz_content,
  };

  params.sign = signData(private_key, buildSignStr(params));

  const res = await fetch(`${BASE_URL}${ENDPOINT}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body:    JSON.stringify(params),
    signal:  AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Tiger API HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) {
    const msg = json.message || json.msg || 'unknown error';
    console.error(`[tiger] API error code=${json.code} method=${method} msg=${msg}`, JSON.stringify(json).slice(0, 400));
    throw new Error(`Tiger error ${json.code}: ${msg}`);
  }
  return json.data;
}

export async function validateTigerCreds(creds) {
  try {
    await request(creds, 'accounts');
    return true;
  } catch (e) {
    console.error('[tiger] validate failed:', e.message);
    return false;
  }
}

export async function getTigerFunds(creds) {
  const raw  = await request(creds, 'assets');
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const item = data?.items?.[0] || data;
  // Sum grossPositionValue across segments (top-level item doesn't have it)
  const grossPos = (item.segments || []).reduce((s, seg) => s + (seg.grossPositionValue || 0), 0);
  return {
    net_liquidation_value: item.netLiquidation   ?? 0,
    buying_power:          item.buyingPower       ?? 0,
    cash:                  item.cashValue         ?? 0,
    gross_position_value:  grossPos,
    unrealized_pl:         item.unrealizedPnL     ?? 0,
    realized_pl:           item.realizedPnL       ?? 0,
  };
}

export async function getTigerPositions(creds) {
  const raw = await request(creds, 'positions');
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return data?.items ?? (Array.isArray(data) ? data : []);
}

export async function getTigerOrders(creds, { days = 30 } = {}) {
  const end   = Date.now();
  const start = end - days * 24 * 60 * 60 * 1000;
  try {
    const raw  = await request(creds, 'orders', { start_time: start, end_time: end });
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return data?.items ?? (Array.isArray(data) ? data : []);
  } catch {
    return [];
  }
}

// Place a market or limit order on Tiger.
// Returns { order_id, symbol, action, qty, order_type, status }
export async function placeTigerOrder(creds, { symbol, side, qty, limitPrice = null, outsideRth = true }) {
  const action     = side.toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
  const order_type = limitPrice ? 'LMT' : 'MKT';
  const biz = {
    symbol,
    market:         'US',
    sec_type:       'STK',
    currency:       'USD',
    action,
    order_type,
    total_quantity: qty,
    ...(limitPrice ? { limit_price: limitPrice } : {}),
    time_in_force:  'DAY',
    outside_rth:    outsideRth,
  };
  console.log(`[tiger] placing order: ${action} ${qty} ${symbol} @ ${order_type}${limitPrice ? ' $'+limitPrice : ''}`);
  const raw  = await request(creds, 'order', biz);
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const id   = data?.id ?? data?.order_id ?? data?.orderId;
  return { order_id: id, symbol, action, qty, order_type, status: data?.status ?? 'submitted', raw: data };
}

// Cancel a specific Tiger order by ID.
export async function cancelTigerOrder(creds, orderId) {
  const raw  = await request(creds, 'cancel_order', { id: orderId });
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { ok: true, order_id: orderId, result: data };
}

// Cancel all pending/open Tiger orders.
export async function cancelAllTigerOrders(creds) {
  const orders = await getTigerOrders(creds, { days: 1 });
  const pending = orders.filter(o => ['PENDING', 'NEW', 'PARTIALLY_FILLED', 'HELD'].includes((o.status || '').toUpperCase()));
  const results = await Promise.allSettled(pending.map(o => cancelTigerOrder(creds, o.id ?? o.order_id)));
  return { cancelled: pending.length, results: results.map(r => r.status) };
}

// Close an entire Tiger position at market. Looks up current qty automatically.
export async function closeTigerPosition(creds, symbol) {
  const positions = await getTigerPositions(creds);
  const pos = positions.find(p => (p.symbol || p.contract?.symbol || '').toUpperCase() === symbol.toUpperCase());
  if (!pos) throw new Error(`No open Tiger position for ${symbol}`);
  const qty = Math.abs(pos.quantity ?? pos.qty ?? pos.position ?? 0);
  if (qty < 1) throw new Error(`Tiger position for ${symbol} has zero quantity`);
  return await placeTigerOrder(creds, { symbol, side: 'SELL', qty });
}

// Get a live quote from Tiger (ask/bid/last).
export async function getTigerQuote(creds, symbol) {
  try {
    const raw  = await request(creds, 'quote_real_time', { symbols: [symbol] });
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const item = (data?.items ?? data ?? [])[0] ?? {};
    return { symbol, ask: item.askPrice ?? null, bid: item.bidPrice ?? null, last: item.latestPrice ?? null };
  } catch {
    return { symbol, ask: null, bid: null, last: null };
  }
}
