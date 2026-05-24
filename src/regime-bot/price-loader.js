/**
 * regime-bot/price-loader.js
 *
 * Reads OHLCV from backtest_prices, writes a CSV the vendored markov_regime.py
 * can ingest via its --csv flag. ONE source of truth — no yfinance fallback
 * in the hot path (the bot is DB-backed by design; if a symbol is missing
 * from backtest_prices, we surface it as an error rather than silently filling).
 *
 * CSV format (per markov_regime.py's load_csv):
 *   date,close
 *   2021-05-21,420.15
 *   ...
 */

import { promises as fs } from 'fs';
import path from 'path';
import { MARKOV } from './config.js';
// Shared pool — one connection pool per regime-bot process.
import { getPool } from './db-pool.js';

// ─── Pull rows ──────────────────────────────────────────────────────────────
/**
 * Returns daily close prices for `ticker` in chronological order.
 * @param {string} ticker
 * @param {object} [opts]
 * @param {string} [opts.from]      ISO date YYYY-MM-DD inclusive lower bound
 * @param {string} [opts.to]        ISO date YYYY-MM-DD inclusive upper bound
 * @returns {Promise<Array<{date: string, close: number}>>}
 */
export async function getPricesArray(ticker, { from, to } = {}) {
  if (!ticker || typeof ticker !== 'string') {
    throw new Error('getPricesArray: ticker required');
  }
  const where = ['symbol = $1'];
  const params = [ticker.toUpperCase()];
  if (from) { where.push(`price_date >= $${params.length + 1}`); params.push(from); }
  if (to)   { where.push(`price_date <= $${params.length + 1}`); params.push(to); }

  const { rows } = await getPool().query(
    `SELECT price_date, COALESCE(adj_close, close) AS close
     FROM backtest_prices
     WHERE ${where.join(' AND ')}
     ORDER BY price_date ASC`,
    params
  );
  return rows.map(r => ({
    date:  r.price_date instanceof Date ? r.price_date.toISOString().split('T')[0] : String(r.price_date),
    close: Number(r.close),
  })).filter(r => Number.isFinite(r.close));
}

// ─── Write CSV ──────────────────────────────────────────────────────────────
/**
 * Writes a CSV file for the markov script. Path lives under MARKOV.csv_dir.
 * Filename: <TICKER>_<YYYYMMDD>.csv where date is the last bar in the slice.
 * @param {string} ticker
 * @param {object} [opts]
 * @param {string} [opts.from]
 * @param {string} [opts.to]
 * @param {number} [opts.minRows=253]   safety floor — markov needs ≥252 for min_train
 * @returns {Promise<{csvPath: string, rowCount: number, firstDate: string, lastDate: string}>}
 */
export async function writePricesCsv(ticker, opts = {}) {
  const { from, to, minRows = 253 } = opts;
  const rows = await getPricesArray(ticker, { from, to });

  if (rows.length < minRows) {
    throw new Error(
      `writePricesCsv: ticker ${ticker} has only ${rows.length} rows ` +
      `in backtest_prices (need ≥${minRows}). Run research:download to backfill.`
    );
  }

  await fs.mkdir(MARKOV.csv_dir, { recursive: true });
  const lastDate = rows[rows.length - 1].date;
  const stamp    = lastDate.replaceAll('-', '');
  const csvPath  = path.join(MARKOV.csv_dir, `${ticker.toUpperCase()}_${stamp}.csv`);

  // Build CSV body
  const header = 'date,close\n';
  const body   = rows.map(r => `${r.date},${r.close}`).join('\n');
  await fs.writeFile(csvPath, header + body + '\n', 'utf8');

  return {
    csvPath,
    rowCount:  rows.length,
    firstDate: rows[0].date,
    lastDate,
  };
}

// ─── Sweep stale CSVs ───────────────────────────────────────────────────────
/**
 * Removes regime CSVs older than maxAgeMs. Best-effort, ignores errors.
 * @param {number} [maxAgeMs=24*3600*1000]
 * @returns {Promise<{scanned: number, removed: number}>}
 */
export async function cleanupStaleCsvs(maxAgeMs = 24 * 3600 * 1000) {
  let entries;
  try {
    entries = await fs.readdir(MARKOV.csv_dir);
  } catch {
    return { scanned: 0, removed: 0 };
  }

  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith('.csv')) continue;
    const full = path.join(MARKOV.csv_dir, name);
    try {
      const st = await fs.stat(full);
      if (st.mtimeMs < cutoff) {
        await fs.unlink(full);
        removed++;
      }
    } catch {
      // ignore — file vanished or permission issue
    }
  }
  return { scanned: entries.length, removed };
}

// ─── Self-test when invoked directly ────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const ticker = process.argv[2] || 'SPY';
    try {
      const { csvPath, rowCount, firstDate, lastDate } = await writePricesCsv(ticker);
      console.log(`Wrote ${rowCount} rows for ${ticker}`);
      console.log(`  Range: ${firstDate} → ${lastDate}`);
      console.log(`  File : ${csvPath}`);

      // Peek at the first 3 + last 3 lines so user can sanity-check format
      const content = await fs.readFile(csvPath, 'utf8');
      const lines   = content.trim().split('\n');
      console.log('  Preview:');
      console.log('    ' + lines.slice(0, 3).join('\n    '));
      console.log('    ...');
      console.log('    ' + lines.slice(-2).join('\n    '));
    } catch (e) {
      console.error('[fatal]', e.message);
      process.exit(1);
    } finally {
      const { closePool } = await import('./db-pool.js');
      await closePool();
    }
  })();
}
