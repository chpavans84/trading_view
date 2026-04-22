/**
 * News, earnings, and financials data from free public sources.
 *
 * Sources:
 *   Yahoo Finance search endpoint  — news headlines (no auth needed)
 *   SEC EDGAR XBRL API             — earnings actuals, revenue, EPS (authoritative, no limits)
 *   SEC EDGAR full-text search     — 8-K, 10-Q, 10-K filings
 */

const YF_SEARCH = 'https://query2.finance.yahoo.com';
const EDGAR_DATA = 'https://data.sec.gov';
const EDGAR_SEARCH = 'https://efts.sec.gov';

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};
const EDGAR_HEADERS = {
  'User-Agent': 'tradingview-mcp research-tool contact@example.com',
  'Accept': 'application/json',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchJSON(url, headers, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1000 * i));
    const res = await fetch(url, { headers });
    if (res.status === 429 && i < retries) continue;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
  }
}

// Cache CIK lookups to avoid re-fetching the tickers file
const _cikCache = new Map();

// Resolve ticker → zero-padded CIK using SEC tickers file
async function getCIK(ticker) {
  const t = ticker.toUpperCase();
  if (_cikCache.has(t)) return _cikCache.get(t);

  const data = await fetchJSON('https://www.sec.gov/files/company_tickers.json', EDGAR_HEADERS);
  const match = Object.values(data).find(c => c.ticker?.toUpperCase() === t);
  if (!match) throw new Error(`Ticker ${t} not found in SEC EDGAR — may be foreign-listed or delisted`);

  const cik = String(match.cik_str).padStart(10, '0');
  _cikCache.set(t, cik);
  return cik;
}

// ─── News ────────────────────────────────────────────────────────────────────

export async function getSymbolNews({ symbol, limit = 10 } = {}) {
  const ticker = symbol.toUpperCase().replace(/^(NASDAQ:|NYSE:|AMEX:)/, '');

  const data = await fetchJSON(
    `${YF_SEARCH}/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=${limit}&quotesCount=0&enableFuzzyQuery=false`,
    YF_HEADERS
  );

  const articles = (data.news || []).slice(0, limit).map(a => ({
    title: a.title,
    publisher: a.publisher,
    published: new Date(a.providerPublishTime * 1000).toISOString(),
    summary: a.summary || null,
    url: a.link,
    related_tickers: a.relatedTickers || [],
  }));

  const headlineText = articles.map(a => a.title.toLowerCase()).join(' ');
  const raisedKw  = ['raises guidance', 'raises outlook', 'raises forecast', 'raises full-year', 'raised guidance', 'raised outlook', 'raises its'];
  const loweredKw = ['lowers guidance', 'cuts outlook', 'reduces forecast', 'below expectations', 'disappoints', 'lowered guidance', 'cuts forecast', 'misses estimates'];
  const guidance_signal =
    raisedKw.some(k => headlineText.includes(k))  ? 'raised'  :
    loweredKw.some(k => headlineText.includes(k)) ? 'lowered' : 'neutral';

  return { success: true, symbol: ticker, article_count: articles.length, articles, guidance_signal };
}

// ─── Earnings (SEC EDGAR XBRL) ───────────────────────────────────────────────

