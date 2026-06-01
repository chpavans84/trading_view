#!/usr/bin/env node
/**
 * src/research/backfill-congress.js
 *
 * One-time backfill of UW congressional trades.
 * UW allows 90 trading days of history (~2026-01-15 onward).
 * Paginates through all available pages and upserts into uw_congressional_trades.
 *
 * Run: node src/research/backfill-congress.js
 */

import pg from 'pg';
import https from 'https';
import * as dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const UW_KEY = process.env.UNUSUAL_WHALES_API || process.env.UW_API_KEY;
const RATE_LIMIT_MS = 600; // ~100 req/min safe
const MAX_PAGES     = 200; // safety cap (100 rows/page × 200 = 20,000 rows)
const EARLIEST_DATE = '2026-01-01'; // stop if all trades on page are before this

function get(path) {
  return new Promise((resolve, reject) => {
    const url = `https://api.unusualwhales.com${path}`;
    const opts = {
      headers: { Authorization: `Bearer ${UW_KEY}`, Accept: 'application/json' },
    };
    https.get(url, opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const INSERT_SQL = `
  INSERT INTO uw_congressional_trades
    (ticker, member_name, chamber, transaction_type, amount_range, traded_at, filed_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7)
  ON CONFLICT DO NOTHING
`;

async function run() {
  let inserted = 0;
  let skipped  = 0;
  let pages    = 0;
  let done     = false;

  console.log('═══════════════════════════════════════════════════');
  console.log('  UW Congressional Trades Backfill');
  console.log('  Coverage: last 90 trading days');
  console.log('═══════════════════════════════════════════════════\n');

  for (let page = 1; page <= MAX_PAGES && !done; page++) {
    const json = await get(`/api/congress/recent-trades?limit=100&page=${page}`);

    if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
      console.log(`  Page ${page}: empty — stopping.`);
      break;
    }

    const rows = json.data;
    pages++;

    // Check if we've gone past our earliest date
    const allBefore = rows.every(r =>
      r.transaction_date && r.transaction_date < EARLIEST_DATE
    );

    let pageInserted = 0;
    let pageSkipped  = 0;

    for (const r of rows) {
      // Skip rows without a ticker (bonds, fund notes)
      if (!r.ticker) { pageSkipped++; skipped++; continue; }

      const ticker   = r.ticker.toUpperCase();
      const member   = r.name ?? r.reporter ?? null;
      const chamber  = r.member_type ?? null;   // 'house' or 'senate'
      const txType   = r.txn_type ?? null;       // 'Buy' or 'Sell'
      const amounts  = r.amounts ?? null;
      const tradedAt = r.transaction_date ?? null;
      const filedAt  = r.filed_at_date ? new Date(r.filed_at_date) : null;

      try {
        const res = await pool.query(INSERT_SQL, [ticker, member, chamber, txType, amounts, tradedAt, filedAt]);
        if (res.rowCount > 0) { pageInserted++; inserted++; }
        else { pageSkipped++; skipped++; }
      } catch (e) {
        console.error(`  INSERT error ${ticker}:`, e.message);
        pageSkipped++; skipped++;
      }
    }

    const tradeDates = rows.filter(r => r.transaction_date).map(r => r.transaction_date);
    const minDate = tradeDates.length ? tradeDates.reduce((a, b) => a < b ? a : b) : '?';
    const maxDate = tradeDates.length ? tradeDates.reduce((a, b) => a > b ? a : b) : '?';

    console.log(`  Page ${page}: ${rows.length} rows | tx ${minDate}→${maxDate} | +${pageInserted} new, ${pageSkipped} skip`);

    if (allBefore) {
      console.log(`  All trades before ${EARLIEST_DATE} — stopping.`);
      done = true;
    }

    await sleep(RATE_LIMIT_MS);
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Pages fetched : ${pages}`);
  console.log(`  Inserted      : ${inserted}`);
  console.log(`  Skipped       : ${skipped}`);

  const summary = await pool.query(`
    SELECT COUNT(*) as cnt,
           MIN(traded_at)::text as earliest,
           MAX(traded_at)::text as latest
    FROM uw_congressional_trades
  `);
  const s = summary.rows[0];
  console.log(`\n  DB total rows : ${s.cnt}`);
  console.log(`  DB date range : ${s.earliest} → ${s.latest}`);
  console.log('═══════════════════════════════════════════════════');

  await pool.end();
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
