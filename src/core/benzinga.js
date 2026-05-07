/**
 * Benzinga API client — news, options activity, guidance, fundamentals,
 * earnings, FDA calendar, dividends.
 * All functions return null (never throw) so callers can use Promise.allSettled.
 */

const BASE = 'https://api.benzinga.com/api';
const key  = () => process.env.BENZINGA_API;
const HDR  = { Accept: 'application/json' };

// ─── TTL cache ────────────────────────────────────────────────────────────────
const _cache = new Map();
async function _cached(cacheKey, ttlMs, fn) {
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  try {
    const data = await fn();
    _cache.set(cacheKey, { ts: Date.now(), data });
    return data;
  } catch (e) {
    console.error(`[benzinga] ${cacheKey}:`, e.message);
    return null;
  }
}

async function _get(url) {
  const r = await fetch(url, { headers: HDR, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}

export function isBenzingaConfigured() { return !!process.env.BENZINGA_API; }

// ─── News ─────────────────────────────────────────────────────────────────────
// Returns articles with sentiment tag per stock.
export async function getBzNews({ symbol, limit = 10 } = {}) {
  if (!key()) return null;
  const sym = symbol ? `&tickers=${encodeURIComponent(symbol.toUpperCase())}` : '';
  return _cached(`bz:news:${symbol || 'market'}:${limit}`, 5 * 60_000, async () => {
    const data = await _get(`${BASE}/v2/news?token=${key()}${sym}&pageSize=${limit}&displayOutput=full`);
    const articles = (Array.isArray(data) ? data : []).map(a => ({
      id:           a.id,
      title:        a.title,
      teaser:       a.teaser,
      url:          a.url,
      source:       'Benzinga',
      published_at: a.created,
      updated_at:   a.updated,
      author:       a.author,
      channels:     (a.channels || []).map(c => c.name),
      tickers:      (a.stocks  || []).map(s => s.name),
      sentiment:    (a.stocks  || []).find(s => s.name === symbol?.toUpperCase())?.sentiment ?? null,
    }));
    return { articles, total: articles.length };
  });
}

// ─── Unusual Options Activity ─────────────────────────────────────────────────
// Large sweeps and blocks that indicate institutional directional bets.
export async function getBzOptionsActivity({ symbol, limit = 25, sentiment } = {}) {
  if (!key()) return null;
  const sym  = symbol   ? `&ticker=${encodeURIComponent(symbol.toUpperCase())}` : '';
  const sent = sentiment ? `&sentiment=${sentiment}` : '';
  const cacheKey = `bz:opts:${symbol||'all'}:${sentiment||'any'}:${limit}`;
  return _cached(cacheKey, 3 * 60_000, async () => {
    const data = await _get(`${BASE}/v1/signal/option_activity?token=${key()}${sym}${sent}&pageSize=${limit}`);
    const items = (data?.option_activity || []).map(o => ({
      id:               o.id,
      ticker:           o.ticker,
      date:             o.date,
      time:             o.time,
      put_call:         o.put_call,        // 'CALL' | 'PUT'
      sentiment:        o.sentiment,       // 'BULLISH' | 'BEARISH' | 'NEUTRAL'
      strike:           parseFloat(o.strike_price) || null,
      expiry:           o.date_expiration,
      underlying_price: parseFloat(o.underlying_price) || null,
      size:             parseInt(o.size) || 0,
      cost_basis:       parseFloat(o.cost_basis) || null,   // total $ spent (size × premium × 100)
      open_interest:    parseInt(o.open_interest) || 0,
      volume:           parseInt(o.volume) || 0,
      aggressor:        o.aggressor_ind,   // 'Ask' = buyer, 'Bid' = seller
      activity_type:    o.option_activity_type,  // 'SWEEP' | 'BLOCK' | 'UNUSUAL_BLOCK'
      exchange:         o.exchange,
    }));
    return { items, total: items.length };
  });
}

// ─── Earnings Calendar ────────────────────────────────────────────────────────
// Richer than Yahoo — includes EPS surprise, revenue surprise, confirmed flag.
export async function getBzEarnings({ symbol, dateFrom, dateTo, limit = 20 } = {}) {
  if (!key()) return null;
  const today   = new Date().toISOString().split('T')[0];
  const from    = dateFrom || today;
  const to      = dateTo   || today;
  const sym     = symbol ? `&parameters[tickers]=${encodeURIComponent(symbol.toUpperCase())}` : '';
  return _cached(`bz:earn:${symbol||'all'}:${from}:${to}`, 15 * 60_000, async () => {
    const data = await _get(`${BASE}/v2.1/calendar/earnings?token=${key()}${sym}&parameters[date_from]=${from}&parameters[date_to]=${to}&pageSize=${limit}`);
    const rows = (data?.earnings || []).map(e => ({
      ticker:              e.ticker,
      name:                e.name,
      date:                e.date,
      time:                e.time,                         // 'pre-market' | 'after-hours' | 'during'
      date_confirmed:      e.date_confirmed === '1',
      importance:          parseInt(e.importance) || 0,    // 0-5 Benzinga scale
      eps:                 parseFloat(e.eps)            || null,
      eps_est:             parseFloat(e.eps_est)        || null,
      eps_surprise:        parseFloat(e.eps_surprise)   || null,
      eps_surprise_pct:    parseFloat(e.eps_surprise_percent) || null,
      revenue:             parseFloat(e.revenue)        || null,
      revenue_est:         parseFloat(e.revenue_est)    || null,
      revenue_surprise:    parseFloat(e.revenue_surprise) || null,
      revenue_surprise_pct:parseFloat(e.revenue_surprise_percent) || null,
      period:              e.period,
      period_year:         e.period_year,
    }));
    return { earnings: rows, total: rows.length };
  });
}

// ─── Company Guidance ─────────────────────────────────────────────────────────
// Forward guidance changes — raised/lowered vs prior.
export async function getBzGuidance({ symbol, dateFrom, limit = 10 } = {}) {
  if (!key()) return null;
  const today = new Date().toISOString().split('T')[0];
  const from  = dateFrom || (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().split('T')[0]; })();
  const sym   = symbol ? `&parameters[tickers]=${encodeURIComponent(symbol.toUpperCase())}` : '';
  return _cached(`bz:guid:${symbol||'all'}:${from}`, 15 * 60_000, async () => {
    const data = await _get(`${BASE}/v2.1/calendar/guidance?token=${key()}${sym}&parameters[date_from]=${from}&pageSize=${limit}`);
    const rows = (data?.guidance || []).map(g => ({
      ticker:           g.ticker,
      name:             g.name,
      date:             g.date,
      period:           g.period,
      importance:       parseInt(g.importance) || 0,
      eps_guidance_min: parseFloat(g.eps_guidance_min) || null,
      eps_guidance_max: parseFloat(g.eps_guidance_max) || null,
      eps_prior_min:    parseFloat(g.eps_guidance_prior_min) || null,
      eps_prior_max:    parseFloat(g.eps_guidance_prior_max) || null,
      rev_guidance_min: parseFloat(g.revenue_guidance_min) || null,
      rev_guidance_max: parseFloat(g.revenue_guidance_max) || null,
      rev_prior_min:    parseFloat(g.revenue_guidance_prior_min) || null,
      rev_prior_max:    parseFloat(g.revenue_guidance_prior_max) || null,
      // Derive raised/lowered from midpoint comparison
      direction: (() => {
        const mid     = v => v != null ? v : null;
        const curMid  = (mid(parseFloat(g.eps_guidance_min)) + mid(parseFloat(g.eps_guidance_max))) / 2;
        const prevMid = (mid(parseFloat(g.eps_guidance_prior_min)) + mid(parseFloat(g.eps_guidance_prior_max))) / 2;
        if (!curMid || !prevMid) return 'unknown';
        return curMid > prevMid * 1.005 ? 'raised' : curMid < prevMid * 0.995 ? 'lowered' : 'in-line';
      })(),
    }));
    return { guidance: rows, total: rows.length };
  });
}

// ─── FDA Calendar ─────────────────────────────────────────────────────────────
export async function getBzFDA({ dateFrom, dateTo, limit = 30 } = {}) {
  if (!key()) return null;
  const today = new Date().toISOString().split('T')[0];
  const from  = dateFrom || today;
  const to    = dateTo   || (() => { const d = new Date(); d.setDate(d.getDate() + 60); return d.toISOString().split('T')[0]; })();
  return _cached(`bz:fda:${from}:${to}`, 60 * 60_000, async () => {
    const data = await _get(`${BASE}/v2.1/calendar/fda?token=${key()}&parameters[date_from]=${from}&parameters[date_to]=${to}&pageSize=${limit}`);
    const rows = (Array.isArray(data) ? data : []).map(f => ({
      date:       f.date,
      drug:       f.drug,
      companies:  (f.companies || []).map(c => ({ ticker: c.ticker, name: c.name })),
      event_type: f.event_type,
      commentary: f.commentary,
    }));
    return { events: rows, total: rows.length };
  });
}

// ─── Dividends ────────────────────────────────────────────────────────────────
export async function getBzDividends({ symbol, dateFrom, dateTo, limit = 30 } = {}) {
  if (!key()) return null;
  const today = new Date().toISOString().split('T')[0];
  const from  = dateFrom || today;
  const to    = dateTo   || (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().split('T')[0]; })();
  const sym   = symbol ? `&parameters[tickers]=${encodeURIComponent(symbol.toUpperCase())}` : '';
  return _cached(`bz:div:${symbol||'all'}:${from}:${to}`, 60 * 60_000, async () => {
    const data = await _get(`${BASE}/v2.1/calendar/dividends?token=${key()}${sym}&parameters[date_from]=${from}&parameters[date_to]=${to}&pageSize=${limit}`);
    const rows = (data?.dividends || []).map(d => ({
      ticker:        d.ticker,
      name:          d.name,
      ex_date:       d.ex_dividend_date || d.date,
      payment_date:  d.payable_date,
      record_date:   d.record_date,
      dividend:      parseFloat(d.dividend)       || null,
      dividend_prior:parseFloat(d.dividend_prior) || null,
      frequency:     d.dividend_frequency,
      yield:         parseFloat(d.yield)          || null,
    }));
    return { dividends: rows, total: rows.length };
  });
}

