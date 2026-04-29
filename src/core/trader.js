/**
 * Alpaca trading engine.
 * Paper trading by default (ALPACA_BASE_URL=https://paper-api.alpaca.markets)
 * Live account is read-only — no trades placed against live money automatically.
 */
import { closeTrade, getTrades } from './db.js';

// Paper account (bot trades here)
const BASE_URL   = process.env.ALPACA_BASE_URL   || 'https://paper-api.alpaca.markets';
const API_KEY    = process.env.ALPACA_API_KEY;
const SECRET_KEY = process.env.ALPACA_SECRET_KEY;

// Live account (view-only)
const LIVE_BASE_URL   = 'https://api.alpaca.markets';
const LIVE_API_KEY    = process.env.ALPACA_LIVE_API_KEY;
const LIVE_SECRET_KEY = process.env.ALPACA_LIVE_SECRET_KEY;

export function hasLiveAccount() {
  return !!(LIVE_API_KEY && LIVE_SECRET_KEY);
}

const HEADERS = {
  'APCA-API-KEY-ID':     API_KEY,
  'APCA-API-SECRET-KEY': SECRET_KEY,
  'Content-Type':        'application/json',
};

const LIVE_HEADERS = {
  'APCA-API-KEY-ID':     LIVE_API_KEY,
  'APCA-API-SECRET-KEY': LIVE_SECRET_KEY,
  'Content-Type':        'application/json',
};

