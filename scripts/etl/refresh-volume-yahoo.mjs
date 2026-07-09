#!/usr/bin/env node
/**
 * scripts/etl/refresh-volume-yahoo.mjs
 *
 * Fills backtest_prices.volume with CONSOLIDATED daily volume from Yahoo (full tape),
 * replacing the old dependency on the Polygon lake. This is the forward volume source
 * once the Polygon subscription is cancelled.
 *
 * Why Yahoo (not Alpaca): refresh-prices.js writes OHLC from Alpaca's free IEX feed and
 * deliberately leaves volume NULL — IEX is ~3% of tape (NVDA reads ~5M instead of ~150M),
 * which 30×-deflates the bot's ADV/rvol features and wrongly trips the ≥$5M liquidity gate.
 * Yahoo's daily `volume` is consolidated (full tape), so it's the correct free source.
 *
 * Scope: only symbols that have a recent backtest_prices row with NULL volume (the exact
 * gap) — so it shrinks to nothing as volume gets filled (idempotent, self-healing).
 * Surgical: UPDATEs volume ONLY; never touches Alpaca's OHLC.
 *
 * Run:  node --env-file=.env scripts/etl/refresh-volume-yahoo.mjs [--days 7] [--limit N] [--batch 8]
 * Must run BEFORE lake.sync_daily so the OLTP→Silver forward-fill sees real volume.
 */
import YahooFinance from 'yahoo-finance2';
import pg from 'pg';

const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'], validation: { logErrors: false } });
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}
const DAYS  = Number(arg('days', 7));
const LIMIT = arg('limit') ? Number(arg('limit')) : null;
const BATCH = Number(arg('batch', 8));
const DELAY = Number(arg('delay', 600));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fillSymbol(symbol) {
  // Fetch a little wider than DAYS so weekends/holidays don't clip the window.
  const from = new Date(Date.now() - (DAYS + 4) * 86400_000).toISOString().slice(0, 10);
  const to   = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  try {
    const rows = await yahooFinance.historical(symbol, { period1: from, period2: to, interval: '1d' });
    if (!rows?.length) return { symbol, updated: 0, skipped: true };
    let updated = 0;
    for (const row of rows) {
      if (row.volume == null) continue;
      const d = row.date.toISOString().slice(0, 10);
      // Only fill rows that already exist (Alpaca wrote OHLC) and whose volume differs.
      const res = await pool.query(
        `UPDATE backtest_prices SET volume = $1
           WHERE symbol = $2 AND price_date = $3 AND volume IS DISTINCT FROM $1`,
        [row.volume, symbol, d]
      );
      updated += res.rowCount;
    }
    return { symbol, updated };
  } catch (err) {
    return { symbol, updated: 0, error: err.message };
  }
}

async function run() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  // The gap: symbols with a recent row missing volume.
  const { rows } = await pool.query(
    `SELECT DISTINCT symbol FROM backtest_prices
      WHERE price_date > (CURRENT_DATE - $1::int) AND volume IS NULL AND close IS NOT NULL
      ORDER BY symbol ${LIMIT ? 'LIMIT ' + LIMIT : ''}`,
    [DAYS]
  );
  const symbols = rows.map(r => r.symbol);
  if (!symbols.length) { console.log('[volume-yahoo] no NULL-volume rows in window — nothing to do'); await pool.end(); return; }

  console.log(`[volume-yahoo] ${symbols.length} symbols with NULL volume in last ${DAYS}d ` +
              `→ batch=${BATCH} delay=${DELAY}ms${LIMIT ? ` (limited to ${LIMIT})` : ''}`);
  let done = 0, updated = 0, errors = 0, noData = 0;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const results = await Promise.all(symbols.slice(i, i + BATCH).map(fillSymbol));
    for (const r of results) {
      done++;
      if (r.error) errors++;
      else if (r.skipped) noData++;
      else updated += r.updated;
    }
    if (done % 200 === 0 || i + BATCH >= symbols.length) {
      console.log(`[volume-yahoo] ${done}/${symbols.length} — ${updated} rows filled, ${noData} no-data, ${errors} errors`);
    }
    if (i + BATCH < symbols.length) await sleep(DELAY);
  }

  const { rows: chk } = await pool.query(
    `SELECT price_date, count(*) FILTER (WHERE volume IS NOT NULL) AS have_vol, count(*) AS total
       FROM backtest_prices WHERE price_date > (CURRENT_DATE - $1::int)
      GROUP BY price_date ORDER BY price_date DESC LIMIT 5`, [DAYS]);
  console.log('[volume-yahoo] DONE. Recent volume coverage:');
  for (const r of chk) console.log(`   ${r.price_date.toISOString().slice(0,10)}: ${r.have_vol}/${r.total} rows have volume`);
  await pool.end();
}

run().catch(err => { console.error('[volume-yahoo] FATAL', err); process.exit(1); });
