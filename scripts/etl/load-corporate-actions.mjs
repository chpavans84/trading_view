#!/usr/bin/env node
/**
 * ETL #2: Load Polygon REST splits + dividends → corporate_actions OLTP table.
 *
 * Sources:
 *   /Volumes/Archive/polygon-rest/corporate_actions/splits/{TICKER}.json.gz     (12,673)
 *   /Volumes/Archive/polygon-rest/corporate_actions/dividends/{TICKER}.json.gz  (12,673)
 *
 * Target: public.corporate_actions (created by migration 1780780000000)
 *
 * Idempotent: ON CONFLICT (polygon_id) DO NOTHING — Polygon's ID is stable.
 * Runtime estimate: ~5-10 min total (small per-file payloads, 8 concurrent).
 * Disk impact: ~100 MB.
 *
 * Usage:
 *   node scripts/etl/load-corporate-actions.mjs
 *   ONLY=AAPL,MSFT  node scripts/etl/load-corporate-actions.mjs
 *   DRY=1           node scripts/etl/load-corporate-actions.mjs
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { initDb, query } from '../../src/core/db.js';

const SPLITS_DIR    = '/Volumes/Archive/polygon-rest/corporate_actions/splits';
const DIVIDENDS_DIR = '/Volumes/Archive/polygon-rest/corporate_actions/dividends';
const DRY     = process.env.DRY === '1';
const ONLY    = (process.env.ONLY || '').split(',').filter(Boolean).map(s => s.toUpperCase());
const CONCUR  = Number(process.env.CONCURRENCY) || 8;

async function loadSplitsFile(filePath) {
  const ticker = path.basename(filePath, '.json.gz').toUpperCase();
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(filePath)).toString());
  if (!Array.isArray(rows) || !rows.length) return { ticker, n: 0 };
  if (DRY) return { ticker, n: rows.length, dry: true };

  let inserted = 0;
  for (const r of rows) {
    try {
      await query(`
        INSERT INTO corporate_actions
          (ticker, action_type, execution_date, split_from, split_to, polygon_id, raw)
        VALUES ($1, 'split', $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (polygon_id) DO NOTHING
      `, [ticker, r.execution_date, r.split_from, r.split_to, r.id, JSON.stringify(r)]);
      inserted++;
    } catch (e) {
      if (inserted === 0) console.warn(`[splits] ${ticker} row err: ${e.message?.slice(0, 80)}`);
    }
  }
  return { ticker, n: inserted };
}

async function loadDividendsFile(filePath) {
  const ticker = path.basename(filePath, '.json.gz').toUpperCase();
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(filePath)).toString());
  if (!Array.isArray(rows) || !rows.length) return { ticker, n: 0 };
  if (DRY) return { ticker, n: rows.length, dry: true };

  let inserted = 0;
  for (const r of rows) {
    try {
      await query(`
        INSERT INTO corporate_actions
          (ticker, action_type, execution_date, declaration_date, record_date, pay_date,
           cash_amount, currency, dividend_type, frequency, polygon_id, raw)
        VALUES ($1, 'dividend', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        ON CONFLICT (polygon_id) DO NOTHING
      `, [
        ticker, r.ex_dividend_date, r.declaration_date, r.record_date, r.pay_date,
        r.cash_amount, r.currency, r.dividend_type, r.frequency, r.id, JSON.stringify(r),
      ]);
      inserted++;
    } catch (e) {
      if (inserted === 0) console.warn(`[dividends] ${ticker} row err: ${e.message?.slice(0, 80)}`);
    }
  }
  return { ticker, n: inserted };
}

async function runPhase(label, dir, loaderFn) {
  console.log(`\n[${label}] start`);
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json.gz'))
    .map(f => path.join(dir, f));
  const filtered = ONLY.length
    ? files.filter(f => ONLY.includes(path.basename(f, '.json.gz').toUpperCase()))
    : files;
  console.log(`  files: ${filtered.length}`);

  let done = 0, rowsTotal = 0;
  const t0 = Date.now();
  for (let i = 0; i < filtered.length; i += CONCUR) {
    const batch = filtered.slice(i, i + CONCUR);
    const results = await Promise.allSettled(batch.map(loaderFn));
    for (const r of results) {
      if (r.status === 'fulfilled') { done++; rowsTotal += r.value?.n ?? 0; }
    }
    if (done % 1000 === 0 || done === filtered.length) {
      console.log(`  ${label}: ${done}/${filtered.length} files, ${rowsTotal} rows, ${((Date.now()-t0)/1000).toFixed(0)}s`);
    }
  }
  console.log(`[${label}] DONE files=${done} rows=${rowsTotal}`);
}

async function main() {
  await initDb();
  console.log(`[corporate-actions] dry=${DRY} concur=${CONCUR} only=${ONLY.length || 'all'}`);
  await runPhase('splits',    SPLITS_DIR,    loadSplitsFile);
  await runPhase('dividends', DIVIDENDS_DIR, loadDividendsFile);
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e); process.exit(1); });
