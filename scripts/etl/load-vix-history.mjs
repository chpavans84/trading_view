#!/usr/bin/env node
/**
 * ETL #6: Pull historical VIX → vix_history table (extends our 2023-04+ ^VIX coverage).
 *
 * Polygon doesn't include US indices in our subscription (403). For regime
 * backtests we need VIX going back at least 2016. Two sources:
 *   - PRIMARY: FRED VIXCLS (covered by load-fred-macro.mjs's macro_data table —
 *              this script is redundant if FRED loaded).
 *   - FALLBACK: Yahoo Finance ^VIX (free, no key). Use yahoo-finance2 npm lib.
 *
 * This script uses Yahoo as a redundant secondary source for OHLC (FRED only
 * provides close). Useful if you want intra-day high/low for VIX-spike detection.
 *
 * Idempotent: ON CONFLICT (price_date) DO UPDATE.
 * Runtime: ~10 seconds (single bulk API call).
 *
 * Usage:
 *   node scripts/etl/load-vix-history.mjs                # default 2016-01-01 → now
 *   FROM=2010-01-01 node scripts/etl/load-vix-history.mjs
 *   DRY=1 node scripts/etl/load-vix-history.mjs
 */
import 'dotenv/config';
import YahooFinance from 'yahoo-finance2';
import { initDb, query } from '../../src/core/db.js';

const yf  = new YahooFinance.default();
const FROM = process.env.FROM || '2016-01-01';
const TO   = process.env.TO   || new Date().toISOString().slice(0, 10);
const DRY  = process.env.DRY === '1';

async function main() {
  await initDb();
  console.log(`[load-vix-history] dry=${DRY} ${FROM} → ${TO}`);

  // Yahoo's ^VIX symbol — daily OHLC
  const rows = await yf.historical('^VIX', { period1: FROM, period2: TO, interval: '1d' });
  console.log(`  got ${rows.length} VIX daily rows`);

  if (DRY) {
    console.log(`  first 3:`, rows.slice(0, 3).map(r => ({ date: r.date.toISOString().slice(0,10), c: r.close })));
    console.log(`  last 3:`, rows.slice(-3).map(r => ({ date: r.date.toISOString().slice(0,10), c: r.close })));
    return;
  }

  let inserted = 0;
  for (const r of rows) {
    const dateStr = r.date.toISOString().slice(0, 10);
    try {
      await query(`
        INSERT INTO vix_history (price_date, open, high, low, close, volume, source)
        VALUES ($1, $2, $3, $4, $5, $6, 'yahoo')
        ON CONFLICT (price_date) DO UPDATE
          SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
              close = EXCLUDED.close, volume = EXCLUDED.volume,
              source = EXCLUDED.source, ingested_at = NOW()
      `, [dateStr, r.open, r.high, r.low, r.close, r.volume]);
      inserted++;
    } catch (e) {
      if (inserted === 0) console.warn(`  ${dateStr} err: ${e.message?.slice(0, 80)}`);
    }
  }
  console.log(`[load-vix-history] DONE inserted=${inserted}`);
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e); process.exit(1); });
