/**
 * Pre-Market Catalyst Detection System
 * Three scanners run in parallel: pre-market gappers, SEC 8-K filings, low-float setups.
 */

import { query, isDbAvailable } from './db.js';

const YF_HEADERS  = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
const SEC_HEADERS = {
  'User-Agent': 'TradingBot contact@dlpinnovations.com',
  Accept: 'application/atom+xml, text/xml',
};

const CATALYST_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
let _cache   = null;
let _cacheAt = 0;

// Fallback watchlist when DB has no low-float rows
const LOW_FLOAT_WATCHLIST = [
  'CNSP','SKK','GBTG','SIDU','IINN','BFRI','CNEY',
  'XTIA','QNRX','IFBD','RCAT','VVPR','HPNN',
];

function isValidSym(s) {
  return typeof s === 'string' && /^[A-Z]{1,6}$/.test(s);
}

async function safeFetchJson(url, opts = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000), ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ─── Scanner 1: Pre-market gappers ───────────────────────────────────────────

export async function scanPreMarketGappers() {
  const data = await safeFetchJson(
    'https://query1.finance.yahoo.com/v1/finance/screener?scrIds=most_actives&count=50',
    { headers: YF_HEADERS }
  );

  const quotes = data?.finance?.result?.[0]?.quotes ?? [];
  const TWO_DAYS_MS = 2 * 24 * 3600 * 1000;

  const results = [];
  for (const q of quotes) {
    if (!isValidSym(q.symbol)) continue;

    const preChg = q.preMarketChangePercent   ?? null;
    const regChg = q.regularMarketChangePercent ?? null;
    const volume = q.regularMarketVolume ?? 0;

    const preQualifies = preChg !== null && preChg > 10;
    const regQualifies = regChg !== null && regChg > 10;
    if (!preQualifies && !regQualifies) continue;
    if (volume <= 50_000) continue;

    // Use the larger of the two change figures as the headline gap
    const gapPct = Math.max(preChg ?? -Infinity, regChg ?? -Infinity);

    // Classify catalyst
    let catalyst = 'momentum';
    const earningsTs = q.earningsTimestampStart ?? q.earningsTimestamp ?? null;
    if (earningsTs && Date.now() - earningsTs * 1000 < TWO_DAYS_MS) {
      catalyst = 'earnings';
    } else if ((q.sharesFloat ?? q.floatShares ?? Infinity) < 10_000_000) {
      catalyst = 'low_float';
    }

    results.push({
      symbol:     q.symbol,
      name:       q.shortName ?? q.longName ?? q.symbol,
      gap_pct:    +gapPct.toFixed(2),
      price:      q.regularMarketPrice != null ? +q.regularMarketPrice.toFixed(2) : null,
      prev_close: q.regularMarketPreviousClose != null ? +q.regularMarketPreviousClose.toFixed(2) : null,
      volume,
      avg_volume: q.averageVolume ?? null,
      market_cap: q.marketCap ?? null,
      catalyst,
      type: 'pre_market_gapper',
    });
  }

  return results
    .sort((a, b) => b.gap_pct - a.gap_pct)
    .slice(0, 10);
}

// ─── Scanner 2: SEC 8-K filings ──────────────────────────────────────────────

