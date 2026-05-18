/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║                    UNUSUAL WHALES API CLIENT                           ║
 * ║                                                                        ║
 * ║  LICENSE NOTICE — PERSONAL USE ONLY                                   ║
 * ║  The UW API Advanced plan is licensed for personal use only.          ║
 * ║  Data from this module MUST NOT be re-shared, re-sold, or exposed     ║
 * ║  via any public API endpoint. Every server route that calls this      ║
 * ║  module MUST be protected by requireAuth or admin-only middleware.     ║
 * ║                                                                        ║
 * ║  Architecture rule: ONE client. All UW calls go through this module.  ║
 * ║  Other modules NEVER call api.unusualwhales.com directly.             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import WebSocket from 'ws';

const BASE    = 'https://api.unusualwhales.com/api';
const WS_URL  = () => process.env.UW_WS_URL || 'wss://api.unusualwhales.com/socket';
const key     = () => process.env.UW_API_KEY;

export function isUWConfigured() { return !!key(); }

// ─── Stub — returned when UW_API_KEY is missing ───────────────────────────────
// Every exported async function returns null. streamOptionsFlow returns a no-op handle.

if (!key()) {
  console.warn('[unusual-whales] UW_API_KEY not set — all UW features disabled (returning null)');
}

function makeStub() {
  const stub = {
    isUWConfigured:         () => false,
    getQuota:               () => ({ remaining_minute: 0, remaining_day: 0, configured: false }),
    streamOptionsFlow:      () => ({ close: () => {}, subscribed: false }),
    getFlowAlerts:          async () => null,
    getMarketTide:          async () => null,
    getOptionsFlow:         async () => null,
    getInsiderTrades:       async () => null,
    getCongressionalTrades: async () => null,
    getTopMovers:           async () => null,
    getEconomicCalendar:    async () => null,
    getIpoCalendar:         async () => null,
    getFundamentals:        async () => null,
    getAnalystTargets:      async () => null,
    getEarningsTranscript:  async () => null,
    getCorrelations:        async () => null,
    getDrawdown:            async () => null,
    getIvRank:              async () => null,
    getStockState:          async () => null,
  };
  return stub;
}

// ─── Rate limiter — token bucket ──────────────────────────────────────────────
// Two buckets: per-minute (120) and per-day (80 000).
// Calls block (Promise) when bucket < 1; throw if estimated wait > 30s.

const _rl = {
  minTokens:   120,
  minLast:     Date.now(),
  dayTokens:   80_000,
  dayLast:     Date.now(),
  dayUsed:     0,
};

function _refillBuckets() {
  const now  = Date.now();
  const minElapsed = (now - _rl.minLast) / 60_000;  // fraction of a minute
  const dayElapsed = (now - _rl.dayLast) / 86_400_000; // fraction of a day

  _rl.minTokens = Math.min(120,     _rl.minTokens + minElapsed * 120);
  _rl.dayTokens = Math.min(80_000,  _rl.dayTokens + dayElapsed * 80_000);
  _rl.minLast   = now;
  _rl.dayLast   = now;
}

async function _acquireToken() {
  _refillBuckets();
  if (_rl.minTokens >= 1 && _rl.dayTokens >= 1) {
    _rl.minTokens -= 1;
    _rl.dayTokens -= 1;
    _rl.dayUsed   += 1;
    return;
  }
  // Estimate wait time
  const waitMin = _rl.minTokens < 1 ? (1 - _rl.minTokens) / (120 / 60_000) : 0;  // ms
  const waitDay = _rl.dayTokens < 1 ? (1 - _rl.dayTokens) / (80_000 / 86_400_000) : 0;
  const wait    = Math.max(waitMin, waitDay);
  if (wait > 30_000) {
    throw new Error(`[UW] Rate limit exhausted. Estimated wait ${Math.ceil(wait / 1000)}s > 30s threshold. Try again later.`);
  }
  await new Promise(r => setTimeout(r, Math.ceil(wait) + 50));
  _refillBuckets();
  _rl.minTokens -= 1;
  _rl.dayTokens -= 1;
  _rl.dayUsed   += 1;
}

export function getQuota() {
  _refillBuckets();
  return {
    remaining_minute: Math.floor(_rl.minTokens),
    remaining_day:    Math.floor(_rl.dayTokens),
    day_used:         _rl.dayUsed,
    configured:       !!key(),
  };
}

// ─── Cache ─────────────────────────────────────────────────────────────────────

