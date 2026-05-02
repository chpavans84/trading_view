/**
 * Downloads the last 6 quarters of income statement data for every symbol
 * in the S&P 500 + NASDAQ-100 universe from Yahoo Finance and upserts
 * into the fundamentals table.
 *
 * Run: npm run research:fundamentals
 */

import pg from 'pg';
import { SP500, NASDAQ100 } from './sp500.js';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BATCH_SIZE    = 8;
const BATCH_DELAY   = 600;   // ms between batches
const FETCH_TIMEOUT = 10000; // ms per symbol

const SKIP_SYMBOLS = new Set([
  // ETFs — no income statements
  'SPY','QQQ','IWM','DIA','GLD','SLV','USO','TLT','HYG','LQD',
  // Defunct / bankrupt
  'SIVB','FRC','FSR','GOEV','WKHS','RIDE','NKLA','SOLO','CIIC','SPNV','L3H',
  // Acquired / delisted
  'ABMD','SPLK','PXD','CLR','NEWR','SUMO','CYBR','SPR','HCP','PARA',
  'CMA','DFS','FYBR','EZCORP','WBA','HES','SQ','CPE','CDEV','ESTE','SNV','MMC',
]);

// Deduplicated universe, excluding ETFs and delisted symbols
const SYMBOLS = [...new Set([...SP500, ...NASDAQ100])].filter(s => !SKIP_SYMBOLS.has(s));

// ── Yahoo Finance crumb (obtained once, reused for all requests) ──────────────

let _cookie = '';
let _crumb  = '';

async function ensureCrumb() {
  if (_crumb) return;
  const cookieRes = await fetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  _cookie = (cookieRes.headers.get('set-cookie') || '').split(';')[0];

  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': 'Mozilla/5.0', Cookie: _cookie },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  _crumb = (await crumbRes.text()).trim();
  if (!_crumb) throw new Error('Could not obtain Yahoo Finance crumb');
  console.log(`[fundamentals] Crumb obtained: ${_crumb}\n`);
}

function yahooUrl(symbol) {
  const modules = 'incomeStatementHistoryQuarterly,earningsHistory';
  return (
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/` +
    `${encodeURIComponent(symbol)}` +
    `?modules=${modules}&crumb=${encodeURIComponent(_crumb)}`
  );
}

// ── Fetch & parse ─────────────────────────────────────────────────────────────

async function fetchQuarters(symbol) {
  const res = await fetch(yahooUrl(symbol), {
    headers: { 'User-Agent': 'Mozilla/5.0', Cookie: _cookie },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  const result = json?.quoteSummary?.result?.[0];
  if (!result) throw new Error('empty quoteSummary result');

  const history =
    result.incomeStatementHistoryQuarterly?.incomeStatementHistory;
  if (!Array.isArray(history) || history.length === 0) {
    throw new Error('no quarterly income statement data');
  }

  // Build EPS lookup keyed by period_end date string (YYYY-MM-DD)
  const epsMap = {};
  const ehHistory = result.earningsHistory?.history ?? [];
  for (const e of ehHistory) {
    if (e.quarter?.raw) {
      const dateKey = new Date(e.quarter.raw * 1000).toISOString().slice(0, 10);
      epsMap[dateKey] = e.epsActual?.raw ?? null;
    }
  }

  return history.slice(0, 6).map(entry => {
    const period_end = new Date(entry.endDate.raw * 1000).toISOString().slice(0, 10);
    return {
      period_end,
      revenue:          entry.totalRevenue?.raw   ?? null,
      gross_profit:     entry.grossProfit?.raw    ?? null,
      operating_income: entry.operatingIncome?.raw ?? entry.ebit?.raw ?? null,
      net_income:       entry.netIncome?.raw       ?? null,
      eps_diluted:      epsMap[period_end]         ?? entry.dilutedEPS?.raw ?? null,
      eps_basic:        entry.basicEPS?.raw        ?? null,
      shares_diluted:   entry.dilutedAverageShares?.raw ?? null,
    };
  });
}

// ── DB upsert ─────────────────────────────────────────────────────────────────

async function upsertQuarters(symbol, quarters) {
  let count = 0;
  for (const q of quarters) {
    await pool.query(
      `INSERT INTO fundamentals
         (symbol, period_end, period_type,
          revenue, gross_profit, operating_income,
          net_income, eps_diluted, eps_basic, shares_diluted)
       VALUES ($1,$2,'quarterly',$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (symbol, period_type, period_end) DO UPDATE SET
         revenue          = EXCLUDED.revenue,
         gross_profit     = EXCLUDED.gross_profit,
         operating_income = EXCLUDED.operating_income,
         net_income       = EXCLUDED.net_income,
         eps_diluted      = EXCLUDED.eps_diluted,
         eps_basic        = EXCLUDED.eps_basic,
         shares_diluted   = EXCLUDED.shares_diluted,
         fetched_at       = NOW()`,
      [
        symbol,
        q.period_end,
        q.revenue,
        q.gross_profit,
        q.operating_income,
        q.net_income,
        q.eps_diluted,
        q.eps_basic,
        q.shares_diluted,
      ]
    );
    count++;
  }
  return count;
}

// ── Per-symbol worker ─────────────────────────────────────────────────────────

async function processSymbol(symbol) {
  try {
    const quarters = await fetchQuarters(symbol);
    const rows     = await upsertQuarters(symbol, quarters);
    return { ok: true, rows };
  } catch (err) {
    console.error(`  [skip] ${symbol}: ${err.message}`);
    return { ok: false, rows: 0 };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('══════════════════════════════════════════');
  console.log('  Fundamentals Downloader');
  console.log(`  Universe: ${SYMBOLS.length} symbols`);
  console.log('══════════════════════════════════════════\n');

  await ensureCrumb();

  // Ensure table exists (idempotent — also created by db.js initDb)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fundamentals (
      id               SERIAL PRIMARY KEY,
      symbol           TEXT NOT NULL,
      period_end       DATE NOT NULL,
      period_type      TEXT NOT NULL DEFAULT 'quarterly',
      revenue          BIGINT,
      gross_profit     BIGINT,
      operating_income BIGINT,
      net_income       BIGINT,
      eps_diluted      FLOAT,
      eps_basic        FLOAT,
      shares_diluted   BIGINT,
      fetched_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(symbol, period_type, period_end)
    )
  `);

  let done      = 0;
  let totalRows = 0;
  const failed  = [];

  for (let i = 0; i < SYMBOLS.length; i += BATCH_SIZE) {
    const batch   = SYMBOLS.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(processSymbol));

    for (let j = 0; j < batch.length; j++) {
      done++;
      if (results[j].ok) {
        totalRows += results[j].rows;
      } else {
        failed.push(batch[j]);
      }
    }

    if (done % 50 === 0 || done === SYMBOLS.length) {
      console.log(`[fundamentals] ${done}/${SYMBOLS.length} done — ${totalRows} rows upserted`);
    }

    if (i + BATCH_SIZE < SYMBOLS.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  console.log('\n══════════════════════════════════════════');
  console.log(`  Done.`);
  console.log(`  Symbols processed : ${SYMBOLS.length}`);
  console.log(`  Rows upserted     : ${totalRows}`);
  console.log(`  Failed            : ${failed.length}${failed.length ? ' — ' + failed.join(', ') : ''}`);
  console.log('══════════════════════════════════════════');

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