async function alpaca(method, path, body, { live = false } = {}) {
  const url  = live ? LIVE_BASE_URL  : BASE_URL;
  const hdrs = live ? LIVE_HEADERS   : HEADERS;
  if (live && method !== 'GET') throw new Error('Live account is read-only — trades blocked for safety');
  const r = await fetch(`${url}${path}`, {
    method,
    headers: hdrs,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Alpaca ${method} ${path}: ${data.message || r.status}`);
  return data;
}

// ─── Per-user Alpaca client (uses credentials stored in DB) ──────────────────

async function alpacaUser(method, path, { apiKey, secretKey, baseUrl }, body) {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'APCA-API-KEY-ID':     apiKey,
      'APCA-API-SECRET-KEY': secretKey,
      'Content-Type':        'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Alpaca ${method} ${path}: ${data.message || r.status}`);
  return data;
}

export async function getUserAccount(creds) {
  const a = await alpacaUser('GET', '/v2/account', creds);
  const isPaper = creds.baseUrl?.includes('paper');
  return {
    account_number:  a.account_number,
    status:          a.status,
    portfolio_value: parseFloat(a.portfolio_value),
    buying_power:    parseFloat(a.buying_power),
    cash:            parseFloat(a.cash),
    paper:           isPaper,
    live:            !isPaper,
    source:          isPaper ? 'alpaca_paper' : 'alpaca_live',
  };
}

export async function getUserPositions(creds) {
  const positions = await alpacaUser('GET', '/v2/positions', creds);
  return positions.map(p => ({
    symbol:            p.symbol,
    qty:               parseFloat(p.qty),
    avg_entry_price:   parseFloat(p.avg_entry_price),
    current_price:     parseFloat(p.current_price),
    market_value:      parseFloat(p.market_value),
    unrealized_pl:     parseFloat(p.unrealized_pl),
    unrealized_pl_pct: parseFloat(p.unrealized_plpc) * 100,
    side:              p.side,
  }));
}

export async function validateAlpacaCreds(creds) {
  try {
    await alpacaUser('GET', '/v2/account', creds);
    return true;
  } catch {
    return false;
  }
}

export async function getUserDailyPnL(creds) {
  const cacheKey = creds.apiKey;
  const now = Date.now();
  const cached = _userPnlCache.get(cacheKey);
  if (cached && now - cached.ts < PNL_CACHE_TTL) return cached.result;
  try {
    const data = await alpacaUser('GET', '/v2/account/portfolio/history?period=1D&timeframe=5Min&intraday_reporting=market_hours', creds);
    const pnlArr    = (data.profit_loss     || []).filter(v => v != null);
    const pnlPctArr = (data.profit_loss_pct || []).filter(v => v != null);
    if (!pnlArr.length) return { pnl: 0, available: false };
    const pnl     = pnlArr[pnlArr.length - 1] ?? 0;
    const pnl_pct = pnlPctArr.length ? (pnlPctArr[pnlPctArr.length - 1] * 100) : 0;
    const result = { pnl: parseFloat(pnl.toFixed(2)), pnl_pct: +pnl_pct.toFixed(3), available: true };
    _userPnlCache.set(cacheKey, { result, ts: now });
    return result;
  } catch { return { pnl: 0, available: false }; }
}

export async function getUserPortfolioHistory(creds, { days = 30 } = {}) {
  try {
    const data = await alpacaUser('GET', `/v2/account/portfolio/history?period=${days}D&timeframe=1D&intraday_reporting=market_hours`, creds);
    if (!data.timestamp?.length) return [];
    const etNow = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const etDate = new Date(etNow);
    const todayStr = `${etDate.getFullYear()}-${String(etDate.getMonth()+1).padStart(2,'0')}-${String(etDate.getDate()).padStart(2,'0')}`;

    // Alpaca daily bars use midnight UTC timestamps = 8 PM ET of the PRIOR calendar day.
    // Must extract the ET date (not UTC date) to get the correct trading day label.
    const rows = [];
    for (let i = 0; i < data.timestamp.length; i++) {
      const eq = data.equity?.[i];
      if (eq == null || eq === 0) continue;
      const date = new Date(data.timestamp[i] * 1000)
        .toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // en-CA → YYYY-MM-DD
      if (date === todayStr) continue;
      rows.push({
        date,
        equity: parseFloat(eq.toFixed(2)),
        pnl:    parseFloat((data.profit_loss?.[i] ?? 0).toFixed(2)),
      });
    }
    return rows;
  } catch { return []; }
}

export async function getUserOrders(creds, { status = 'all', limit = 50 } = {}) {
  const orders = await alpacaUser('GET', `/v2/orders?status=${status}&limit=${limit}&direction=desc`, creds);
  return orders.map(o => ({
    symbol:           o.symbol,
    side:             o.side,
    qty:              parseFloat(o.qty || 0),
    entry_price:      parseFloat(o.filled_avg_price || o.limit_price || 0),
    status:           o.status,
    opened_at:        o.created_at,
    filled_at:        o.filled_at,
    pnl_usd:          null,
    source:           'alpaca_user',
  }));
}

// ─── Account ──────────────────────────────────────────────────────────────────

function parseAccount(a, isLive = false) {
  return {
    account_number:  a.account_number,
    status:          a.status,
    portfolio_value: parseFloat(a.portfolio_value),
    buying_power:    parseFloat(a.buying_power),
    cash:            parseFloat(a.cash),
    paper:           !isLive,
    live:            isLive,
  };
}

export async function getAccount() {
  const a = await alpaca('GET', '/v2/account');
  return parseAccount(a, false);
}

export async function getLiveAccount() {
  const a = await alpaca('GET', '/v2/account', undefined, { live: true });
  return parseAccount(a, true);
}

// ─── Positions ────────────────────────────────────────────────────────────────

function parsePositions(positions) {
  return positions.map(p => ({
    symbol:            p.symbol,
    name:              null,
    qty:               parseFloat(p.qty),
    avg_entry_price:   parseFloat(p.avg_entry_price),
    current_price:     parseFloat(p.current_price),
    market_value:      parseFloat(p.market_value),
    unrealized_pl:     parseFloat(p.unrealized_pl),
    unrealized_pl_pct: parseFloat(p.unrealized_plpc) * 100,
    side:              p.side,
  }));
}

export async function getPositions() {
  const positions = await alpaca('GET', '/v2/positions');
  return parsePositions(positions);
}

export async function getLivePositions() {
  const positions = await alpaca('GET', '/v2/positions', undefined, { live: true });
  return parsePositions(positions);
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export async function getOrders({ status = 'open' } = {}) {
  return alpaca('GET', `/v2/orders?status=${status}&limit=20`);
}

export async function getLiveOrders({ status = 'open' } = {}) {
  return alpaca('GET', `/v2/orders?status=${status}&limit=20`, undefined, { live: true });
}

export async function cancelOrder(orderId) {
  await alpaca('DELETE', `/v2/orders/${orderId}`);
  return { cancelled: orderId };
}

export async function cancelAllOrders() {
  await alpaca('DELETE', '/v2/orders');
  return { cancelled: 'all' };
}

// Move stop-loss to entry price once a position is sufficiently profitable.
// Finds the active stop order for the symbol and patches it via Alpaca API.
export async function moveStopToBreakeven(symbol) {
  const [openOrders, position] = await Promise.all([
    alpaca('GET', `/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}&limit=20`),
    alpaca('GET', `/v2/positions/${encodeURIComponent(symbol)}`),
  ]);

  const entryPrice   = parseFloat(position.avg_entry_price);
  const currentPrice = parseFloat(position.current_price);
  const unrealizedPct = parseFloat(position.unrealized_plpc) * 100;

  const stopOrder = Array.isArray(openOrders)
    ? openOrders.find(o => o.symbol === symbol && (o.type === 'stop' || o.type === 'stop_limit'))
    : null;

  if (!stopOrder) throw new Error(`No stop order found for ${symbol} — may already be using a trailing stop`);

  const oldStop = parseFloat(stopOrder.stop_price || 0);

  const r = await fetch(`${BASE_URL}/v2/orders/${stopOrder.id}`, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify({ stop_price: +entryPrice.toFixed(2) }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || 'Failed to modify stop order');

  return {
    symbol,
    entry_price:    entryPrice,
    old_stop:       oldStop,
    new_stop:       entryPrice,
    current_price:  currentPrice,
    unrealized_pct: +unrealizedPct.toFixed(2),
  };
}

// ─── Daily P&L Targets ───────────────────────────────────────────────────────

export const DAILY_PROFIT_TARGET = 150;  // stop trading when we hit $150 profit
export const DAILY_LOSS_LIMIT    = 200;  // stop trading when we lose $200

// Shared in-process cache so /api/dashboard and /api/pnl always return the same value
const _pnlCache = { admin: null, ts: 0 };
const _userPnlCache = new Map(); // username → { result, ts }
const PNL_CACHE_TTL = 90_000; // 90 seconds

export async function getDailyPnL() {
  const now = Date.now();
  if (_pnlCache.admin && now - _pnlCache.ts < PNL_CACHE_TTL) return _pnlCache.admin;
  try {
    const r = await fetch(
      `${BASE_URL}/v2/account/portfolio/history?period=1D&timeframe=5Min&intraday_reporting=market_hours`,
      { headers: HEADERS }
    );
    if (!r.ok) return { pnl: 0, pnl_pct: 0, available: false };
    const d = await r.json();

    const pnlArr    = (d.profit_loss     || []).filter(v => v != null);
    const pnlPctArr = (d.profit_loss_pct || []).filter(v => v != null);
    const pnl       = pnlArr.length     > 0 ? pnlArr[pnlArr.length - 1]         : 0;
    const pnl_pct   = pnlPctArr.length  > 0 ? pnlPctArr[pnlPctArr.length - 1] * 100 : 0;

    const result = {
      pnl:                  +pnl.toFixed(2),
      pnl_pct:              +pnl_pct.toFixed(3),
      available:            true,
      daily_target:         DAILY_PROFIT_TARGET,
      daily_loss_limit:     -DAILY_LOSS_LIMIT,
      target_reached:       pnl >= DAILY_PROFIT_TARGET,
      loss_limit_reached:   pnl <= -DAILY_LOSS_LIMIT,
      remaining_to_target:  +Math.max(0, DAILY_PROFIT_TARGET - pnl).toFixed(2),
    };
    _pnlCache.admin = result;
    _pnlCache.ts    = now;
    return result;
  } catch (e) {
    return { pnl: 0, pnl_pct: 0, available: false, error: e.message };
  }
}

// ─── Portfolio History (daily P&L for the past N days) ───────────────────────

export async function getPortfolioHistory({ days = 30 } = {}) {
  try {
    // Alpaca supports: period=1M (calendar month), 3M, 6M, 1A, or use date_start
    const period = days <= 30 ? '1M' : days <= 90 ? '3M' : '6M';
    const r = await fetch(
      `${BASE_URL}/v2/account/portfolio/history?period=${period}&timeframe=1D&intraday_reporting=market_hours`,
      { headers: HEADERS }
    );
    if (!r.ok) return [];
    const d = await r.json();

    const timestamps = d.timestamp   || [];
    const equityArr  = d.equity      || [];
    const plArr      = d.profit_loss || [];

    // Alpaca daily bars use midnight UTC = 8 PM ET of prior day — must use ET for correct date.
    const rows = [];
    for (let i = 0; i < timestamps.length; i++) {
      const eq = equityArr[i];
      if (!eq) continue;
      const date = new Date(timestamps[i] * 1000)
        .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      rows.push({ date, pnl: +(plArr[i] ?? 0).toFixed(2), equity: +eq.toFixed(2) });
    }

    // Trim to requested window
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return rows.filter(r => new Date(r.date) >= cutoff);
  } catch {
    return [];
  }
}

// ─── Time-of-Day Filter ───────────────────────────────────────────────────────

export function isBadTradingTime() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const t  = et.getHours() * 60 + et.getMinutes();

  if (t >= 9 * 60 + 30 && t < 9 * 60 + 45)
    return { bad: true,  reason: 'Opening gap chaos (9:30–9:45 AM ET) — extreme spreads and reversals' };
  if (t >= 11 * 60 + 30 && t < 14 * 60)
    return { bad: true,  reason: 'Midday chop (11:30 AM–2:00 PM ET) — low volume, no clean trends' };
  if (t >= 15 * 60 + 30)
    return { bad: true,  reason: 'Closing volatility (3:30 PM ET+) — erratic end-of-day moves' };
  if (t < 9 * 60 + 30 || t >= 16 * 60)
    return { bad: true,  reason: 'Market closed' };
  return { bad: false, reason: null };
}

// ─── ATR-based Stop/Target Sizing ─────────────────────────────────────────────

async function fetchATR(symbol) {
  // Try Moomoo real-time candles first
  try {
    const { getAtrPct } = await import('./moomoo-tcp.js');
    const atr = await getAtrPct({ symbol, period: 14 });
    if (atr != null) return atr;
  } catch { /* fall through */ }

  // Yahoo Finance fallback
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=30d`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const q = d?.chart?.result?.[0]?.indicators?.quote?.[0];
    if (!q) return null;

    const highs  = q.high?.filter(v => v != null)  || [];
    const lows   = q.low?.filter(v => v != null)   || [];
    const closes = q.close?.filter(v => v != null)  || [];
    if (highs.length < 14) return null;

    const bars = Math.min(14, highs.length);
    const trValues = [];
    for (let i = highs.length - bars; i < highs.length; i++) {
      trValues.push(highs[i] - lows[i]);
    }
    const atr = trValues.reduce((a, b) => a + b, 0) / trValues.length;
    const price = closes[closes.length - 1];
    return price > 0 ? +((atr / price) * 100).toFixed(2) : null;
  } catch { return null; }
}

// ─── Quote ────────────────────────────────────────────────────────────────────

export async function getLatestPrice(symbol) {
  const r = await fetch(
    `https://data.alpaca.markets/v2/stocks/${symbol}/quotes/latest`,
    { headers: HEADERS }
  );
  const d = await r.json();
  const q = d?.quote;
  if (!q) throw new Error(`No quote for ${symbol}`);
  const mid = ((q.ap || 0) + (q.bp || 0)) / 2;
  return { symbol, ask: q.ap, bid: q.bp, mid: +mid.toFixed(4) };
}

// ─── Place Trade (bracket order: entry + stop loss + take profit) ─────────────

const MIN_ATR_PCT          = 1.0;   // skip stocks that don't move enough intraday
const TARGET_PROFIT_DOLLARS = 150;  // size position to earn this per winning trade
const MIN_POSITION_DOLLARS  = 1500;
const MAX_POSITION_DOLLARS  = 5000;

// ─── Market Regime ────────────────────────────────────────────────────────────
// VIX thresholds: above 25 = defensive (cut size 50%), above 35 = no new longs

export async function getMarketRegime({ defensive_vix = 25, crisis_vix = 35 } = {}) {
  try {
    const r = await fetch(
      'https://query2.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=2d',
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }
    );
    if (!r.ok) return { vix: null, regime: 'normal', size_multiplier: 1.0, block_longs: false };
    const d = await r.json();
    const closes = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null) ?? [];
    const vix = closes.length ? +closes[closes.length - 1].toFixed(2) : null;

    if (vix === null)       return { vix: null, regime: 'normal',    size_multiplier: 1.0, block_longs: false };
    if (vix > crisis_vix)   return { vix,       regime: 'crisis',    size_multiplier: 0.0, block_longs: true,  reason: `VIX ${vix} — extreme fear, no new longs` };
    if (vix > defensive_vix) return { vix,      regime: 'defensive', size_multiplier: 0.5, block_longs: false, reason: `VIX ${vix} — elevated fear, position size halved` };
    return                         { vix,       regime: 'normal',    size_multiplier: 1.0, block_longs: false };
  } catch {
    return { vix: null, regime: 'normal', size_multiplier: 1.0, block_longs: false };
  }
}