const _cache = new Map();

const TTL = {
  flow_alerts:     60_000,           // 60 s
  market_tide:     5 * 60_000,       // 5 min
  options_flow:    60_000,
  insider:         15 * 60_000,      // 15 min
  congressional:   60 * 60_000,      // 1 hr
  movers:          5 * 60_000,
  economic_cal:    24 * 3600_000,    // 24 hr
  ipo_cal:         6 * 3600_000,     // 6 hr
  fundamentals:    24 * 3600_000,
  analyst:         60 * 60_000,      // 1 hr
  transcript:      7 * 24 * 3600_000, // 7 days
  correlations:    60 * 60_000,
  drawdown:        60 * 60_000,
  iv_rank:         60 * 60_000,
  stock_state:     60_000,
};

function fromCache(k) {
  const hit = _cache.get(k);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  _cache.delete(k);
  return null;
}

function toCache(k, value, ttlMs) {
  _cache.set(k, { value, expiresAt: Date.now() + ttlMs });
}

// ─── Fetch helper ─────────────────────────────────────────────────────────────

async function uw(path, params = {}, ttlKey = 'flow_alerts') {
  if (!key()) return null;

  const qs  = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '';
  const url = `${BASE}${path}${qs}`;
  const ttl = TTL[ttlKey] ?? 60_000;

  const cached = fromCache(url);
  if (cached !== null) return cached;

  await _acquireToken();

  let resp;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      resp = await fetch(url, {
        headers: { Authorization: `Bearer ${key()}`, Accept: 'application/json' },
        signal:  AbortSignal.timeout(10_000),
      });
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    }
  }

  if (!resp) {
    console.error(`[UW] fetch failed after retries: ${path} — ${lastErr?.message}`);
    return null;
  }

  if (!resp.ok) {
    console.error(`[UW] ${resp.status} ${resp.statusText} — ${path}`);
    return null;
  }

  const json = await resp.json().catch(() => null);
  if (json === null) return null;

  toCache(url, json, ttl);
  return json;
}

// ─── Public methods ───────────────────────────────────────────────────────────

/**
 * getFlowAlerts — recent unusual options alerts (market-wide or per ticker)
 * UW endpoint: GET /api/option-trades/flow-alerts
 * Cache: 60 s
 *
 * Returns array of alert objects. Each has:
 *   ticker, type (call|put), strike, expiry, total_premium, volume, open_interest,
 *   underlying_price, has_sweep, has_floor, alert_rule, sector, next_earnings_date,
 *   option_chain, iv_start, iv_end, created_at, sentiment (derived)
 */
export async function getFlowAlerts({ ticker, limit = 25 } = {}) {
  const params = { limit: Math.min(limit, 100) };
  if (ticker) params.ticker = ticker.toUpperCase();
  const json = await uw('/option-trades/flow-alerts', params, 'flow_alerts');
  return (json?.data || []).map(a => ({
    ...a,
    sentiment: a.type === 'call'
      ? (parseFloat(a.total_ask_side_prem || 0) >= parseFloat(a.total_bid_side_prem || 0) ? 'bullish' : 'neutral')
      : (parseFloat(a.total_bid_side_prem || 0) >  parseFloat(a.total_ask_side_prem || 0) ? 'bearish' : 'neutral'),
  }));
}

/**
 * getMarketTide — intraday net call/put premium in 5-min bars
 * UW endpoint: GET /api/market/market-tide
 * Cache: 5 min
 *
 * Returns { bars, summary: { total_net_call, total_net_put, bias, bias_pct, last_updated, bar_count } }
 */
export async function getMarketTide() {
  const json = await uw('/market/market-tide', {}, 'market_tide');
  if (!json) return null;
  const bars = (json.data || []).map(b => ({
    timestamp:        b.timestamp,
    date:             b.date,
    net_call_premium: b.net_call_premium,
    net_put_premium:  b.net_put_premium,
    net_volume:       b.net_volume,
  }));
  const totalCall = bars.reduce((s, b) => s + parseFloat(b.net_call_premium || 0), 0);
  const totalPut  = bars.reduce((s, b) => s + parseFloat(b.net_put_premium  || 0), 0);
  const absSum    = Math.abs(totalCall) + Math.abs(totalPut);
  const biasPct   = absSum > 0 ? +((Math.abs(totalCall - totalPut) / absSum) * 100).toFixed(1) : 0;
  const bias      = Math.abs(totalCall - totalPut) < absSum * 0.05 ? 'neutral'
    : totalCall > totalPut ? 'bullish' : 'bearish';
  return {
    bars,
    summary: {
      total_net_call: +totalCall.toFixed(0),
      total_net_put:  +totalPut.toFixed(0),
      bias, bias_pct: biasPct,
      last_updated: bars.at(-1)?.timestamp ?? null,
      bar_count:    bars.length,
    },
  };
}

