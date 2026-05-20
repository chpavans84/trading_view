import { query, isDbAvailable } from './db.js';
import YF from 'yahoo-finance2';

const yfClient = new YF({ suppressNotices: ['yahooSurvey'] });

// Cache keyed by `helper_name:arg` → { value, expiresAt }
const _cache = new Map();
const _now = () => Date.now();
function _fromCache(k) {
  const hit = _cache.get(k);
  if (hit && _now() < hit.expiresAt) return hit.value;
  _cache.delete(k);
  return null;
}
function _toCache(k, value, ttlMs) {
  _cache.set(k, { value, expiresAt: _now() + ttlMs });
}

// ─── 1. Macro event blackout ───────────────────────────────────────────────
//
// Returns blackout=true if any HIGH-importance event is within ±N minutes of
// `at` (default now). Also returns the next high-importance event upcoming in
// the next 24h.
//
const HIGH_IMPORTANCE = new Set(['high', 'High', 'HIGH', '3', 3]);

export async function getMacroBlackoutStatus({ at, beforeMin = 60, afterMin = 60 } = {}) {
  const k = `macro_blackout:${beforeMin}:${afterMin}`;
  const cached = _fromCache(k);
  if (cached) return cached;

  const result = {
    in_blackout: false,
    blackout_event: null,
    next_event: null,
    minutes_until_next: null,
    fetched_at: new Date().toISOString(),
  };

  if (!isDbAvailable()) { _toCache(k, result, 60_000); return result; }

  try {
    const refTs = at instanceof Date ? at : (at ? new Date(at) : new Date());
    const { rows } = await query(
      `SELECT event_date, event_name, country, importance, actual, forecast
       FROM uw_economic_calendar
       WHERE event_date BETWEEN $1::timestamptz - INTERVAL '6 hours'
                            AND $1::timestamptz + INTERVAL '24 hours'
       ORDER BY event_date ASC`,
      [refTs.toISOString()]
    );
    for (const ev of rows) {
      if (!HIGH_IMPORTANCE.has(ev.importance)) continue;
      const eventTs = new Date(ev.event_date).getTime();
      const diffMin = (eventTs - refTs.getTime()) / 60000;
      if (diffMin >= -afterMin && diffMin <= beforeMin) {
        result.in_blackout = true;
        result.blackout_event = {
          name: ev.event_name,
          country: ev.country,
          minutes_offset: Math.round(diffMin),
        };
      }
      if (diffMin > 0 && result.next_event == null) {
        result.next_event = { name: ev.event_name, country: ev.country, date: ev.event_date };
        result.minutes_until_next = Math.round(diffMin);
      }
    }
  } catch (e) {
    console.error('[bot-indicators/macro]', e.message);
  }

  _toCache(k, result, 60_000); // 1 min
  return result;
}

// ─── 2. Liquidity profile ──────────────────────────────────────────────────
//
// 30-day average dollar volume from backtest_prices. Bot requires ≥$5M ADV.
//
export async function getLiquidityProfile(symbol) {
  if (!symbol) return null;
  const sym = symbol.toUpperCase();
  const k = `liquidity:${sym}`;
  const cached = _fromCache(k);
  if (cached) return cached;

  if (!isDbAvailable()) return null;

  try {
    const { rows } = await query(
      `SELECT close, volume, price_date
       FROM backtest_prices
       WHERE symbol = $1
       ORDER BY price_date DESC
       LIMIT 30`,
      [sym]
    );
    if (!rows.length) {
      const result = { symbol: sym, available: false, reason: 'no_backtest_data' };
      _toCache(k, result, 60 * 60_000);
      return result;
    }
    const dollarVols = rows.map(r => (parseFloat(r.close) || 0) * (Number(r.volume) || 0));
    const advDollarVol30d = dollarVols.reduce((s, v) => s + v, 0) / dollarVols.length;
    const lastPrice = parseFloat(rows[0].close) || 0;
    const result = {
      symbol: sym,
      available: true,
      days_with_data: rows.length,
      last_price: +lastPrice.toFixed(2),
      last_date: rows[0].price_date,
      adv_dollar_vol_30d: Math.round(advDollarVol30d),
      is_liquid_5m: advDollarVol30d >= 5_000_000,
      is_liquid_20m: advDollarVol30d >= 20_000_000,
      fetched_at: new Date().toISOString(),
    };
    _toCache(k, result, 60 * 60_000); // 1 hr
    return result;
  } catch (e) {
    console.error('[bot-indicators/liquidity]', e.message);
    return null;
  }
}

