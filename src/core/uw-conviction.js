/**
 * UW Conviction Signal — queries existing uw_flow_alerts + uw_insider_trades
 * tables (no UW REST calls) and produces a composite conviction score per symbol.
 *
 * Two exports:
 *   getUwConvictionForSymbol(symbol)  → single result
 *   getUwConvictionForSymbols(symbols) → Map<symbol, result>
 *
 * Returns no_data shape (never throws) when DB is unavailable or tables are empty.
 * 5-minute in-memory TTL cache per symbol.
 */

import { query, isDbAvailable } from './db.js';
import { alert as sysAlert } from './system-alerts.js';

const CACHE_TTL_MS = 5 * 60_000;
const _cache = new Map();

function _fromCache(sym) {
  const hit = _cache.get(sym);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  _cache.delete(sym);
  return null;
}

function _toCache(sym, value) {
  _cache.set(sym, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function _noData(symbol) {
  return {
    symbol,
    options_flow_24h: null,
    insider_7d: null,
    composite: { score: null, label: 'no_data' },
    fetched_at: new Date().toISOString(),
  };
}

export async function getUwConvictionForSymbol(symbol) {
  if (!symbol) return _noData('');
  const sym = symbol.toUpperCase();
  const cached = _fromCache(sym);
  if (cached) return cached;
  const map = await _computeConviction([sym]);
  const result = map.get(sym) ?? _noData(sym);
  _toCache(sym, result);
  return result;
}

export async function getUwConvictionForSymbols(symbols) {
  if (!symbols?.length) return new Map();
  const syms = symbols.map(s => s.toUpperCase());

  const out = new Map();
  const misses = [];
  for (const sym of syms) {
    const hit = _fromCache(sym);
    if (hit) out.set(sym, hit);
    else misses.push(sym);
  }

  if (misses.length) {
    const fetched = await _computeConviction(misses);
    for (const [sym, result] of fetched) {
      _toCache(sym, result);
      out.set(sym, result);
    }
  }

  // Guarantee all requested symbols are present
  for (const sym of syms) {
    if (!out.has(sym)) out.set(sym, _noData(sym));
  }

  return out;
}

// ─── Core computation ─────────────────────────────────────────────────────────

async function _computeConviction(symbols) {
  const result = new Map();

  if (!isDbAvailable()) {
    for (const sym of symbols) result.set(sym, _noData(sym));
    return result;
  }

  let flowRows = [];
  let insiderRows = [];

  try {
    const [flowRes, insiderRes] = await Promise.allSettled([
      query(
        `SELECT ticker, side, premium, sentiment
           FROM uw_flow_alerts
          WHERE ticker = ANY($1) AND alerted_at > NOW() - INTERVAL '24 hours'`,
        [symbols]
      ),
      query(
        `SELECT ticker, transaction_type, value
           FROM uw_insider_trades
          WHERE ticker = ANY($1) AND ingested_at > NOW() - INTERVAL '7 days'`,
        [symbols]
      ),
    ]);

    if (flowRes.status === 'fulfilled') {
      flowRows = flowRes.value.rows;
    } else {
      sysAlert({ key: 'uw-conviction/query-failed', severity: 'warn', title: 'UW conviction flow query failed', detail: { error: flowRes.reason?.message }, dedup_window_minutes: 60 }).catch(() => {});
    }

    if (insiderRes.status === 'fulfilled') {
      insiderRows = insiderRes.value.rows;
    } else {
      sysAlert({ key: 'uw-conviction/query-failed', severity: 'warn', title: 'UW conviction insider query failed', detail: { error: insiderRes.reason?.message }, dedup_window_minutes: 60 }).catch(() => {});
    }
  } catch (e) {
    sysAlert({ key: 'uw-conviction/query-failed', severity: 'warn', title: 'UW conviction query failed', detail: { error: e.message }, dedup_window_minutes: 60 }).catch(() => {});
    for (const sym of symbols) result.set(sym, _noData(sym));
    return result;
  }

  // Group rows by ticker
  const flowMap = new Map();
  for (const r of flowRows) {
    if (!flowMap.has(r.ticker)) flowMap.set(r.ticker, []);
    flowMap.get(r.ticker).push(r);
  }
  const insiderMap = new Map();
  for (const r of insiderRows) {
    if (!insiderMap.has(r.ticker)) insiderMap.set(r.ticker, []);
    insiderMap.get(r.ticker).push(r);
  }

  const fetched_at = new Date().toISOString();

  for (const sym of symbols) {
    const flowForSym   = flowMap.get(sym)   ?? [];
    const insiderForSym = insiderMap.get(sym) ?? [];

    // ── Options flow component ────────────────────────────────────────────────
    let options_flow_24h = null;
    if (flowForSym.length > 0) {
      let bullish_premium = 0;
      let bearish_premium = 0;
      for (const r of flowForSym) {
        const prem      = parseFloat(r.premium || 0);
        const side      = String(r.side || '').toLowerCase();
        const sentiment = String(r.sentiment || '').toLowerCase();
        if (side === 'call' || side === 'c' || sentiment === 'bullish') {
          bullish_premium += prem;
        } else if (side === 'put' || side === 'p' || sentiment === 'bearish') {
          bearish_premium += prem;
        }
      }
      const total_premium = bullish_premium + bearish_premium;
      if (total_premium >= 100_000) {
        const raw_conf  = total_premium > 0 ? (bullish_premium - bearish_premium) / total_premium : 0;
        const confidence = isFinite(raw_conf) ? raw_conf : 0;
        const bias = bullish_premium > 1.5 * bearish_premium ? 'bullish'
          : bearish_premium > 1.5 * bullish_premium ? 'bearish'
          : 'neutral';
        options_flow_24h = {
          bullish_premium: Math.round(bullish_premium),
          bearish_premium: Math.round(bearish_premium),
          total_premium:   Math.round(total_premium),
          bias,
          confidence:  +confidence.toFixed(4),
          alert_count: flowForSym.length,
        };
      }
    }

    // ── Insider component ─────────────────────────────────────────────────────
    let insider_7d = null;
    if (insiderForSym.length > 0) {
      let buy_value = 0;
      let sell_value = 0;
      for (const r of insiderForSym) {
        const val    = parseFloat(r.value || 0);
        const txType = String(r.transaction_type || '').toLowerCase();
        if (['buy', 'p-purchase', 'a', 'p'].includes(txType)) buy_value  += val;
        else if (['sell', 's-sale', 'd', 's'].includes(txType)) sell_value += val;
      }
      const net_value = buy_value - sell_value;
      const bias = net_value > 250_000 ? 'bullish'
        : net_value < -1_000_000 ? 'bearish'
        : 'neutral';
      insider_7d = {
        buy_value:         Math.round(buy_value),
        sell_value:        Math.round(sell_value),
        net_value:         Math.round(net_value),
        bias,
        transaction_count: insiderForSym.length,
      };
    }

    // ── Composite ─────────────────────────────────────────────────────────────
    let composite;
    if (options_flow_24h === null && insider_7d === null) {
      composite = { score: null, label: 'no_data' };
    } else {
      const flow_conf = options_flow_24h?.confidence ?? 0;
      const insider_conf = insider_7d
        ? Math.sign(insider_7d.net_value) * Math.min(Math.abs(insider_7d.net_value) / 5_000_000, 1)
        : 0;
      const score = +(0.65 * flow_conf + 0.35 * insider_conf).toFixed(4);
      const label = score >= 0.5  ? 'strong_bullish'
        : score >= 0.2  ? 'bullish'
        : score <= -0.5 ? 'strong_bearish'
        : score <= -0.2 ? 'bearish'
        : 'neutral';
      composite = { score, label };
    }

    result.set(sym, { symbol: sym, options_flow_24h, insider_7d, composite, fetched_at });
  }

  return result;
}