export async function placeTrade({
  symbol,
  side = 'buy',
  dollars = null,           // explicit override — if null, auto-sized from ATR
  stop_loss_pct   = 3,
  take_profit_pct = 7,
  use_atr = true,
  trailing_stop = false,    // true = trailing stop instead of fixed bracket
  note = '',
  userCfg = null,           // per-user bot config (from getUserBotConfig)
}) {
  const sizing  = userCfg?.position_sizing  || {};
  const vixT    = userCfg?.vix_thresholds   || {};
  const minAtrPct       = sizing.min_atr_pct             ?? MIN_ATR_PCT;
  const targetProfit    = sizing.target_profit_per_trade  ?? TARGET_PROFIT_DOLLARS;
  const minPos          = sizing.min_dollars              ?? MIN_POSITION_DOLLARS;
  const maxPos          = sizing.max_dollars              ?? MAX_POSITION_DOLLARS;
  const stopMult        = sizing.stop_multiplier          ?? 1.5;
  const targetMult      = sizing.target_multiplier        ?? 3.0;

  // Duplicate check — refuse if we already hold this symbol on Alpaca
  const existingPositions = await getPositions();
  const alreadyOpen = existingPositions.find(p => p.symbol === symbol.toUpperCase());
  if (alreadyOpen)
    throw new Error(`Duplicate blocked: already holding ${alreadyOpen.qty} shares of ${symbol} (avg $${alreadyOpen.avg_entry_price})`);

  // Market regime check — respects user's VIX thresholds
  const regime = await getMarketRegime({ defensive_vix: vixT.defensive ?? 25, crisis_vix: vixT.crisis ?? 35 });
  if (side === 'buy' && regime.block_longs)
    throw new Error(`Trade blocked: ${regime.reason}`);

  // Get current price
  const quote = await getLatestPrice(symbol);
  const price = side === 'buy' ? quote.ask : quote.bid;
  if (!price || price <= 0) throw new Error(`Invalid price for ${symbol}: ${price}`);

  // ATR-based dynamic stop/target sizing
  let atr_pct = null;
  if (use_atr) {
    try {
      atr_pct = await fetchATR(symbol);
      if (atr_pct) {
        if (atr_pct < minAtrPct)
          throw new Error(`${symbol} ATR ${atr_pct}% is below minimum ${minAtrPct}% — stock doesn't move enough for $${targetProfit} intraday target`);
        stop_loss_pct   = Math.min(8,  Math.max(1.5, +(stopMult  * atr_pct).toFixed(1)));
        take_profit_pct = Math.min(20, Math.max(3,   +(targetMult * atr_pct).toFixed(1)));
        if (dollars == null) {
          const auto = Math.round(targetProfit / (take_profit_pct / 100));
          dollars = Math.min(maxPos, Math.max(minPos, auto));
        }
      }
    } catch (e) {
      if (e.message.includes('ATR') && e.message.includes('minimum')) throw e;
    }
  }

  // Fallback if ATR unavailable and no override
  if (dollars == null) dollars = minPos;

  // Apply regime size multiplier (0.5× in defensive, 1.0× normal)
  if (regime.size_multiplier < 1.0)
    dollars = Math.max(minPos, Math.round(dollars * regime.size_multiplier));

  // Calculate quantity (whole shares only for simplicity)
  const qty = Math.floor(dollars / price);
  if (qty < 1) throw new Error(`$${dollars} is not enough to buy 1 share of ${symbol} at $${price}`);

  // Bracket order prices
  const stopPrice   = side === 'buy'
    ? +(price * (1 - stop_loss_pct  / 100)).toFixed(2)
    : +(price * (1 + stop_loss_pct  / 100)).toFixed(2);
  const targetPrice = side === 'buy'
    ? +(price * (1 + take_profit_pct / 100)).toFixed(2)
    : +(price * (1 - take_profit_pct / 100)).toFixed(2);

  // Place order — trailing stop lets winners run; bracket caps upside but protects both ways
  let order;
  if (trailing_stop) {
    // OTO: market entry + trailing stop leg (no fixed take-profit — lets momentum run)
    order = await alpaca('POST', '/v2/orders', {
      symbol,
      qty,
      side,
      type:          'market',
      time_in_force: 'day',
      order_class:   'oto',
      stop_loss:     { trail_percent: stop_loss_pct },
      client_order_id: `bot_${symbol}_${Date.now()}`,
    });
  } else {
    order = await alpaca('POST', '/v2/orders', {
      symbol,
      qty,
      side,
      type:          'market',
      time_in_force: 'day',
      order_class:   'bracket',
      stop_loss:     { stop_price: stopPrice },
      take_profit:   { limit_price: targetPrice },
      client_order_id: `bot_${symbol}_${Date.now()}`,
    });
  }

  const dollars_invested  = +(qty * price).toFixed(2);
  const estimated_profit  = +(dollars_invested * take_profit_pct / 100).toFixed(2);
  const estimated_risk    = +(dollars_invested * stop_loss_pct   / 100).toFixed(2);

  return {
    order_id:        order.id,
    symbol,
    side,
    qty,
    estimated_price:  price,
    dollars_invested,
    stop_loss:        stopPrice,
    take_profit:      targetPrice,
    stop_loss_pct,
    take_profit_pct,
    atr_pct,
    estimated_profit,
    estimated_risk,
    risk_reward:      +(estimated_profit / estimated_risk).toFixed(1),
    order_type:       trailing_stop ? 'trailing_stop' : 'bracket',
    regime:           regime.regime,
    regime_vix:       regime.vix,
    note,
    status: order.status,
  };
}