export async function getEarnings({ symbol } = {}) {
  const ticker = symbol.toUpperCase().replace(/^(NASDAQ:|NYSE:|AMEX:)/, '');
  const cik = await getCIK(ticker);

  // Fetch all company facts (XBRL data — the source of truth for all public financials)
  const facts = await fetchJSON(`${EDGAR_DATA}/api/xbrl/companyfacts/CIK${cik}.json`, EDGAR_HEADERS);
  const us = facts.facts?.['us-gaap'] || {};

  // EPS (diluted) — most reliable earnings metric
  const epsData = us.EarningsPerShareDiluted?.units?.['USD/shares']
    || us.EarningsPerShareBasic?.units?.['USD/shares']
    || [];

  const seenEps = new Set();
  const allEpsQuarters = epsData
    .filter(e => e.form === '10-Q' || e.form === '10-K')
    .filter(e => e.fp && e.fp !== 'FY')
    .sort((a, b) => new Date(b.end) - new Date(a.end))
    .filter(e => { if (seenEps.has(e.end)) return false; seenEps.add(e.end); return true; })
    .slice(0, 8)
    .map(e => ({ period: e.fp, end_date: e.end, filed: e.filed, eps_actual: e.val, form: e.form }));

  // Revenue — fetch 8 quarters for YoY quality scoring
  const allRevData = (us.Revenues?.units?.USD
    || us.RevenueFromContractWithCustomerExcludingAssessedTax?.units?.USD
    || us.SalesRevenueNet?.units?.USD
    || [])
    .filter(e => e.form === '10-Q' || e.form === '10-K')
    .filter(e => e.fp && e.fp !== 'FY')
    .sort((a, b) => new Date(b.end) - new Date(a.end))
    .slice(0, 8)
    .map(e => ({ period: e.fp, end_date: e.end, revenue: e.val }));

  // Merge EPS + revenue, compute earnings_quality vs same quarter last year
  const history = allEpsQuarters.slice(0, 4).map((q) => {
    const rev = allRevData.find(r => r.end_date === q.end_date);

    // Find same quarter last year (within 45 days of 1 year prior)
    const yearAgoTarget = new Date(q.end_date);
    yearAgoTarget.setFullYear(yearAgoTarget.getFullYear() - 1);
    const yearAgoEps = allEpsQuarters.slice(4).find(r =>
      Math.abs(new Date(r.end_date) - yearAgoTarget) < 45 * 86400000
    );
    const yearAgoRev = yearAgoEps
      ? allRevData.find(r => r.end_date === yearAgoEps.end_date)
      : null;

    const epsGrew = yearAgoEps && q.eps_actual != null && yearAgoEps.eps_actual != null
      ? q.eps_actual > yearAgoEps.eps_actual : null;
    const revGrew = rev?.revenue != null && yearAgoRev?.revenue != null
      ? rev.revenue > yearAgoRev.revenue : null;

    const earnings_quality =
      epsGrew == null && revGrew == null   ? null :
      epsGrew === true && revGrew === true  ? 'strong' :
      epsGrew === true || revGrew === true  ? 'moderate' : 'weak';

    return { ...q, revenue: rev?.revenue ?? null, earnings_quality };
  });

  // Next earnings date — try Yahoo Finance news search for "earnings date"
  let nextEarningsDates = [];
  try {
    const newsData = await fetchJSON(
      `${YF_SEARCH}/v1/finance/search?q=${encodeURIComponent(ticker + ' earnings date')}&newsCount=3&quotesCount=1`,
      YF_HEADERS
    );
    const quote = newsData?.quotes?.[0];
    if (quote?.earningsTimestamp) {
      nextEarningsDates.push(new Date(quote.earningsTimestamp * 1000).toISOString().split('T')[0]);
    }
  } catch (_) {}

  return {
    success: true,
    symbol: ticker,
    cik,
    next_earnings_dates: nextEarningsDates,
    history,
    note: 'EPS and revenue from SEC EDGAR XBRL (authoritative). Forward estimates require paid data feed.',
  };
}

// ─── Financials (SEC EDGAR XBRL) ─────────────────────────────────────────────

export async function getFinancials({ symbol, period = 'quarterly' } = {}) {
  const ticker = symbol.toUpperCase().replace(/^(NASDAQ:|NYSE:|AMEX:)/, '');
  const cik = await getCIK(ticker);

  const facts = await fetchJSON(`${EDGAR_DATA}/api/xbrl/companyfacts/CIK${cik}.json`, EDGAR_HEADERS);
  const us = facts.facts?.['us-gaap'] || {};

  const formFilter = period === 'annual' ? 'FY' : null; // null = quarterly
  const formType = period === 'annual' ? '10-K' : '10-Q';

  function extract(concept, unit = 'USD', count = 4) {
    const seen = new Set();
    return (us[concept]?.units?.[unit] || [])
      .filter(e => e.form === formType)
      .filter(e => period === 'annual' ? e.fp === 'FY' : e.fp !== 'FY')
      .sort((a, b) => new Date(b.end) - new Date(a.end))
      .filter(e => { if (seen.has(e.end)) return false; seen.add(e.end); return true; })
      .slice(0, count);
  }

  const revenueEntries = extract('Revenues')
    .length ? extract('Revenues')
    : extract('RevenueFromContractWithCustomerExcludingAssessedTax')
    .length ? extract('RevenueFromContractWithCustomerExcludingAssessedTax')
    : extract('SalesRevenueNet');

  const netIncomeEntries = extract('NetIncomeLoss');
  const grossProfitEntries = extract('GrossProfit');
  const operatingIncomeEntries = extract('OperatingIncomeLoss');
  const epsEntries = extract('EarningsPerShareDiluted', 'USD/shares');

  // Build period-aligned statements
  const periods = revenueEntries.map(r => r.end);
  const statements = periods.map(endDate => {
    const get = (arr) => arr.find(e => e.end === endDate)?.val ?? null;
    const rev = get(revenueEntries);
    const net = get(netIncomeEntries);
    return {
      end_date: endDate,
      revenue: rev,
      gross_profit: get(grossProfitEntries),
      operating_income: get(operatingIncomeEntries),
      net_income: net,
      eps_diluted: get(epsEntries),
      profit_margin_pct: rev && net ? +((net / rev) * 100).toFixed(2) : null,
    };
  });

  // YoY revenue growth (compare most recent to same quarter last year)
  let revenue_growth_yoy = null;
  if (statements.length >= 5) {
    const latest = statements[0].revenue;
    const yearAgo = statements[4]?.revenue;
    if (latest && yearAgo) revenue_growth_yoy = +((latest - yearAgo) / Math.abs(yearAgo) * 100).toFixed(2);
  } else if (statements.length >= 2 && period === 'annual') {
    const latest = statements[0].revenue;
    const prev = statements[1]?.revenue;
    if (latest && prev) revenue_growth_yoy = +((latest - prev) / Math.abs(prev) * 100).toFixed(2);
  }

  return {
    success: true,
    symbol: ticker,
    cik,
    period,
    revenue_growth_yoy_pct: revenue_growth_yoy,
    statements,
    source: 'SEC EDGAR XBRL (official filings)',
  };
}

