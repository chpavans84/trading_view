/**
 * Market sentiment data.
 * Quotes: Moomoo OpenD (real-time, primary) → Yahoo Finance (fallback)
 * VIX/futures/sectors: Yahoo Finance (not available via Moomoo)
 */

import { getQuotes as moomooGetQuotes, getKLines } from './moomoo-tcp.js';

const YF_BASE = 'https://query2.finance.yahoo.com';

export const SECTOR_MAP = {
  // Technology (XLK)
  AAPL: 'XLK', MSFT: 'XLK', NVDA: 'XLK', AMD: 'XLK',
  MU: 'XLK', AVGO: 'XLK', QCOM: 'XLK', INTC: 'XLK',
  TSM: 'XLK', SMCI: 'XLK', MRVL: 'XLK', ARM: 'XLK',
  AMAT: 'XLK', KLAC: 'XLK', LRCX: 'XLK', ASML: 'XLK',
  PLTR: 'XLK', SOXL: 'XLK', SOXS: 'XLK', SMH: 'XLK',
  QBTS: 'XLK', IONQ: 'XLK', RGTI: 'XLK',       // quantum computing
  // Communication Services (XLC)
  GOOGL: 'XLC', GOOG: 'XLC', META: 'XLC', NFLX: 'XLC',
  DIS: 'XLC', CMCSA: 'XLC', T: 'XLC', VZ: 'XLC',
  // Consumer Discretionary (XLY)
  AMZN: 'XLY', TSLA: 'XLY', HD: 'XLY', MCD: 'XLY',
  NKE: 'XLY', SBUX: 'XLY', TGT: 'XLY', BKNG: 'XLY',
  QS: 'XLY',                                      // QuantumScape — EV batteries
  // Consumer Staples (XLP)
  PG: 'XLP', KO: 'XLP', PEP: 'XLP', WMT: 'XLP', COST: 'XLP',
  // Financials (XLF)
  JPM: 'XLF', GS: 'XLF', MS: 'XLF', BAC: 'XLF',
  WFC: 'XLF', C: 'XLF', AXP: 'XLF', V: 'XLF', MA: 'XLF',
  // Industrials / Defense (XLI)
  RTX: 'XLI', LMT: 'XLI', NOC: 'XLI', GD: 'XLI',
  BA: 'XLI', CAT: 'XLI', DE: 'XLI', HON: 'XLI', UPS: 'XLI',
  AVAV: 'XLI', AXON: 'XLI',                       // defense drones / tech
  USAR: 'XLI',                                     // US defense ETF
  // Energy (XLE)
  XOM: 'XLE', CVX: 'XLE', COP: 'XLE', OXY: 'XLE',
  SLB: 'XLE', DVN: 'XLE', HAL: 'XLE',
  LEU: 'XLE',                                      // uranium enrichment
  CCJ: 'XLE', UEC: 'XLE', NXE: 'XLE',             // uranium miners
  // Clean Energy / Utilities (XLU)
  NEE: 'XLU', DUK: 'XLU', SO: 'XLU', AEP: 'XLU',
  BE: 'XLU',                                       // Bloom Energy — fuel cells
  FSLR: 'XLU', ENPH: 'XLU', SEDG: 'XLU',         // solar
  // Materials (XLB)
  LIN: 'XLB', APD: 'XLB', FCX: 'XLB', NEM: 'XLB', NUE: 'XLB',
  SGML: 'XLB',                                     // Sigma Lithium — lithium mining
  ALB: 'XLB', SQM: 'XLB', LAC: 'XLB',            // lithium producers
  // Healthcare (XLV)
  JNJ: 'XLV', PFE: 'XLV', MRK: 'XLV', ABBV: 'XLV',
  UNH: 'XLV', LLY: 'XLV', AMGN: 'XLV', BMY: 'XLV',
  // Real Estate (XLRE)
  AMT: 'XLRE', PLD: 'XLRE', EQIX: 'XLRE',
};