export async function scanSECFilings() {
  const EDGAR_RSS = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=20&search_text=&output=atom';

  const r = await fetch(EDGAR_RSS, {
    headers: SEC_HEADERS,
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`SEC HTTP ${r.status}`);
  const xml = await r.text();

  const SIX_HOURS_MS = 6 * 3600 * 1000;
  const filings = [];

  for (const entry of xml.split('<entry>').slice(1)) {
    try {
      const rawTitle  = (entry.match(/<title[^>]*>(.*?)<\/title>/s)?.[1] ?? '')
        .replace(/<[^>]+>/g, '').trim();

      // "8-K - COMPANY NAME (0001234567) (YYYY-MM-DD)"
      const company = rawTitle.match(/8-K\s*-\s*(.+?)\s*\(\d/)?.[1]?.trim() ?? rawTitle;
      const cik     = rawTitle.match(/\((\d{7,10})\)/)?.[1] ?? null;

      const updatedStr = entry.match(/<updated>(.*?)<\/updated>/)?.[1]?.trim() ?? null;
      const filedAt    = updatedStr ? new Date(updatedStr) : null;

      // Skip filings older than 6 hours
      if (filedAt && Date.now() - filedAt.getTime() > SIX_HOURS_MS) continue;

      const link    = entry.match(/href="(https:\/\/www\.sec\.gov\/cgi-bin\/browse-edgar[^"]+)"/)?.[1] ?? null;
      const summary = (entry.match(/<summary[^>]*>(.*?)<\/summary>/s)?.[1] ?? '')
        .replace(/<[^>]+>/g, '');

      const itemMatches = (summary + entry).match(/Item\s+(\d+\.\d+)/g) ?? [];
      const items = [...new Set(itemMatches.map(m => m.replace(/Item\s+/i, '').trim()))];

      // Classify by dominant item number
      let filing_type = 'news';
      if (items.includes('1.01'))      filing_type = 'merger';
      else if (items.includes('2.02')) filing_type = 'earnings';
      else if (items.includes('7.01')) filing_type = 'guidance';

      if (!company) continue;

      filings.push({
        company,
        cik,
        filed_at:    updatedStr ?? null,
        items,
        filing_type,
        has_high_impact: ['merger', 'earnings', 'guidance'].includes(filing_type),
        link,
        type: '8-K',
      });
    } catch { /* skip malformed entry */ }
  }

  return filings.slice(0, 10);
}

// ─── Scanner 3: Low-float setups (DB + Yahoo Finance RVOL check) ─────────────

export async function scanLowFloatSetups() {
  // Pull small-cap symbols from DB using shares_diluted as a proxy for float
  // (fundamentals table doesn't have a dedicated float_shares column)
  let candidates = [];
  if (isDbAvailable()) {
    try {
      const { rows } = await query(
        `SELECT DISTINCT symbol FROM fundamentals
         WHERE shares_diluted < 15000000 AND shares_diluted > 0
         ORDER BY symbol LIMIT 40`
      );
      candidates = rows.map(r => r.symbol).filter(isValidSym);
    } catch { /* fall through to watchlist */ }
  }

  // Always include the watchlist; deduplicate
  const allCandidates = [...new Set([...candidates, ...LOW_FLOAT_WATCHLIST])].slice(0, 30);

  const checks = await Promise.allSettled(
    allCandidates.map(async sym => {
      const data = await safeFetchJson(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=defaultKeyStatistics,price`,
        { headers: YF_HEADERS }
      );
      const kStats = data?.quoteSummary?.result?.[0]?.defaultKeyStatistics ?? {};
      const price  = data?.quoteSummary?.result?.[0]?.price ?? {};

      const floatShares = kStats.floatShares?.raw ?? null;
      const avgVolume   = kStats.averageVolume?.raw
        ?? price.averageDailyVolume3Month?.raw
        ?? null;
      const currVolume  = price.regularMarketVolume?.raw ?? null;

      if (!floatShares || floatShares > 15_000_000) return null;
      if (!currVolume || !avgVolume) return null;

      const rvol = +(currVolume / avgVolume).toFixed(2);
      if (rvol < 2.0) return null;

      const regChg = price.regularMarketChangePercent?.raw ?? null;
      const preChg = price.preMarketChangePercent?.raw ?? null;
      const gapPct = +((preChg ?? regChg ?? 0) * 100).toFixed(2);

      return {
        symbol:   sym,
        name:     price.shortName ?? sym,
        float_m:  +(floatShares / 1e6).toFixed(2),
        rvol,
        gap_pct:  gapPct,
        price:    price.regularMarketPrice?.raw != null ? +price.regularMarketPrice.raw.toFixed(2) : null,
        type:     'low_float_setup',
      };
    })
  );

  return checks
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value)
    .sort((a, b) => b.rvol - a.rvol);
}

// ─── Scanner 4: FDA catalyst calendar (Benzinga) ─────────────────────────────

export async function scanFDACalendar() {
  const key = process.env.BENZINGA_API_KEY || process.env.BENZINGA_API;
  if (!key) return [];

  const today   = new Date();
  const ago7d   = new Date(today); ago7d.setDate(today.getDate() - 7);
  const in30d   = new Date(today); in30d.setDate(today.getDate() + 30);
  const fmt     = d => d.toISOString().split('T')[0];
  const todayMs = new Date(today).setHours(0, 0, 0, 0);

  // Cast a wide net (past 7 days → next 30 days) — Benzinga pre-announces
  // FDA events close to their date, so a future-only window often returns empty.
  const data = await safeFetchJson(
    `https://api.benzinga.com/api/v2.1/calendar/fda?token=${key}&parameters[date_from]=${fmt(ago7d)}&parameters[date_to]=${fmt(in30d)}&pageSize=30`,
    { headers: { Accept: 'application/json' } }
  );

  // Response shape: { fda: [...] }  (not a plain array)
  const events = data?.fda ?? (Array.isArray(data) ? data : []);

  return events
    .filter(e => e.date)
    .map(e => {
      const evType      = (e.event_type || '').toLowerCase();
      const strength    = /approval|pdufa/.test(evType) ? 'high'
                        : /trial|phase/.test(evType)    ? 'medium'
                        :                                  'low';
      const days_until  = Math.round((new Date(e.date) - todayMs) / 86_400_000);
      // Extract primary ticker; Benzinga stores it inside securities array
      const firstCo     = (e.companies || [])[0];
      const symbol      = firstCo?.securities?.[0]?.symbol || firstCo?.ticker || null;

      return {
        symbol,
        drug:              e.drug?.name  || null,
        indication:        e.drug?.indication_symptom?.[0]?.trim() || null,
        event_type:        e.event_type  || null,
        status:            e.status      || null,
        date:              e.date,
        target_date:       e.target_date || null,
        catalyst_strength: strength,
        days_until,
        companies:         (e.companies || []).map(c => ({
          ticker: c.securities?.[0]?.symbol || null,
          name:   c.name,
        })),
        outcome_brief:     e.outcome_brief || e.commentary || null,
        source_link:       e.source_link   || null,
      };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date))  // nearest first
    .slice(0, 5);
}

// ─── Top-picks builder ────────────────────────────────────────────────────────

function buildTopPicks(gappers, lowFloat) {
  const seen  = new Set();
  const picks = [];

  for (const g of gappers) {
    if (seen.has(g.symbol)) continue;
    seen.add(g.symbol);
    picks.push({ ...g, signal_score: Math.min(100, Math.abs(g.gap_pct) * 2) });
  }

  for (const lf of lowFloat) {
    if (seen.has(lf.symbol)) continue;
    seen.add(lf.symbol);
    picks.push({ ...lf, signal_score: Math.min(100, lf.rvol * 25) });
  }

  return picks
    .sort((a, b) => b.signal_score - a.signal_score)
    .slice(0, 10);
}

// ─── Combined runner with 10-minute cache ─────────────────────────────────────

export async function runCatalystScan() {
  if (_cache && Date.now() - _cacheAt < CATALYST_CACHE_TTL) return _cache;

  const [gappers, sec_filings, low_float, fda_events] = await Promise.all([
    scanPreMarketGappers().catch(err => {
      console.warn('[catalyst] gapper scan failed:', err.message);
      return [];
    }),
    scanSECFilings().catch(err => {
      console.warn('[catalyst] SEC scan failed:', err.message);
      return [];
    }),
    scanLowFloatSetups().catch(err => {
      console.warn('[catalyst] low-float scan failed:', err.message);
      return [];
    }),
    scanFDACalendar().catch(err => {
      console.warn('[catalyst] FDA scan failed:', err.message);
      return [];
    }),
  ]);

  const top_picks = buildTopPicks(gappers, low_float);

  const result = {
    gappers,
    sec_filings,
    low_float,
    fda_events,
    top_picks,
    scanned_at: new Date().toISOString(),
  };

  _cache   = result;
  _cacheAt = Date.now();

  console.log(
    `[catalyst] scan complete — ${gappers.length} gappers, ` +
    `${sec_filings.length} SEC filings, ${low_float.length} low-float, ` +
    `${fda_events.length} FDA events, ${top_picks.length} top picks`
  );

  return result;
}