// ─── Earnings Calendar (Nasdaq) ───────────────────────────────────────────────

const NASDAQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.nasdaq.com',
  'Referer': 'https://www.nasdaq.com/',
};

export async function getEarningsCalendar({ date, limit = 100 } = {}) {
  const dateStr = date || new Date().toISOString().split('T')[0];

  const data = await fetchJSON(
    `https://api.nasdaq.com/api/calendar/earnings?date=${dateStr}`,
    NASDAQ_HEADERS
  );

  const rows = (data?.data?.rows || []).slice(0, limit);
  const earnings = rows.map(r => ({
    symbol: r.symbol,
    company: r.name,
    call_time: r.time === 'time-pre-market' ? 'BMO' : r.time === 'time-after-hours' ? 'AMC' : r.time,
    fiscal_quarter: r.fiscalQuarterEnding,
    eps_estimate: r.epsForecast ? parseFloat(r.epsForecast.replace(/[$,]/g, '')) : null,
    eps_last_year: r.lastYearEPS ? parseFloat(r.lastYearEPS.replace(/[$,]/g, '')) : null,
    last_year_report_date: r.lastYearRptDt || null,
    num_estimates: r.noOfEsts ? Number(r.noOfEsts) : null,
    market_cap: r.marketCap ? parseInt(r.marketCap.replace(/[$,]/g, '')) : null,
  }));

  return { success: true, date: dateStr, count: earnings.length, earnings };
}

// ─── Earnings Scanner (multi-ticker) ──────────────────────────────────────────

export async function scanEarnings({ symbols, days_ahead = 14 } = {}) {
  if (!symbols?.length) throw new Error('symbols array is required');

  const tickers = new Set(symbols.map(s => s.toUpperCase().replace(/^(NASDAQ:|NYSE:|AMEX:)/, '')));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Fetch Nasdaq calendar for each day in the window, de-duplicate via Set
  const days = [];
  for (let d = 0; d <= days_ahead; d++) {
    const dt = new Date(today.getTime() + d * 86400000);
    days.push(dt.toISOString().split('T')[0]);
  }

  // Fetch all calendar days in parallel (Nasdaq handles this without rate limits)
  const calResults = await Promise.allSettled(
    days.map(day =>
      fetchJSON(`https://api.nasdaq.com/api/calendar/earnings?date=${day}`, NASDAQ_HEADERS)
    )
  );

  // Build map: symbol → { date, eps_estimate, company, call_time }
  const calendarMap = new Map();
  for (let i = 0; i < days.length; i++) {
    if (calResults[i].status !== 'fulfilled') continue;
    const rows = calResults[i].value?.data?.rows || [];
    for (const r of rows) {
      const sym = r.symbol?.toUpperCase();
      if (sym && tickers.has(sym) && !calendarMap.has(sym)) {
        calendarMap.set(sym, {
          earnings_date: days[i],
          call_time: r.time === 'time-pre-market' ? 'BMO' : r.time === 'time-after-hours' ? 'AMC' : r.time,
          eps_estimate: r.epsForecast ? parseFloat(r.epsForecast.replace(/[$,]/g, '')) : null,
          eps_last_year: r.lastYearEPS ? parseFloat(r.lastYearEPS.replace(/[$,]/g, '')) : null,
          company: r.name,
        });
      }
    }
  }

  const upcoming = [...calendarMap.entries()]
    .map(([sym, meta]) => ({ symbol: sym, ...meta }))
    .sort((a, b) => a.earnings_date.localeCompare(b.earnings_date));

  // Fetch earnings history + financials for each upcoming in parallel
  const [earningsResults, financialsResults] = await Promise.all([
    Promise.allSettled(upcoming.map(u => getEarnings({ symbol: u.symbol }))),
    Promise.allSettled(upcoming.map(u => getFinancials({ symbol: u.symbol }))),
  ]);

  const results = upcoming.map((u, i) => {
    const earnData = earningsResults[i].status === 'fulfilled' ? earningsResults[i].value : null;
    const finData = financialsResults[i].status === 'fulfilled' ? financialsResults[i].value : null;

    const revGrowth = finData?.revenue_growth_yoy_pct ?? null;
    const history = earnData?.history || [];
    const latestEps = history[0]?.eps_actual ?? null;
    const prevEps = history[1]?.eps_actual ?? null;
    const epsGrowth = latestEps && prevEps && prevEps !== 0
      ? +((latestEps - prevEps) / Math.abs(prevEps) * 100).toFixed(1)
      : null;

    return {
      symbol: u.symbol,
      company: u.company,
      earnings_date: u.earnings_date,
      call_time: u.call_time,
      eps_estimate: u.eps_estimate,
      eps_last_year: u.eps_last_year,
      revenue_growth_yoy_pct: revGrowth,
      eps_growth_qoq_pct: epsGrowth,
      latest_eps: latestEps,
      latest_revenue: history[0]?.revenue ?? null,
      recent_quarters: history.slice(0, 4),
      error: earnData === null ? earningsResults[i].reason?.message : null,
    };
  });

  return {
    success: true,
    scanned: tickers.size,
    with_upcoming_earnings: results.length,
    days_ahead,
    results,
    source: 'Nasdaq earnings calendar + SEC EDGAR XBRL history',
  };
}