export const SECTOR_NAMES = {
  XLK:  'Technology',
  XLC:  'Comm. Services',
  XLY:  'Consumer Disc.',
  XLP:  'Consumer Staples',
  XLF:  'Financials',
  XLI:  'Industrials/Defense',
  XLE:  'Energy',
  XLU:  'Clean Energy/Utilities',
  XLB:  'Materials',
  XLV:  'Healthcare',
  XLRE: 'Real Estate',
  '?':  'Other',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'application/json',
};

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Simple cache (avoids hammering Yahoo Finance on every message) ───────────

const _cache = new Map();

function cacheGet(key, ttlMs) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) { _cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  _cache.set(key, { data, ts: Date.now() });
}

// ─── Fetch with retry on 429 ──────────────────────────────────────────────────

async function fetchQuote(symbol) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await delay(2000 * attempt);
    try {
      const r = await fetch(
        `${YF_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
        { headers: HEADERS }
      );
      if (r.status === 429) continue;
      if (!r.ok) return null;
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      if (!result) return null;

      const meta   = result.meta;
      const closes = result.indicators?.quote?.[0]?.close?.filter(v => v != null) || [];
      const price  = meta.regularMarketPrice ?? closes[closes.length - 1];
      const prev   = closes.length >= 2 ? closes[closes.length - 2] : (meta.chartPreviousClose ?? meta.previousClose);
      const chgPct = price && prev ? +((price - prev) / prev * 100).toFixed(2) : null;

      return { symbol, price, prev, chg_pct: chgPct, name: meta.shortName || meta.symbol || symbol };
    } catch {
      return null;
    }
  }
  return null;
}

// Fully sequential fetch with delay between each call — avoids all rate limiting
async function fetchAll(symbols, gapMs = 800) {
  const results = new Map();
  for (const sym of symbols) {
    const q = await fetchQuote(sym);
    if (q) results.set(sym, q);
    await delay(gapMs);
  }
  return results;
}

// ─── VIX → Sentiment ─────────────────────────────────────────────────────────

function vixToSentiment(vix) {
  if (vix == null) return { label: 'Unknown', score: null, emoji: '❓' };
  if (vix < 13)   return { label: 'Extreme Greed', score: 90, emoji: '🤑' };
  if (vix < 17)   return { label: 'Greed',         score: 70, emoji: '😊' };
  if (vix < 20)   return { label: 'Neutral',        score: 50, emoji: '😐' };
  if (vix < 25)   return { label: 'Fear',           score: 35, emoji: '😨' };
  if (vix < 35)   return { label: 'High Fear',      score: 20, emoji: '😰' };
  return            { label: 'Extreme Fear',         score: 5,  emoji: '🚨' };
}

// ─── Market Sentiment ─────────────────────────────────────────────────────────

export async function getMarketSentiment() {
  const cached = cacheGet('sentiment', 5 * 60 * 1000);
  if (cached) return { ...cached, cached: true };

  const symbols = ['^VIX', '^GSPC', '^IXIC', '^DJI', 'ES=F', 'NQ=F'];
  const quotes  = await fetchAll(symbols, 800);

  const vix        = quotes.get('^VIX');
  const sp500      = quotes.get('^GSPC');
  const nasdaq     = quotes.get('^IXIC');
  const dow        = quotes.get('^DJI');
  const es         = quotes.get('ES=F');
  const nq         = quotes.get('NQ=F');

  const vixVal     = vix?.price ?? null;
  const sentiment  = vixToSentiment(vixVal);

  // Market status hint
  const now   = new Date();
  const utcH  = now.getUTCHours();
  const utcM  = now.getUTCMinutes();
  const utcT  = utcH * 60 + utcM;
  const isWeekend   = now.getUTCDay() === 0 || now.getUTCDay() === 6;
  const marketOpen  = !isWeekend && utcT >= 13 * 60 + 30 && utcT < 20 * 60; // 9:30–16:00 ET
  const preMarket   = !isWeekend && utcT >= 8 * 60 && utcT < 13 * 60 + 30;

  const marketStatus = isWeekend ? 'Market closed (weekend)' :
    marketOpen ? '🟢 Market OPEN' :
    preMarket  ? '🟡 Pre-market' :
                 '🔴 After hours';

  const dayTradingConditions = vixVal == null ? 'Data unavailable — market may be closed' :
    vixVal < 15 ? 'Low volatility — tight ranges, choppy. Avoid overtrading.' :
    vixVal < 20 ? 'Normal volatility — decent intraday moves. Good for momentum plays.' :
    vixVal < 30 ? 'Elevated volatility — bigger swings, wider stops. High reward/risk.' :
                  'Extreme volatility — large gaps and fast reversals. Reduce position size.';

  const result = {
    success: true,
    market_status: marketStatus,
    timestamp: new Date().toISOString(),
    fear_greed: {
      score: sentiment.score,
      label: sentiment.label,
      emoji: sentiment.emoji,
      note: vixVal ? `VIX at ${vixVal} — ${sentiment.label}` : 'VIX unavailable',
    },
    vix: {
      value: vixVal,
      change_pct: vix?.chg_pct ?? null,
    },
    indices: {
      sp500:  { price: sp500?.price,  chg_pct: sp500?.chg_pct  ?? 'n/a' },
      nasdaq: { price: nasdaq?.price, chg_pct: nasdaq?.chg_pct ?? 'n/a' },
      dow:    { price: dow?.price,    chg_pct: dow?.chg_pct    ?? 'n/a' },
    },
    futures: {
      es: { price: es?.price, chg_pct: es?.chg_pct ?? 'n/a', label: 'S&P 500 Futures' },
      nq: { price: nq?.price, chg_pct: nq?.chg_pct ?? 'n/a', label: 'Nasdaq Futures'  },
    },
    day_trading_conditions: dayTradingConditions,
  };
  cacheSet('sentiment', result);
  return result;
}

// ─── Sector Performance ───────────────────────────────────────────────────────

const SECTORS = {
  XLK:  'Technology',
  XLF:  'Financials',
  XLE:  'Energy',
  XLV:  'Healthcare',
  XLI:  'Industrials',
  XLB:  'Materials',
  XLP:  'Consumer Staples',
  XLY:  'Consumer Discretionary',
  XLC:  'Communication',
  XLRE: 'Real Estate',
  XLU:  'Utilities',
  GLD:  'Gold',
  TLT:  'Bonds (20Y)',
  UUP:  'US Dollar',
};

export async function getSectorPerformance() {
  const cached = cacheGet('sectors', 10 * 60 * 1000);
  if (cached) return { ...cached, cached: true };

  const symbols = Object.keys(SECTORS);
  const quotes  = await fetchAll(symbols, 800);

  const results = symbols
    .map(sym => {
      const q = quotes.get(sym);
      if (!q) return null;
      return {
        symbol: sym,
        sector: SECTORS[sym],
        price:   q.price,
        chg_pct: q.chg_pct,
        direction: q.chg_pct == null ? '➖' : q.chg_pct > 0 ? '📈' : q.chg_pct < 0 ? '📉' : '➖',
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.chg_pct ?? -99) - (a.chg_pct ?? -99));

  const leaders  = results.filter(r => r.chg_pct > 0).slice(0, 3);
  const laggards = results.filter(r => r.chg_pct < 0).slice(-3).reverse();

  const get = sym => results.find(r => r.symbol === sym)?.chg_pct ?? 0;
  const rotationSignal =
    get('GLD') > 1 && get('TLT') > 0.5 ? 'Risk-OFF — safety rotation (gold + bonds leading)' :
    get('XLK') > 1 && get('XLE') < 0   ? 'Risk-ON  — growth/tech leading, energy lagging' :
    get('XLE') > 1 && get('XLK') < 0   ? 'Commodity rotation — energy/materials in favor' :
    get('XLU') > 1 && get('XLK') < 0   ? 'Defensive rotation — utilities/staples leading (risk-off)' :
    results.length === 0                ? 'No sector data available (market may be closed)' :
    'Mixed — no clear rotation signal';

  const result = {
    success: true,
    timestamp: new Date().toISOString(),
    data_points: results.length,
    rotation_signal: rotationSignal,
    leaders,
    laggards,
    all_sectors: results,
  };
  cacheSet('sectors', result);
  return result;
}

// ─── Trending Stocks ──────────────────────────────────────────────────────────

export async function getTrendingStocks({ limit = 15 } = {}) {
  const r = await fetch(
    `${YF_BASE}/v1/finance/trending/US?count=${limit}`,
    { headers: HEADERS }
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}: trending stocks`);
  const data = await r.json();

  const tickers = (data?.finance?.result?.[0]?.quotes || [])
    .map(q => q.symbol)
    .filter(s => !s.includes('=') && !s.includes('^'))
    .slice(0, limit);

  const quotes = await fetchAll(tickers, 700);

  const trending = tickers
    .map(sym => {
      const q = quotes.get(sym);
      return q ? { symbol: sym, price: q.price, chg_pct: q.chg_pct } : { symbol: sym, price: null, chg_pct: null };
    })
    .sort((a, b) => Math.abs(b.chg_pct ?? 0) - Math.abs(a.chg_pct ?? 0));

  return {
    success: true,
    timestamp: new Date().toISOString(),
    count: trending.length,
    trending,
    note: 'Most searched stocks on Yahoo Finance right now',
  };
}