/**
 * getOptionsFlow — flow alerts with optional premium filter and lookback
 * Alias for getFlowAlerts with enriched filtering.
 * Cache: 60 s
 *
 * @param {string} [ticker]
 * @param {number} [min_premium] — filter alerts where total_premium >= this ($)
 * @param {string} [since]       — ISO timestamp; filter alerts after this time
 */
export async function getOptionsFlow({ ticker, min_premium, since } = {}) {
  const alerts = await getFlowAlerts({ ticker, limit: 100 });
  if (!alerts) return null;
  let result = alerts;
  if (min_premium) result = result.filter(a => parseFloat(a.total_premium || 0) >= min_premium);
  if (since) {
    const cutoff = new Date(since);
    result = result.filter(a => new Date(a.created_at) >= cutoff);
  }
  return result;
}

/**
 * getInsiderTrades — recent insider buy/sell transactions
 * UW endpoint: GET /api/insider/transactions
 * Cache: 15 min
 *
 * @param {string} [ticker]      — optional ticker filter
 * @param {number} [days=30]     — lookback in calendar days
 */
export async function getInsiderTrades({ ticker, days = 30 } = {}) {
  const params = { limit: 100 };
  if (ticker) params.ticker = ticker.toUpperCase();
  const json = await uw('/insider/transactions', params, 'insider');
  if (!json) return null;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  return (json.data || [])
    .filter(t => !ticker || t.ticker?.toUpperCase() === ticker.toUpperCase())
    .filter(t => new Date(t.transaction_date) >= cutoff)
    .map(t => ({
      ticker:           t.ticker,
      owner_name:       t.owner_name,
      is_director:      t.is_director,
      is_officer:       t.is_officer,
      transaction_date: t.transaction_date,
      amount:           t.amount,
      price:            t.price,
      transactions:     t.transactions,
      sector:           t.sector,
      side:             (t.amount ?? 0) < 0 ? 'sell' : 'buy',
    }));
}

/**
 * getCongressionalTrades — recent congressional stock trades
 * UW endpoint: GET /api/congress/recent-trades
 * Cache: 1 hour
 *
 * @param {string} [ticker]      — optional ticker filter
 * @param {number} [days=90]     — lookback in calendar days
 */
export async function getCongressionalTrades({ ticker, days = 90 } = {}) {
  const params = { limit: 100 };
  if (ticker) params.ticker = ticker.toUpperCase();
  const json = await uw('/congress/recent-trades', params, 'congressional');
  if (!json) return null;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  return (json.data || [])
    .filter(t => !ticker || t.ticker?.toUpperCase() === ticker.toUpperCase())
    .filter(t => new Date(t.transaction_date) >= cutoff)
    .map(t => ({
      ticker:           t.ticker,
      member_name:      t.name || t.reporter,
      party:            t.party,
      chamber:          t.chamber,
      transaction_type: t.txn_type,
      amount_range:     t.amounts,
      transaction_date: t.transaction_date,
      filed_at:         t.filed_at || t.transaction_date,
      issuer:           t.issuer,
      is_active:        t.is_active,
    }));
}

/**
 * getTopMovers — market movers (gainers, losers, most active)
 * UW endpoint: GET /api/market/movers
 * Cache: 5 min
 *
 * @param {string} [direction='gainers'] — 'gainers' | 'losers' | 'active'
 * @param {number} [limit=20]
 */
export async function getTopMovers({ direction = 'gainers', limit = 20 } = {}) {
  const json = await uw('/market/movers', {}, 'movers');
  if (!json?.data) return null;
  const d = json.data;
  let list;
  if (direction === 'losers')  list = d.losers       || [];
  else if (direction === 'active') list = d.most_active || [];
  else                         list = d.gainers      || [];
  return list.slice(0, limit).map(m => ({
    ticker:         m.ticker,
    price:          m.price,
    change:         m.change,
    change_percent: m.change_percent,
    volume:         m.volume,
    direction,
  }));
}