// ─── Earnings Surprise (upcoming estimate vs historical beat streak) ──────────

export async function getEarningsSurprise({ symbol } = {}) {
  const ticker = symbol.toUpperCase().replace(/^(NASDAQ:|NYSE:|AMEX:)/, '');

  // 1. Scan Nasdaq calendar for next 30 days to find upcoming entry
  const today = new Date();
  const dates = Array.from({ length: 31 }, (_, d) =>
    new Date(today.getTime() + d * 86400000).toISOString().split('T')[0]
  );

  let upcoming = null;
  for (let i = 0; i < dates.length && !upcoming; i += 5) {
    const batch = dates.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(d => fetchJSON(`https://api.nasdaq.com/api/calendar/earnings?date=${d}`, NASDAQ_HEADERS))
    );
    for (let j = 0; j < results.length; j++) {
      if (results[j].status !== 'fulfilled') continue;
      const match = (results[j].value?.data?.rows || []).find(r => r.symbol?.toUpperCase() === ticker);
      if (match) {
        upcoming = {
          earnings_date: batch[j],
          eps_estimate: match.epsForecast ? parseFloat(match.epsForecast.replace(/[$,]/g, '')) || null : null,
          call_time: match.time === 'time-pre-market' ? 'BMO' : match.time === 'time-after-hours' ? 'AMC' : match.time,
        };
        break;
      }
    }
  }

  // 2. Get 8 quarters of actuals from EDGAR for YoY beat streak
  const cik = await getCIK(ticker);
  const facts = await fetchJSON(`${EDGAR_DATA}/api/xbrl/companyfacts/CIK${cik}.json`, EDGAR_HEADERS);
  const epsData = facts.facts?.['us-gaap']?.EarningsPerShareDiluted?.units?.['USD/shares']
    || facts.facts?.['us-gaap']?.EarningsPerShareBasic?.units?.['USD/shares']
    || [];

  const seen = new Set();
  const quarters = epsData
    .filter(e => (e.form === '10-Q' || e.form === '10-K') && e.fp && e.fp !== 'FY')
    .sort((a, b) => new Date(b.end) - new Date(a.end))
    .filter(e => { if (seen.has(e.end)) return false; seen.add(e.end); return true; })
    .slice(0, 8)
    .map(e => ({ period: e.fp, end_date: e.end, eps_actual: e.val }));

  // 3. Compute YoY beat streak (actual > same quarter last year)
  let beat_streak = 0;
  const surprises = [];
  for (let i = 0; i < 4 && i < quarters.length; i++) {
    const q = quarters[i];
    const yearAgoTarget = new Date(q.end_date);
    yearAgoTarget.setFullYear(yearAgoTarget.getFullYear() - 1);
    const yearAgo = quarters.slice(4).find(r =>
      Math.abs(new Date(r.end_date) - yearAgoTarget) < 45 * 86400000
    );
    if (yearAgo && q.eps_actual != null && yearAgo.eps_actual != null && yearAgo.eps_actual !== 0) {
      const surprise_pct = ((q.eps_actual - yearAgo.eps_actual) / Math.abs(yearAgo.eps_actual)) * 100;
      surprises.push(surprise_pct);
      if (q.eps_actual > yearAgo.eps_actual) {
        if (i === beat_streak) beat_streak++;
      } else {
        break;
      }
    }
  }

  const avg_surprise_pct = surprises.length > 0
    ? +(surprises.reduce((a, b) => a + b, 0) / surprises.length).toFixed(1)
    : null;

  return {
    success: true,
    symbol: ticker,
    earnings_date: upcoming?.earnings_date ?? null,
    eps_estimate: upcoming?.eps_estimate ?? null,
    call_time: upcoming?.call_time ?? null,
    eps_actual_last: quarters[0]?.eps_actual ?? null,
    beat_streak,
    avg_surprise_pct,
    note: 'beat_streak = consecutive quarters of YoY EPS growth (proxy, uses EDGAR actuals)',
  };
}

