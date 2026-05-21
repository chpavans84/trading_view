/**
 * Downloads 5 years of daily OHLCV for index + sector ETFs
 * and stores in backtest_prices alongside SP500 + NDX100 stocks.
 *
 * Used by: src/regime-bot/  (regime model needs DB-backed price history)
 *
 * Run:  npm run research:download-etfs
 *       (or)  node --env-file=.env src/research/download-etfs.js
 * Safe to re-run — UPSERT on (symbol, price_date).
 *
 * Curation rationale:
 *   - 4 index ETFs (SPY, QQQ, IWM, DIA): broad market regime measurement
 *   - 11 SPDR Sector ETFs (XLF..XLC): sector rotation is regime-driven, the
 *     strongest test of whether the gate adds independent information
 *
 * Refresh: SPDR sector list is stable; re-check yearly. If State Street
 * adds/removes a sector ETF, update INDEX_ETFS / SECTOR_ETFS below.
 */

import YahooFinance from 'yahoo-finance2';
import pg from 'pg';
import { fileURLToPath } from 'url';

const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'] });
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const YEARS_BACK = 5;
const BATCH_SIZE = 5;
const DELAY_MS   = 800;

// ─── Basket ───────────────────────────────────────────────────────────────────
// Index ETFs — broad market exposure
const INDEX_ETFS = [
  'SPY',  // S&P 500
  'QQQ',  // Nasdaq 100
  'IWM',  // Russell 2000
  'DIA',  // Dow Jones Industrial Average
];

// SPDR Sector ETFs — 11 GICS sectors
const SECTOR_ETFS = [
  'XLF',  // Financials
  'XLE',  // Energy
  'XLU',  // Utilities
  'XLK',  // Technology
  'XLV',  // Health Care
  'XLI',  // Industrials
  'XLB',  // Materials
  'XLP',  // Consumer Staples
  'XLY',  // Consumer Discretionary
  'XLRE', // Real Estate
  'XLC',  // Communication Services
];

export const ETF_BASKET = [...INDEX_ETFS, ...SECTOR_ETFS];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startDate() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - YEARS_BACK);
  return d.toISOString().split('T')[0];
}

// ─── Per-symbol download ──────────────────────────────────────────────────────
async function downloadSymbol(symbol) {
  const from = startDate();
  const to   = new Date().toISOString().split('T')[0];

  try {
    const rows = await yahooFinance.historical(symbol, {
      period1:  from,
      period2:  to,
      interval: '1d',
    });

    if (!rows?.length) return { symbol, count: 0, skipped: true };

    let inserted = 0;
    for (const row of rows) {
      if (!row.close) continue;
      await pool.query(
        `INSERT INTO backtest_prices (symbol, price_date, open, high, low, close, volume, adj_close)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (symbol, price_date) DO UPDATE SET
           open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
           close=EXCLUDED.close, volume=EXCLUDED.volume, adj_close=EXCLUDED.adj_close`,
        [
          symbol,
          row.date.toISOString().split('T')[0],
          row.open    ?? null,
          row.high    ?? null,
          row.low     ?? null,
          row.close,
          row.volume  ?? null,
          row.adjClose ?? row.close,
        ]
      );
      inserted++;
    }
    return { symbol, count: inserted };
  } catch (err) {
    return { symbol, count: 0, error: err.message };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  const total = ETF_BASKET.length;
  console.log(`\nDownloading ${total} ETFs — ${YEARS_BACK} years of daily data`);
  console.log(`  Batch size: ${BATCH_SIZE}  |  Delay: ${DELAY_MS}ms between batches`);
  console.log(`  Estimated time: ~${Math.ceil(total / BATCH_SIZE * DELAY_MS / 1000)}s\n`);

  let done = 0, errors = 0, totalRows = 0;

  for (let i = 0; i < ETF_BASKET.length; i += BATCH_SIZE) {
    const batch   = ETF_BASKET.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(downloadSymbol));
    for (const r of results) {
      done++;
      if (r.error) {
        errors++;
        console.log(`  ✗ ${r.symbol.padEnd(6)} ERROR: ${r.error}`);
      } else if (r.skipped) {
        console.log(`  ⚠ ${r.symbol.padEnd(6)} no data returned`);
      } else {
        totalRows += r.count;
        console.log(`  ✓ ${r.symbol.padEnd(6)} ${String(r.count).padStart(5)} rows`);
      }
    }
    if (i + BATCH_SIZE < ETF_BASKET.length) await sleep(DELAY_MS);
  }

  console.log(`\nDone — ${done - errors}/${total} ETFs OK, ${errors} errors, ${totalRows} total rows inserted/updated\n`);
  await pool.end();
  process.exit(errors > 0 ? 1 : 0);
}

// Run only when invoked directly (not when imported)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch(err => {
    console.error('[fatal]', err);
    pool.end().catch(() => {});
    process.exit(1);
  });
}
