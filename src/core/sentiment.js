/**
 * Market sentiment data from free public sources.
 * Sources: Yahoo Finance (VIX, futures, sectors, trending)
 */

const YF_BASE = 'https://query2.finance.yahoo.com';

export const SECTOR_MAP = {
  AAPL: 'XLK', MSFT: 'XLK', NVDA: 'XLK', AMD: 'XLK',
  MU: 'XLK', AVGO: 'XLK', QCOM: 'XLK', INTC: 'XLK',
  TSM: 'XLK', SMCI: 'XLK', MRVL: 'XLK',
  GOOGL: 'XLC', META: 'XLC', NFLX: 'XLC',
  AMZN: 'XLY', TSLA: 'XLY',
  JPM: 'XLF',
  XOM: 'XLE',
  RTX: 'XLI', LMT: 'XLI',
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
  const r = await fetch(
    `${YF_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=10d`,
    { headers: HEADERS }
  );
  if (!r.ok) return null;
  const d = await r.json();
  const closes = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null);
  if (!closes || closes.length < 6) return null;
  // 5-day return: most recent close vs close 5 bars ago
  return +((closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100).toFixed(2);
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