// ─── Fundamentals ─────────────────────────────────────────────────────────────
export async function getBzFundamentals({ symbol } = {}) {
  if (!key() || !symbol) return null;
  return _cached(`bz:fund:${symbol.toUpperCase()}`, 24 * 60 * 60_000, async () => {
    const data = await _get(`${BASE}/v2.1/fundamentals?token=${key()}&symbols=${encodeURIComponent(symbol.toUpperCase())}`);
    const f = Array.isArray(data) ? data[0] : data;
    if (!f) return null;
    const vr = f.valuationRatios    || {};
    const cp = f.companyProfile     || {};
    const er = f.earningRatios      || {};
    const rp = (f.earningReports    || [])[0] || {};
    return {
      symbol:         symbol.toUpperCase(),
      pe_ratio:       vr.peRatio            ?? null,
      pb_ratio:       vr.pbRatio            ?? null,
      ps_ratio:       vr.psRatio            ?? null,
      ev_ebitda:      vr.evToEbitda         ?? null,
      price_to_fcf:   vr.priceToFreeCashflow ?? null,
      market_cap:     cp.marketCap          ?? null,
      shares_out:     cp.sharesOutstanding  ?? null,
      beta:           cp.beta               ?? null,
      eps_growth_ttm: er.dpsGrowth          ?? null,
      revenue:        rp.totalRevenue       ?? null,
      gross_profit:   rp.grossProfit        ?? null,
      net_income:     rp.netIncome          ?? null,
      operating_cf:   rp.operatingCashFlow  ?? null,
    };
  });
}

// ─── Scoring helper — recent options sentiment for a symbol ───────────────────
// Returns 'bullish' | 'bearish' | 'neutral' | null based on last 5 sweeps.
export async function getBzOptionsSentiment(symbol) {
  if (!key() || !symbol) return null;
  try {
    const result = await getBzOptionsActivity({ symbol, limit: 10 });
    const items  = result?.items || [];
    if (!items.length) return null;
    let bull = 0, bear = 0;
    for (const o of items) {
      if (o.sentiment === 'BULLISH') bull++;
      else if (o.sentiment === 'BEARISH') bear++;
    }
    if (bull + bear === 0) return 'neutral';
    if (bull >= bear * 2) return 'bullish';
    if (bear >= bull * 2) return 'bearish';
    return 'neutral';
  } catch { return null; }
}