/**
 * getEconomicCalendar — upcoming economic events
 * UW endpoint: GET /api/market/economic-calendar
 * Cache: 24 hours
 *
 * @param {string} [from]  — ISO date string start (optional)
 * @param {string} [to]    — ISO date string end (optional)
 */
export async function getEconomicCalendar({ from, to } = {}) {
  const json = await uw('/market/economic-calendar', {}, 'economic_cal');
  if (!json) return null;
  let events = json.data || [];
  if (from) events = events.filter(e => new Date(e.time) >= new Date(from));
  if (to)   events = events.filter(e => new Date(e.time) <= new Date(to));
  return events.map(e => ({
    event:           e.event,
    time:            e.time,
    reported_period: e.reported_period,
    forecast:        e.forecast,
    previous:        e.prev,
    type:            e.type,
  }));
}

/**
 * getIpoCalendar — upcoming IPOs
 * UW endpoint: GET /api/calendar/ipo
 * Cache: 6 hours
 *
 * @param {string} [from]  — ISO date string start
 * @param {string} [to]    — ISO date string end
 */
export async function getIpoCalendar({ from, to } = {}) {
  const json = await uw('/calendar/ipo', {}, 'ipo_cal');
  if (!json) return null;
  let ipos = json.data?.ipos || json.data || [];
  if (from) ipos = ipos.filter(i => new Date(i.ipo_date) >= new Date(from));
  if (to)   ipos = ipos.filter(i => new Date(i.ipo_date) <= new Date(to));
  return ipos.map(i => ({
    ticker:          i.ticker,
    name:            i.name,
    exchange:        i.exchange,
    ipo_date:        i.ipo_date,
    price_range_low: i.price_range_low,
    price_range_high: i.price_range_high,
    currency:        i.currency,
  }));
}

/**
 * getFundamentals — company profile + key financials
 * UW endpoint: GET /api/companies/{ticker}/profile
 * Cache: 24 hours
 *
 * @param {string} ticker
 */
export async function getFundamentals(ticker) {
  if (!ticker) return null;
  const json = await uw(`/companies/${ticker.toUpperCase()}/profile`, {}, 'fundamentals');
  return json?.data ?? null;
}

/**
 * getAnalystTargets — recent analyst rating actions for a ticker
 * UW endpoint: GET /api/screener/analysts?ticker=
 * Cache: 1 hour
 *
 * @param {string} ticker
 */
export async function getAnalystTargets(ticker) {
  if (!ticker) return null;
  const json = await uw('/screener/analysts', { ticker: ticker.toUpperCase() }, 'analyst');
  return (json?.data || []).map(a => ({
    ticker:          a.ticker,
    firm:            a.firm,
    analyst_name:    a.analyst_name,
    action:          a.action,
    recommendation:  a.recommendation,
    target:          a.target,
    timestamp:       a.timestamp,
    sector:          a.sector,
  }));
}

/**
 * getEarningsTranscript — earnings call transcript (quarterly)
 * UW endpoint: GET /api/companies/{ticker}/transcripts/{quarter}
 * Cache: 7 days
 *
 * @param {string} ticker
 * @param {string} quarter — e.g. "Q1-2026"
 */
export async function getEarningsTranscript({ ticker, quarter }) {
  if (!ticker || !quarter) return null;
  const json = await uw(`/companies/${ticker.toUpperCase()}/transcripts/${quarter}`, {}, 'transcript');
  return json?.data ?? null;
}

/**
 * getCorrelations — pairwise correlation matrix for a list of tickers
 * UW endpoint: GET /api/market/correlations?tickers=A,B,C
 * Cache: 1 hour
 *
 * @param {string[]} tickers — array of stock symbols
 */
export async function getCorrelations({ tickers = [] } = {}) {
  if (!tickers.length) return null;
  const json = await uw('/market/correlations', { tickers: tickers.map(t => t.toUpperCase()).join(',') }, 'correlations');
  return json?.data ?? null;
}

/**
 * getDrawdown — compute max drawdown from realized volatility data
 * UW endpoint: GET /api/stock/{ticker}/volatility/realized
 * Cache: 1 hour
 *
 * @param {string} ticker
 * @param {number} [window_days=30]
 */