// ─── Relative Strength vs Sector ETF ─────────────────────────────────────────

async function fetch5dReturn(symbol) {
  // Try Moomoo daily candles first (real-time, no rate limits)
  try {
    const kl = await getKLines({ symbol, klType: 'day', count: 10 });
    if (kl.success && kl.candles.length >= 6) {
      const closes = kl.candles.map(c => c.close).filter(v => v != null);
      if (closes.length >= 6) {
        return +((closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100).toFixed(2);
      }
    }
  } catch { /* fall through */ }

  // Yahoo Finance fallback
  try {
    const r = await fetch(
      `${YF_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=10d`,
      { headers: HEADERS }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const closes = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null);
    if (!closes || closes.length < 6) return null;
    return +((closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100).toFixed(2);
  } catch { return null; }
}

export async function getRelativeStrength({ symbol, sector_etf } = {}) {
  const ticker = symbol.toUpperCase();
  const etf    = (sector_etf || SECTOR_MAP[ticker] || 'SPY').toUpperCase();

  const [symbol_5d_pct, etf_5d_pct] = await Promise.all([
    fetch5dReturn(ticker),
    fetch5dReturn(etf),
  ]);

  if (symbol_5d_pct == null || etf_5d_pct == null) {
    return { success: false, symbol: ticker, sector_etf: etf, error: 'Failed to fetch price data' };
  }

  const rs_score = +(symbol_5d_pct - etf_5d_pct).toFixed(2);
  const signal   = rs_score > 2 ? 'strong' : rs_score < -2 ? 'weak' : 'neutral';

  return {
    success: true,
    symbol: ticker,
    sector_etf: etf,
    symbol_5d_pct,
    etf_5d_pct,
    rs_score,
    signal,
  };
}

// ─── Market Movers (dynamic universe ranked by today's % move) ───────────────

// Fallback list used only if all Yahoo Finance dynamic sources fail
const FALLBACK_UNIVERSE = [
  // Mega-cap tech
  'AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AVGO',
  // Semiconductors
  'AMD','INTC','QCOM','MU','TSM','MRVL','KLAC','LRCX','AMAT','SMCI','ARM','ON',
  // Software / Cloud
  'CRM','NOW','SNOW','PLTR','ORCL','ADBE','INTU','DDOG','MDB','PANW','CRWD','ZS',
  // Financials
  'JPM','GS','MS','BAC','V','MA','C','BX','KKR',
  // Healthcare / Biotech
  'UNH','LLY','ABBV','MRK','PFE','MRNA','BNTX','AMGN','GILD','SRPT','IONS','NVAX',
  // Consumer
  'COST','WMT','HD','TGT','NKE','SBUX','MCD','NFLX',
  // Energy
  'XOM','CVX','COP','SLB','OXY',
  // Industrials / Defence
  'RTX','LMT','NOC','GD','CAT','DE','BA',
  // Clean Energy (high catalyst potential)
  'BE','FSLR','ENPH','NEE','PLUG','RUN','SEDG','ARRY',
  // EV / Growth (high ATR)
  'RIVN','NIO','LCID','XPEV','LI',
  // China ADRs (volatile, catalyst-driven)
  'BABA','JD','PDD','BIDU',
  // Other high-ATR names
  'COIN','HOOD','RBLX','UBER','LYFT','DASH','SQ','PYPL','AFRM',
  // REITs / Macro sensitive
  'AMT','PLD','EQIX',
  // Recent high-growth / IPO names
  'SOFI','UPST','RKLB','ASTS',
];

// Core names always included even on quiet days when Yahoo returns few results
const CORE_ALWAYS_SCAN = [
  'AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA',
  'AMD','JPM','V','MA','XOM','UNH','NFLX','AVGO',
  'PLTR','COIN','CRWD','PANW','SOFI',
];

// 15-minute cache for the dynamic universe — shared across all scans in the window
let _universeCache = { symbols: [], ts: 0, source: 'fallback' };
const UNIVERSE_TTL = 15 * 60 * 1000;

export function getUniverseInfo() {
  return {
    size:   _universeCache.symbols.length,
    source: _universeCache.source,
    age_ms: Date.now() - _universeCache.ts,
  };
}

async function fetchDynamicUniverse() {
  if (_universeCache.symbols.length > 0 && Date.now() - _universeCache.ts < UNIVERSE_TTL) {
    return _universeCache.symbols;
  }

  // Valid US stock symbol: 1–5 uppercase letters only
  const isValidSym = s => typeof s === 'string' && /^[A-Z]{1,5}$/.test(s);

  // Screener results include price/volume — filter both here
  const extractScreener = data => {
    try {
      return (data?.finance?.result?.[0]?.quotes ?? [])
        .filter(q =>
          isValidSym(q.symbol) &&
          (q.regularMarketPrice ?? 0) >= 5 &&
          (q.regularMarketVolume ?? 0) >= 500_000
        )
        .map(q => q.symbol);
    } catch { return []; }
  };

  // Trending endpoint returns symbols only, no price/volume
  const extractTrending = data => {
    try {
      return (data?.finance?.result?.[0]?.quotes ?? [])
        .map(q => q.symbol)
        .filter(isValidSym);
    } catch { return []; }
  };

  try {
    const [trendRes, gainRes, activeRes, loserRes] = await Promise.allSettled([
      fetch(`${YF_BASE}/v1/finance/trending/US?count=50`, { headers: HEADERS }).then(r => r.ok ? r.json() : Promise.reject()),
      fetch(`${YF_BASE}/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=50`, { headers: HEADERS }).then(r => r.ok ? r.json() : Promise.reject()),
      fetch(`${YF_BASE}/v1/finance/screener/predefined/saved?scrIds=most_actives&count=50`, { headers: HEADERS }).then(r => r.ok ? r.json() : Promise.reject()),
      fetch(`${YF_BASE}/v1/finance/screener/predefined/saved?scrIds=day_losers&count=25`, { headers: HEADERS }).then(r => r.ok ? r.json() : Promise.reject()),
    ]);

    const anyOk = [trendRes, gainRes, activeRes, loserRes].some(r => r.status === 'fulfilled');
    if (!anyOk) throw new Error('all sources returned errors');

    const syms = new Set(CORE_ALWAYS_SCAN);
    if (trendRes.status  === 'fulfilled') extractTrending(trendRes.value).forEach(s => syms.add(s));
    if (gainRes.status   === 'fulfilled') extractScreener(gainRes.value).forEach(s => syms.add(s));
    if (activeRes.status === 'fulfilled') extractScreener(activeRes.value).forEach(s => syms.add(s));
    if (loserRes.status  === 'fulfilled') extractScreener(loserRes.value).forEach(s => syms.add(s));

    const result = [...syms].slice(0, 120);
    _universeCache = { symbols: result, ts: Date.now(), source: 'dynamic' };
    console.log(`[universe] Dynamic: ${result.length} symbols (trending+gainers+actives+losers)`);
    return result;
  } catch (err) {
    console.warn(`[universe] Dynamic fetch failed (${err.message}) — using fallback`);
    // Don't cache the fallback so the next call retries Yahoo Finance
    return [...FALLBACK_UNIVERSE];
  }
}

// Fetch quotes via Moomoo (real-time) with Yahoo Finance fallback
async function fetchBatchQuotes(symbols, batchSize = 40, batchDelayMs = 100) {
  // Try Moomoo in one shot (handles batching internally via subscription)
  try {
    const result = await moomooGetQuotes(symbols);
    if (result.success && result.quotes.length > 0) {
      // Normalise to same shape fetchQuote() returns
      return result.quotes.map(q => ({
        symbol:  q.symbol,
        name:    q.name,
        price:   q.price,
        prev:    q.prev_close,
        chg_pct: q.change_pct,
      }));
    }
  } catch {
    // Moomoo unavailable — fall through to Yahoo Finance
  }

  // Yahoo Finance fallback (rate-limited, batched)
  const results = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(sym => fetchQuote(sym)));
    results.push(...batchResults.filter(Boolean));
    if (i + batchSize < symbols.length) await delay(batchDelayMs);
  }
  return results;
}

