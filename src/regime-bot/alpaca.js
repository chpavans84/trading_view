/**
 * regime-bot/alpaca.js
 *
 * Thin Alpaca Paper API wrapper for the regime-bot.
 * Uses ALPACA_API_KEY + ALPACA_SECRET_KEY from .env (same vars as src/core/trader.js).
 *
 * Completely isolated from B-3.7 — never reads or writes the `trades` table.
 * All orders carry a client_order_id prefix 'rgb-' for identification.
 *
 * Exports:
 *   placeOrder({ symbol, side, notional_usd?, qty?, notes? })
 *   closePosition(symbol)
 *   getPosition(symbol)   → position object or null
 *   getPositions()        → array of all open positions
 *   getAccount()          → { buying_power, portfolio_value, cash, ... }
 */

const BASE   = 'https://paper-api.alpaca.markets';
const PREFIX = 'rgb-';   // "regime-bot" tag on every order

// ─── Auth ────────────────────────────────────────────────────────────────────

function getHeaders() {
  const key    = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) {
    throw new Error('[regime-bot/alpaca] ALPACA_API_KEY or ALPACA_SECRET_KEY not set in env');
  }
  return {
    'APCA-API-KEY-ID':     key,
    'APCA-API-SECRET-KEY': secret,
    'Content-Type':        'application/json',
  };
}

async function apiFetch(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: getHeaders(),
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.message || json?.code || res.statusText || res.status;
    throw new Error(`Alpaca ${method} ${path} → HTTP ${res.status}: ${msg}`);
  }
  return json;
}

// ─── Orders ──────────────────────────────────────────────────────────────────

/**
 * Place a market order.
 *
 * @param {object} opts
 * @param {string}  opts.symbol        Ticker (e.g. 'AAPL', 'BRK-B')
 * @param {string}  opts.side          'buy' | 'sell'
 * @param {number}  [opts.notional_usd] Dollar amount — used for buy (fractional shares)
 * @param {number}  [opts.qty]          Integer shares — used for sell
 * @param {string}  [opts.notes]        Free-text tag carried in client_order_id
 * @returns {Promise<{ alpaca_order_id, client_order_id, status, symbol, side }>}
 */
export async function placeOrder({ symbol, side, notional_usd, qty, notes = '' }) {
  const tag  = `${PREFIX}${side[0]}-${symbol}-${Date.now()}`.slice(0, 48);
  const body = {
    symbol,
    side,
    type:            'market',
    time_in_force:   'day',
    client_order_id: tag,
  };

  if (side === 'buy' && notional_usd != null) {
    body.notional = notional_usd.toFixed(2);  // fractional dollar-notional buy
  } else if (qty != null) {
    body.qty = String(Math.floor(Math.abs(qty)));
  } else {
    throw new Error(`placeOrder(${symbol}): must supply notional_usd for buys or qty for sells`);
  }

  const order = await apiFetch('POST', '/v2/orders', body);
  return {
    alpaca_order_id: order.id,
    client_order_id: tag,
    status:          order.status,
    symbol,
    side,
  };
}

// ─── Positions ───────────────────────────────────────────────────────────────

/**
 * Close an entire open position at market. Idempotent — returns
 * { ok: true, skipped: true } if no position exists.
 *
 * @param {string} symbol
 * @returns {Promise<{ ok, symbol, order_id, skipped? }>}
 */
export async function closePosition(symbol) {
  try {
    const result = await apiFetch('DELETE', `/v2/positions/${encodeURIComponent(symbol)}`);
    return { ok: true, symbol, order_id: result?.id ?? null };
  } catch (e) {
    if (e.message.includes('404') || /no.*position/i.test(e.message) || /not.*found/i.test(e.message)) {
      return { ok: true, symbol, order_id: null, skipped: true };
    }
    throw e;
  }
}

/**
 * Get a single open position, or null if not held.
 *
 * @param {string} symbol
 * @returns {Promise<object|null>}
 */
export async function getPosition(symbol) {
  try {
    return await apiFetch('GET', `/v2/positions/${encodeURIComponent(symbol)}`);
  } catch (e) {
    if (e.message.includes('404')) return null;
    throw e;
  }
}

/**
 * Get all open positions on the paper account.
 *
 * @returns {Promise<Array<object>>}
 */
export async function getPositions() {
  return (await apiFetch('GET', '/v2/positions')) ?? [];
}

// ─── Account ─────────────────────────────────────────────────────────────────

/**
 * Get account summary.
 * Key fields: buying_power, portfolio_value, cash, equity.
 *
 * @returns {Promise<object>}
 */
export async function getAccount() {
  return apiFetch('GET', '/v2/account');
}
