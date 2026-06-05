#!/usr/bin/env node
/**
 * ETL #5: Pull macro data from FRED (Federal Reserve Economic Data) → macro_data table.
 *
 * FRED is FREE — no API key required for public series. Optional API key gives
 * higher rate limits (120 req/min).
 *
 * Series we pull (regime-backtest essentials):
 *   - DFF      Effective Federal Funds Rate (daily)
 *   - DGS10    10-Year Treasury Constant Maturity Rate (daily)
 *   - DGS2     2-Year Treasury (daily) — for yield curve
 *   - VIXCLS   CBOE Volatility Index (daily close) — replacement for Polygon's missing VIX
 *   - CPIAUCSL Consumer Price Index (monthly)
 *   - UNRATE   Unemployment Rate (monthly)
 *   - GDP      Gross Domestic Product (quarterly)
 *   - UMCSENT  University of Michigan Consumer Sentiment (monthly)
 *
 * Idempotent: ON CONFLICT (series_id, observation_date) DO UPDATE.
 * Runtime: ~30 seconds total (10 series × 1 API call each).
 *
 * Usage:
 *   node scripts/etl/load-fred-macro.mjs
 *   FROM=2016-01-01 node scripts/etl/load-fred-macro.mjs
 *   DRY=1           node scripts/etl/load-fred-macro.mjs
 */
import 'dotenv/config';
import { initDb, query } from '../../src/core/db.js';

const FRED_KEY = process.env.FRED_API_KEY || '';   // optional; works without
const FROM     = process.env.FROM || '2016-01-01';
const TO       = process.env.TO   || new Date().toISOString().slice(0, 10);
const DRY      = process.env.DRY === '1';

const SERIES = [
  { id: 'DFF',      name: 'Effective Federal Funds Rate', frequency: 'daily',     units: 'percent' },
  { id: 'DGS10',    name: '10-Year Treasury Yield',       frequency: 'daily',     units: 'percent' },
  { id: 'DGS2',     name: '2-Year Treasury Yield',        frequency: 'daily',     units: 'percent' },
  { id: 'T10Y2Y',   name: '10Y-2Y Treasury Spread',       frequency: 'daily',     units: 'percent' },
  { id: 'VIXCLS',   name: 'CBOE VIX (daily close)',       frequency: 'daily',     units: 'index' },
  { id: 'CPIAUCSL', name: 'Consumer Price Index',         frequency: 'monthly',   units: 'index_1982_84=100' },
  { id: 'UNRATE',   name: 'Unemployment Rate',            frequency: 'monthly',   units: 'percent' },
  { id: 'GDP',      name: 'Gross Domestic Product',       frequency: 'quarterly', units: 'billions_usd' },
  { id: 'UMCSENT',  name: 'U-Mich Consumer Sentiment',    frequency: 'monthly',   units: 'index_1966Q1=100' },
];

async function fetchSeries(s) {
  // FRED public endpoint. Without key, rate limited but works for our 10 calls.
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${s.id}` +
              `&observation_start=${FROM}&observation_end=${TO}` +
              `&file_type=json` +
              (FRED_KEY ? `&api_key=${FRED_KEY}` : '');
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`FRED ${s.id} HTTP ${r.status}`);
  const d = await r.json();
  return d.observations || [];
}

async function loadOne(s) {
  console.log(`  fetching ${s.id} (${s.name})...`);
  const obs = await fetchSeries(s);
  console.log(`    got ${obs.length} observations`);
  if (DRY) return obs.length;
  let inserted = 0;
  for (const o of obs) {
    if (!o.date || o.value === '.' || o.value == null) continue;
    try {
      await query(`
        INSERT INTO macro_data (series_id, series_name, observation_date, value, units, frequency, source)
        VALUES ($1, $2, $3, $4, $5, $6, 'FRED')
        ON CONFLICT (series_id, observation_date) DO UPDATE
          SET value = EXCLUDED.value, ingested_at = NOW()
      `, [s.id, s.name, o.date, Number(o.value), s.units, s.frequency]);
      inserted++;
    } catch (e) {
      if (inserted === 0) console.warn(`    row err: ${e.message?.slice(0, 80)}`);
    }
  }
  return inserted;
}

async function main() {
  await initDb();
  console.log(`[load-fred-macro] dry=${DRY} ${FROM} → ${TO} key=${FRED_KEY ? 'yes' : 'no (public)'}`);
  let total = 0;
  for (const s of SERIES) {
    try {
      const n = await loadOne(s);
      total += n;
    } catch (e) {
      console.error(`  FAIL ${s.id}: ${e.message}`);
    }
    // Be polite to FRED's public endpoint
    await new Promise(r => setTimeout(r, 600));
  }
  console.log(`[load-fred-macro] DONE total=${total} observations across ${SERIES.length} series`);
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e); process.exit(1); });