// ─── Time-based Exit ──────────────────────────────────────────────────────────
// Close positions that have been open > maxDays and are still unprofitable (P&L < threshold_pct)

export async function closeStalePositions({ maxDays = 3, threshold_pct = -1 } = {}) {
  const positions = await getPositions();
  const orders    = await alpaca('GET', '/v2/orders?status=closed&limit=200&direction=desc');

  const closed = [];
  for (const pos of positions) {
    // Find the fill time of the entry order for this symbol
    const entryOrder = orders.find(o =>
      o.symbol === pos.symbol && o.side === pos.side && o.status === 'filled'
    );
    if (!entryOrder?.filled_at) continue;

    const filledAt  = new Date(entryOrder.filled_at);
    const daysOpen  = (Date.now() - filledAt.getTime()) / (1000 * 60 * 60 * 24);
    const plPct     = pos.unrealized_pl_pct;

    if (daysOpen >= maxDays && plPct <= threshold_pct) {
      try {
        await closePosition(pos.symbol);
        closed.push({ symbol: pos.symbol, days_open: +daysOpen.toFixed(1), pl_pct: plPct, reason: 'stale_position' });
      } catch (e) {
        closed.push({ symbol: pos.symbol, error: e.message });
      }
    }
  }
  return { checked: positions.length, closed };
}