export async function getMarketMovers({ limit = 25 } = {}) {
  const cached = cacheGet('movers', 10 * 60 * 1000);
  if (cached) return { ...cached, cached: true };

  const universe = await fetchDynamicUniverse();
  const quotes   = await fetchBatchQuotes(universe);

  // Filter: price $5–$1000, need a % change value
  const valid = quotes.filter(q =>
    q.price != null && q.price >= 5 && q.price <= 1000 && q.chg_pct != null
  );

  // Sort by absolute % change — biggest movers today first
  valid.sort((a, b) => Math.abs(b.chg_pct) - Math.abs(a.chg_pct));

  const movers = valid.slice(0, limit).map(q => ({
    symbol:    q.symbol,
    name:      q.name || q.symbol,
    price:     q.price,
    chg_pct:   q.chg_pct,
    direction: q.chg_pct > 0 ? 'up' : 'down',
  }));

  const gainers   = movers.filter(m => m.chg_pct > 0).slice(0, 10);
  const decliners = movers.filter(m => m.chg_pct < 0).slice(0, 5);

  const result = {
    success:         true,
    timestamp:       new Date().toISOString(),
    universe_size:   universe.length,
    universe_source: _universeCache.source,
    count:           movers.length,
    movers,
    gainers,
    decliners,
    note: `Ranked by % move today across ${universe.length} dynamically fetched liquid US stocks`,
  };
  cacheSet('movers', result);
  return result;
}

// ─── Full Day Trading Dashboard ───────────────────────────────────────────────

export async function getDayTradingDashboard() {
  // Run sequentially to avoid hammering Yahoo Finance
  const sentiment = await getMarketSentiment();
  await delay(500);
  const sectors   = await getSectorPerformance();
  await delay(500);
  const trending  = await getTrendingStocks({ limit: 10 });

  return {
    success: true,
    timestamp: new Date().toISOString(),
    sentiment,
    sectors,
    trending,
  };
}
