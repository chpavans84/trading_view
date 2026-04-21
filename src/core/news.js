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

  return { success: true, symbol: ticker, article_count: articles.length, articles };
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
  const quarters = epsData
    .filter(e => e.form === '10-Q' || e.form === '10-K')
    .filter(e => e.fp && e.fp !== 'FY')
    .sort((a, b) => new Date(b.end) - new Date(a.end))
    .filter(e => { if (seenEps.has(e.end)) return false; seenEps.add(e.end); return true; })
    .slice(0, 4)
    .map(e => ({
      period: e.fp,
      end_date: e.end,
      filed: e.filed,
      eps_actual: e.val,
      form: e.form,
    }));

  // Revenue
  const revData = (us.Revenues?.units?.USD
    || us.RevenueFromContractWithCustomerExcludingAssessedTax?.units?.USD
    || us.SalesRevenueNet?.units?.USD
    || [])
    .filter(e => e.form === '10-Q' || e.form === '10-K')
    .filter(e => e.fp && e.fp !== 'FY')
    .sort((a, b) => new Date(b.end) - new Date(a.end))
    .slice(0, 4)
    .map(e => ({ period: e.fp, end_date: e.end, revenue: e.val }));

  // Merge EPS + revenue by period/end_date
  const history = quarters.map(q => {
    const rev = revData.find(r => r.end_date === q.end_date);
    return { ...q, revenue: rev?.revenue ?? null };
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