export async function getDrawdown({ ticker, window_days = 30 } = {}) {
  if (!ticker) return null;
  const json = await uw(`/stock/${ticker.toUpperCase()}/volatility/realized`, {}, 'drawdown');
  if (!json?.data) return null;
  const rows = (Array.isArray(json.data) ? json.data : [json.data])
    .slice(-window_days);
  if (!rows.length) return null;
  // Compute max drawdown from annualized vol (approximate: worst single-period)
  const vols = rows.map(r => parseFloat(r.annualized_volatility || r.volatility || 0)).filter(Boolean);
  return {
    ticker:          ticker.toUpperCase(),
    window_days,
    avg_volatility:  vols.length ? +(vols.reduce((a, b) => a + b, 0) / vols.length).toFixed(4) : null,
    max_volatility:  vols.length ? +Math.max(...vols).toFixed(4) : null,
    latest:          rows.at(-1),
  };
}

/**
 * getIvRank — current IV rank and realized volatility
 * UW endpoint: GET /api/stock/{ticker}/iv-rank
 * Cache: 1 hour
 *
 * @param {string} ticker
 */
export async function getIvRank(ticker) {
  if (!ticker) return null;
  const json = await uw(`/stock/${ticker.toUpperCase()}/iv-rank`, {}, 'iv_rank');
  if (!json?.data) return null;
  return {
    ticker,
    iv_rank_1y: parseFloat(json.data.iv_rank_1y || 0),
    volatility: parseFloat(json.data.volatility || 0),
    close:      parseFloat(json.data.close || 0),
    date:       json.data.date,
    updated_at: json.data.updated_at,
  };
}

/**
 * getStockState — current OHLCV snapshot and market state
 * UW endpoint: GET /api/stock/{ticker}/stock-state
 * Cache: 60 s
 *
 * @param {string} ticker
 */
export async function getStockState(ticker) {
  if (!ticker) return null;
  const json = await uw(`/stock/${ticker.toUpperCase()}/stock-state`, {}, 'stock_state');
  return json?.data ?? null;
}

// ─── WebSocket streaming ──────────────────────────────────────────────────────

/**
 * streamOptionsFlow — subscribe to live options trade stream via WebSocket.
 * Auto-reconnects with exponential backoff (1s → 2s → 4s → 8s → 30s cap).
 * Heartbeat every 30 s.
 *
 * @param {object}   opts
 * @param {string[]} [opts.tickers]   — optional ticker filter; empty = all
 * @param {Function} opts.onTrade     — called with each trade object
 * @param {Function} [opts.onError]   — called with error message string
 * @returns {{ close: () => void, subscribed: boolean }}
 */
export function streamOptionsFlow({ tickers = [], onTrade, onError, onFlap } = {}) {
  if (!key()) {
    console.warn('[UW-WS] UW_API_KEY not set — streaming disabled');
    return { close: () => {}, subscribed: false };
  }

  let ws = null;
  let closed = false;
  let backoff = 1000;
  let heartbeatInterval = null;
  let failCount = 0;

  function connect() {
    if (closed) return;
    const url = `${WS_URL()}?token=${key()}`;
    console.log('[UW-WS] connecting…');
    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log('[UW-WS] connected');
      backoff = 1000;
      failCount = 0;
      // Subscribe to option_trades channel
      const sub = { action: 'subscribe', channel: 'option_trades' };
      if (tickers.length) sub.tickers = tickers.map(t => t.toUpperCase());
      ws.send(JSON.stringify(sub));
      // Heartbeat
      heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'heartbeat' }));
      }, 30_000);
    });

    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.channel === 'option_trades' && msg.data) {
          const trades = Array.isArray(msg.data) ? msg.data : [msg.data];
          trades.forEach(t => onTrade?.(t));
        }
      } catch (e) {
        console.warn('[UW-WS] bad message:', e.message);
      }
    });

    ws.on('error', err => {
      console.error('[UW-WS] error:', err.message);
      onError?.(err.message);
    });

    ws.on('close', (code, reason) => {
      clearInterval(heartbeatInterval);
      if (closed) { console.log('[UW-WS] closed (requested)'); return; }
      failCount++;
      const lastError = reason?.toString() || `code ${code}`;
      console.warn(`[UW-WS] disconnected (${code}) — reconnecting in ${backoff}ms (attempt ${failCount})`);
      if (failCount >= 5 && backoff >= 30_000) {
        onFlap?.({ attempts: failCount, last_error: lastError });
      }
      setTimeout(() => {
        backoff = Math.min(backoff * 2, 30_000);
        connect();
      }, backoff);
    });
  }

  connect();

  return {
    close() {
      closed = true;
      clearInterval(heartbeatInterval);
      ws?.terminate();
      console.log('[UW-WS] stream closed');
    },
    subscribed: true,
  };
}