// ─── Close Position ───────────────────────────────────────────────────────────

export async function closePosition(symbol) {
  // Cancel any open bracket legs or pending orders for this symbol first.
  // Alpaca rejects the position close with "insufficient qty" if orders lock shares.
  try {
    const open = await alpaca('GET', `/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}&limit=20`);
    if (Array.isArray(open) && open.length > 0) {
      await Promise.allSettled(open.map(o => alpaca('DELETE', `/v2/orders/${o.id}`)));
    }
  } catch { /* best-effort — proceed to close even if cancel call fails */ }

  const r = await alpaca('DELETE', `/v2/positions/${symbol}`);
  return {
    symbol,
    qty:  parseFloat(r.qty),
    side: r.side,
    status: r.status,
  };
}

// ─── Quick Trade (manual qty, explicit stop/target prices) ───────────────────

export async function placeQuickTrade({ symbol, side = 'buy', qty, order_type = 'market', limit_price, stop_loss, take_profit }) {
  const ticker = symbol.toUpperCase().trim();
  const shares = Math.floor(qty);
  if (shares < 1) throw new Error('qty must be at least 1');

  const quote = await getLatestPrice(ticker);
  const price = side === 'buy' ? (quote.ask || quote.mid) : (quote.bid || quote.mid);
  if (!price) throw new Error(`No price available for ${ticker}`);

  const body = {
    symbol:        ticker,
    qty:           shares,
    side,
    type:          order_type === 'limit' ? 'limit' : 'market',
    time_in_force: 'day',
  };
  if (order_type === 'limit' && limit_price) body.limit_price = +limit_price;
  if (stop_loss && take_profit) {
    body.order_class = 'bracket';
    body.stop_loss   = { stop_price:  +stop_loss   };
    body.take_profit = { limit_price: +take_profit };
  } else if (stop_loss) {
    body.order_class = 'oto';
    body.stop_loss   = { stop_price: +stop_loss };
  }

  const order = await alpaca('POST', '/v2/orders', body);
  return {
    ok:              true,
    order_id:        order.id,
    symbol:          ticker,
    side,
    qty:             shares,
    order_type,
    estimated_price: +price.toFixed(2),
    estimated_cost:  +(price * shares).toFixed(2),
    stop_loss:       stop_loss   ? +stop_loss   : null,
    take_profit:     take_profit ? +take_profit : null,
    status:          order.status,
  };
}