// ─── Pre-Earnings Drift (10-day price momentum) ───────────────────────────────

export async function getPreEarningsDrift({ symbol } = {}) {
  const ticker = symbol.toUpperCase().replace(/^(NASDAQ:|NYSE:|AMEX:)/, '');

  const data = await fetchJSON(
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=10d`,
    { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  );

  const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null);
  if (!closes || closes.length < 6) {
    return { success: false, symbol: ticker, error: 'Insufficient price history' };
  }

  // closes[0] = oldest, closes[last] = most recent
  // 5-day return: compare most recent close to close 5 bars ago
  const recent = closes[closes.length - 1];
  const fiveDaysAgo = closes[closes.length - 6] ?? closes[0];
  const drift_5d_pct = +((recent / fiveDaysAgo - 1) * 100).toFixed(2);
  const drift_direction = Math.abs(drift_5d_pct) < 1 ? 'flat' : drift_5d_pct > 0 ? 'up' : 'down';

  return {
    success: true,
    symbol: ticker,
    drift_5d_pct,
    drift_direction,
    current_price: recent,
  };
}

// ─── Insider Buying (Form 4 count as proxy) ───────────────────────────────────

export async function getInsiderBuying({ symbol } = {}) {
  const ticker = symbol.toUpperCase().replace(/^(NASDAQ:|NYSE:|AMEX:)/, '');
  const cik = await getCIK(ticker);

  const data = await fetchJSON(`${EDGAR_DATA}/submissions/CIK${cik}.json`, EDGAR_HEADERS);
  const forms = data.filings?.recent?.form || [];
  const dates = data.filings?.recent?.filingDate || [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);

  let insider_buys_60d = 0;
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] === '4') {
      if (new Date(dates[i]) >= cutoff) insider_buys_60d++;
      else if (insider_buys_60d > 0) break; // dates are descending — stop once past 60-day window
    }
  }

  return {
    success: true,
    symbol: ticker,
    insider_buys_60d,
    signal: insider_buys_60d >= 2 ? 'strong' : 'none',
    note: 'Count of Form 4 (insider transaction) filings in last 60 days — proxy for insider activity',
  };
}

// ─── SEC Filings ──────────────────────────────────────────────────────────────

export async function getFilings({ symbol, form_type = '8-K', limit = 5 } = {}) {
  const ticker = symbol.toUpperCase().replace(/^(NASDAQ:|NYSE:|AMEX:)/, '');
  const cik = await getCIK(ticker);

  // Use EDGAR submissions API — returns recent filings sorted by date
  const data = await fetchJSON(`${EDGAR_DATA}/submissions/CIK${cik}.json`, EDGAR_HEADERS);

  const recent = data.filings?.recent || {};
  const forms = recent.form || [];
  const dates = recent.filingDate || [];
  const descriptions = recent.primaryDocument || [];
  const accNums = recent.accessionNumber || [];

  const filtered = [];
  for (let i = 0; i < forms.length && filtered.length < limit; i++) {
    if (forms[i] === form_type) {
      filtered.push({
        form: forms[i],
        filed: dates[i],
        document: descriptions[i],
        url: `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accNums[i].replace(/-/g, '')}/${descriptions[i]}`,
        accession: accNums[i],
      });
    }
  }

  return {
    success: true,
    symbol: ticker,
    company: data.name,
    cik,
    form_type,
    filing_count: filtered.length,
    filings: filtered,
  };
}
