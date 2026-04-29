/**
 * Downloads 3 years of daily OHLCV data for S&P 500 + VIX + SPY
 * from Yahoo Finance and stores it in backtest_prices.
 *
 * Run:  node --env-file=.env src/research/download-prices.js
 * Safe to re-run — skips symbols already up to date.
 */

import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'] });
import pg from 'pg';
import { SP500, NASDAQ100, MARKET_SYMBOLS } from './sp500.js';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const YEARS_BACK  = 3;
const BATCH_SIZE  = 5;    // symbols per concurrent batch
const DELAY_MS    = 800;  // ms between batches — avoids Yahoo rate limiting

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startDate() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - YEARS_BACK);
  return d.toISOString().split('T')[0];
}

async function downloadSymbol(symbol) {
  const from = startDate();
  const to   = new Date().toISOString().split('T')[0];

  try {
    const rows = await yahooFinance.historical(symbol, {
      period1: from,
      period2: to,
      interval: '1d',
    });

    if (!rows?.length) return { symbol, count: 0, skipped: true };

    // Upsert each day
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
          row.open   ?? null,
          row.high   ?? null,
          row.low    ?? null,
          row.close,
          row.volume ?? null,
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

async function run() {
  const allSymbols = [...new Set([...MARKET_SYMBOLS, ...SP500, ...NASDAQ100])];
  const total      = allSymbols.length;
  let done = 0, errors = 0;

  console.log(`\n📥  Downloading ${total} symbols — ${YEARS_BACK} years of daily data`);
  console.log(`    Batch size: ${BATCH_SIZE}  |  Delay: ${DELAY_MS}ms between batches`);
  console.log(`    Estimated time: ~${Math.ceil(total / BATCH_SIZE * DELAY_MS / 60000)} minutes\n`);

  for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
    const batch   = allSymbols.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(downloadSymbol));

    for (const r of results) {
      done++;
      const pct = ((done / total) * 100).toFixed(1);
      if (r.error) {
        errors++;
        console.log(`  ✗ [${pct}%] ${r.symbol.padEnd(8)} ERROR: ${r.error}`);
      } else if (r.skipped) {
        console.log(`  ○ [${pct}%] ${r.symbol.padEnd(8)} no data`);
      } else {
        console.log(`  ✓ [${pct}%] ${r.symbol.padEnd(8)} ${r.count} rows`);
      }
    }

    if (i + BATCH_SIZE < allSymbols.length) await sleep(DELAY_MS);
  }

  // Summary
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT symbol) as symbols, COUNT(*) as rows,
            MIN(price_date) as from_date, MAX(price_date) as to_date
     FROM backtest_prices`
  );
  console.log(`\n✅  Done. ${errors} errors.`);
  console.log(`    DB: ${rows[0].symbols} symbols, ${rows[0].rows} rows`);
  console.log(`    Date range: ${rows[0].from_date} → ${rows[0].to_date}\n`);

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