// ─── Sync Closed Trades ───────────────────────────────────────────────────────
// Reconcile Alpaca bracket exits back into the DB.
// Alpaca fires stop/target legs automatically; this job notices and marks trades closed.

export async function syncClosedTrades() {
  const openDbTrades = await getTrades({ status: 'open', limit: 200 });
  if (!openDbTrades?.length) return { synced: 0, trades: [] };

  // Current Alpaca positions (symbols that are still genuinely open)
  const positions = await getPositions();
  const openSymbols = new Set(positions.map(p => p.symbol));

  const synced = [];

  for (const trade of openDbTrades) {
    try {
      // Fetch the parent bracket order — includes legs if nested=true
      const order = await alpaca('GET', `/v2/orders/${trade.order_id}?nested=true`);

      // A filled sell leg means the bracket exited (stop or target hit)
      const exitLeg = order.legs?.find(l => l.side === 'sell' && l.status === 'filled');
      if (!exitLeg) {
        // No exit leg filled yet — but if the symbol is no longer in positions,
        // the position was manually closed or expired. Mark it at last known price.
        if (!openSymbols.has(trade.symbol)) {
          const exitPrice = parseFloat(order.filled_avg_price || trade.entry_price);
          const pnl_usd   = +((exitPrice - trade.entry_price) * trade.qty * (trade.side === 'buy' ? 1 : -1)).toFixed(2);
          const pnl_pct   = trade.dollars_invested ? +((pnl_usd / trade.dollars_invested) * 100).toFixed(2) : 0;
          await closeTrade({ order_id: trade.order_id, exit_price: exitPrice, pnl_usd, pnl_pct });
          synced.push({ symbol: trade.symbol, exit_price: exitPrice, pnl_usd, pnl_pct, via: 'position_gone' });
        }
        continue;
      }

      const exitPrice = parseFloat(exitLeg.filled_avg_price || exitLeg.stop_price || exitLeg.limit_price);
      if (!exitPrice) continue;

      const pnl_usd = +((exitPrice - trade.entry_price) * trade.qty * (trade.side === 'buy' ? 1 : -1)).toFixed(2);
      const pnl_pct = trade.dollars_invested ? +((pnl_usd / trade.dollars_invested) * 100).toFixed(2) : 0;

      await closeTrade({ order_id: trade.order_id, exit_price: exitPrice, pnl_usd, pnl_pct });
      synced.push({ symbol: trade.symbol, exit_price: exitPrice, pnl_usd, pnl_pct, via: exitLeg.type });
    } catch (err) {
      // 404 = order no longer exists on Alpaca (aged out after 90 days, or account reset)
      if (err.message?.includes('404') || err.message?.includes('not found')) {
        if (!openSymbols.has(trade.symbol)) {
          await closeTrade({ order_id: trade.order_id, exit_price: trade.entry_price, pnl_usd: 0, pnl_pct: 0 });
          synced.push({ symbol: trade.symbol, exit_price: trade.entry_price, pnl_usd: 0, pnl_pct: 0, via: 'order_not_found' });
        }
      }
    }
  }

  return { synced: synced.length, trades: synced };
}

// ─── Market Hours ─────────────────────────────────────────────────────────────

export async function getMarketStatus() {
  const clock = await alpaca('GET', '/v2/clock');
  return {
    is_open:      clock.is_open,
    next_open:    clock.next_open,
    next_close:   clock.next_close,
    timestamp:    clock.timestamp,
  };
}
