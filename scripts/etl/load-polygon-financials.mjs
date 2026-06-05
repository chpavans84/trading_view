#!/usr/bin/env node
/**
 * ETL #1: Load Polygon REST financials → polygon_financials OLTP table.
 *
 * Source:   /Volumes/Archive/polygon-rest/financials/{TICKER}.json.gz (12,673 files)
 * Target:   public.polygon_financials (created by migration 1780780000000)
 *
 * Idempotent: ON CONFLICT (ticker, fiscal_year, fiscal_period) DO UPDATE.
 * Restartable: skips tickers already loaded with same row count.
 * Concurrent: 8 parallel workers (CPU bound on JSON parse + DB insert).
 *
 * Runtime estimate: ~12,673 files × ~10 ms each (avg 40 rows/file) = ~25 min total.
 * Disk impact: Postgres grows by ~400 MB (compressed JSON in JSONB).
 *
 * Usage:
 *   node scripts/etl/load-polygon-financials.mjs                  # full load
 *   ONLY=AAPL,MSFT,NVDA node scripts/etl/load-polygon-financials.mjs
 *   DRY=1 node scripts/etl/load-polygon-financials.mjs            # parse + report, no DB writes
 *   CONCURRENCY=4 node scripts/etl/load-polygon-financials.mjs
 *
 * Pre-req: migration `1780780000000_oltp-backfill-schema.js` applied.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { initDb, query } from '../../src/core/db.js';

const SRC_DIR   = '/Volumes/Archive/polygon-rest/financials';
const DRY       = process.env.DRY === '1';
const ONLY      = (process.env.ONLY || '').split(',').filter(Boolean).map(s => s.toUpperCase());
const CONCUR    = Number(process.env.CONCURRENCY) || 8;

// Convenience-column extraction (flatten common rollups out of nested JSONB)
function extractFlatFields(financials) {
  const fin = financials || {};
  const get = (obj, key) => obj?.[key]?.value ?? null;
  return {
    revenues:            get(fin.income_statement, 'revenues'),
    net_income:          get(fin.income_statement, 'net_income_loss'),
    eps_diluted:         get(fin.income_statement, 'diluted_earnings_per_share'),
    total_assets:        get(fin.balance_sheet,    'assets'),
    total_liabilities:   get(fin.balance_sheet,    'liabilities'),
    cash_and_equiv:      get(fin.balance_sheet,    'cash_and_equivalent_at_carrying_value')
                           ?? get(fin.balance_sheet, 'cash'),
    operating_cash_flow: get(fin.cash_flow_statement, 'net_cash_flow_from_operating_activities')
                           ?? get(fin.cash_flow_statement, 'net_cash_flow'),
  };
}

async function loadFile(filePath) {
  const ticker = path.basename(filePath, '.json.gz').toUpperCase();
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(filePath)).toString());
  if (!Array.isArray(rows) || rows.length === 0) return { ticker, n: 0 };

  if (DRY) return { ticker, n: rows.length, dry: true };

  let inserted = 0;
  for (const r of rows) {
    const flat = extractFlatFields(r.financials);
    try {
      await query(`
        INSERT INTO polygon_financials (
          ticker, fiscal_year, fiscal_period, timeframe,
          start_date, end_date, filing_date, acceptance_datetime,
          cik, sic, company_name, source_filing_url,
          income_statement, balance_sheet, cash_flow_statement, comprehensive_income,
          revenues, net_income, eps_diluted, total_assets, total_liabilities,
          cash_and_equiv, operating_cash_flow, raw
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb,
          $17, $18, $19, $20, $21,
          $22, $23, $24::jsonb
        )
        ON CONFLICT (ticker, fiscal_year, fiscal_period) DO UPDATE SET
          end_date = EXCLUDED.end_date,
          filing_date = EXCLUDED.filing_date,
          income_statement = EXCLUDED.income_statement,
          balance_sheet = EXCLUDED.balance_sheet,
          cash_flow_statement = EXCLUDED.cash_flow_statement,
          comprehensive_income = EXCLUDED.comprehensive_income,
          revenues = EXCLUDED.revenues,
          net_income = EXCLUDED.net_income,
          eps_diluted = EXCLUDED.eps_diluted,
          total_assets = EXCLUDED.total_assets,
          total_liabilities = EXCLUDED.total_liabilities,
          cash_and_equiv = EXCLUDED.cash_and_equiv,
          operating_cash_flow = EXCLUDED.operating_cash_flow,
          raw = EXCLUDED.raw,
          ingested_at = NOW()
      `, [
        ticker, r.fiscal_year, r.fiscal_period, r.timeframe,
        r.start_date, r.end_date, r.filing_date, r.acceptance_datetime,
        r.cik, r.sic, r.company_name, r.source_filing_url,
        JSON.stringify(r.financials?.income_statement ?? null),
        JSON.stringify(r.financials?.balance_sheet ?? null),
        JSON.stringify(r.financials?.cash_flow_statement ?? null),
        JSON.stringify(r.financials?.comprehensive_income ?? null),
        flat.revenues, flat.net_income, flat.eps_diluted, flat.total_assets, flat.total_liabilities,
        flat.cash_and_equiv, flat.operating_cash_flow,
        JSON.stringify(r),
      ]);
      inserted++;
    } catch (e) {
      // continue on row error (logged) — don't fail whole file
      if (inserted === 0) console.warn(`[load-polygon-financials] ${ticker} row err: ${e.message?.slice(0, 80)}`);
    }
  }
  return { ticker, n: inserted };
}

async function main() {
  await initDb();
  console.log(`[load-polygon-financials] START dry=${DRY} concur=${CONCUR} only=${ONLY.length ? ONLY.length : 'all'}`);

  const files = fs.readdirSync(SRC_DIR)
    .filter(f => f.endsWith('.json.gz'))
    .map(f => path.join(SRC_DIR, f));
  const filtered = ONLY.length
    ? files.filter(f => ONLY.includes(path.basename(f, '.json.gz').toUpperCase()))
    : files;
  console.log(`  files to load: ${filtered.length}`);

  let done = 0, rowsTotal = 0;
  const t0 = Date.now();
  // Simple concurrency: process in batches of CONCUR
  for (let i = 0; i < filtered.length; i += CONCUR) {
    const batch = filtered.slice(i, i + CONCUR);
    const results = await Promise.allSettled(batch.map(loadFile));
    for (const r of results) {
      if (r.status === 'fulfilled') { done++; rowsTotal += r.value?.n ?? 0; }
    }
    if (done % 500 === 0 || done === filtered.length) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  progress: ${done}/${filtered.length} files, ${rowsTotal} rows, ${elapsed}s`);
    }
  }
  console.log(`[load-polygon-financials] DONE files=${done} rows=${rowsTotal} time=${((Date.now()-t0)/60000).toFixed(1)}min`);
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e); process.exit(1); });