// ─── 3. Earnings proximity ─────────────────────────────────────────────────
//
// Days until next earnings report via Yahoo Finance calendarEvents.
// Bot skips stocks within 3 days of earnings (configurable).
//
export async function getEarningsProximity(symbol) {
  if (!symbol) return null;
  const sym = symbol.toUpperCase();
  const k = `earnings_prox:${sym}`;
  const cached = _fromCache(k);
  if (cached) return cached;

  const result = {
    symbol: sym,
    has_upcoming: false,
    next_earnings_date: null,
    days_until: null,
    call_time: null,
    fetched_at: new Date().toISOString(),
  };

  try {
    const q = await yfClient.quoteSummary(sym, { modules: ['calendarEvents'] });
    const er = q?.calendarEvents?.earnings;
    const dates = Array.isArray(er?.earningsDate) ? er.earningsDate : [];
    const dateObj = dates[0] instanceof Date ? dates[0] : (dates[0] ? new Date(dates[0]) : null);
    if (dateObj && !isNaN(dateObj.getTime())) {
      const daysUntil = Math.ceil((dateObj.getTime() - Date.now()) / 86_400_000);
      if (daysUntil >= 0 && daysUntil <= 90) {
        result.has_upcoming = true;
        result.next_earnings_date = dateObj.toISOString().slice(0, 10);
        result.days_until = daysUntil;
      }
    }
  } catch (e) {
    console.warn('[bot-indicators/earnings]', sym, e.message);
  }

  _toCache(k, result, 30 * 60_000); // 30 min
  return result;
}

// ─── 4. Pre-market gap ─────────────────────────────────────────────────────
//
// Returns pre-market gap % vs previous close via Yahoo Finance quote.
// Outside pre-market hours preMarketPrice is null → available: false.
//
export async function getPreMarketGap(symbol) {
  if (!symbol) return null;
  const sym = symbol.toUpperCase();
  const k = `premarket_gap:${sym}`;
  const cached = _fromCache(k);
  if (cached) return cached;

  const result = {
    symbol: sym,
    gap_pct: null,
    gap_dollars: null,
    pre_market_price: null,
    previous_close: null,
    available: false,
    fetched_at: new Date().toISOString(),
  };

  try {
    const q = await yfClient.quote(sym);
    const pre  = q?.preMarketPrice;
    const prev = q?.regularMarketPreviousClose ?? q?.previousClose;
    if (pre != null && prev != null && prev > 0) {
      const gap = ((pre - prev) / prev) * 100;
      result.gap_pct           = +gap.toFixed(2);
      result.gap_dollars       = +(pre - prev).toFixed(2);
      result.pre_market_price  = pre;
      result.previous_close    = prev;
      result.available         = true;
    }
  } catch (e) {
    console.warn('[bot-indicators/premarket]', sym, e.message);
  }

  _toCache(k, result, 5 * 60_000); // 5 min
  return result;
}

// ─── 5. Short interest ─────────────────────────────────────────────────────
//
// Short % of float + days-to-cover from Yahoo defaultKeyStatistics.
// Bot flags squeeze candidates at SI > 20%.
//
export async function getShortInterest(symbol) {
  if (!symbol) return null;
  const sym = symbol.toUpperCase();
  const k = `short_int:${sym}`;
  const cached = _fromCache(k);
  if (cached) return cached;

  const result = {
    symbol: sym,
    short_pct_float: null,
    short_ratio_days: null,
    shares_short: null,
    float_shares: null,
    available: false,
    source: 'yahoo',
    fetched_at: new Date().toISOString(),
  };

  try {
    const q = await yfClient.quoteSummary(sym, { modules: ['defaultKeyStatistics'] });
    const ks = q?.defaultKeyStatistics;
    if (ks) {
      result.short_pct_float  = ks.shortPercentOfFloat ?? null;
      result.short_ratio_days = ks.shortRatio ?? null;
      result.shares_short     = ks.sharesShort ?? null;
      result.float_shares     = ks.floatShares ?? null;
      result.available        = result.short_pct_float != null;
    }
  } catch (e) {
    console.warn('[bot-indicators/short-int]', sym, e.message);
  }

  _toCache(k, result, 6 * 60 * 60_000); // 6 hr
  return result;
}

// ─── Aggregate: all 5 in one shot ─────────────────────────────────────────
export async function getAllBotIndicators(symbol) {
  if (!symbol) return null;
  const [macro, liq, earn, pm, si] = await Promise.allSettled([
    getMacroBlackoutStatus(),
    getLiquidityProfile(symbol),
    getEarningsProximity(symbol),
    getPreMarketGap(symbol),
    getShortInterest(symbol),
  ]);
  return {
    symbol: symbol.toUpperCase(),
    macro:          macro.status === 'fulfilled' ? macro.value : null,
    liquidity:      liq.status   === 'fulfilled' ? liq.value   : null,
    earnings:       earn.status  === 'fulfilled' ? earn.value  : null,
    premarket:      pm.status    === 'fulfilled' ? pm.value    : null,
    short_interest: si.status    === 'fulfilled' ? si.value    : null,
    fetched_at:     new Date().toISOString(),
  };
}
