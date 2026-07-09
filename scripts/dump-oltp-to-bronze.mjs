#!/usr/bin/env node
/**
 * T1 · BRONZE — dump OLTP → date-partitioned Parquet.  READ-ONLY on Postgres.
 *
 * Introspection-driven (no hardcoded table list): discovers every public table from
 * information_schema, auto-detects each table's partition (event-date) column, and writes
 *   <BRONZE_ROOT>/<table>/dt=YYYY-MM-DD/data_*.parquet   (Hive layout)
 * via DuckDB's Postgres scanner. Maintains a _catalog.json and reports schema drift.
 * See docs/ARCHITECTURE.md §3 + §12.
 *
 * Modes:
 *   MODE=backfill   dump ALL history (clean rebuild per table)          [default]
 *   MODE=daily      dump only one date (overwrites just that partition)
 *
 * Env / flags:
 *   BRONZE_ROOT=/Volumes/Archive/bronze/oltp   (override for testing)
 *   DATE=YYYY-MM-DD     (daily mode; default = yesterday ET)
 *   ONLY=t1,t2          EXCLUDE=t3,t4          DRY=1
 *
 * Requires: duckdb CLI on PATH, DATABASE_URL in .env.
 */
import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DBURL = process.env.DATABASE_URL;
if (!DBURL) { console.error('Missing DATABASE_URL'); process.exit(1); }

const BRONZE_ROOT = process.env.BRONZE_ROOT || '/Volumes/Archive/bronze/oltp';
const MODE   = (process.env.MODE || 'backfill').toLowerCase();
const ONLY   = (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const EXCL   = (process.env.EXCLUDE || '').split(',').map(s => s.trim()).filter(Boolean);
const DRY    = process.env.DRY === '1';
const TZ     = 'America/New_York';                 // business-day partitioning

// yesterday ET (daily mode default)
function yesterdayET() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  now.setDate(now.getDate() - 1);
  return now.toISOString().slice(0, 10);
}
const DATE = process.env.DATE || yesterdayET();

// priority for auto-picking the partition column (first present wins)
const PART_PRIORITY = [
  'closed_at','opened_at','scored_at','scanned_at','captured_at','alerted_at','filed_at',
  'recorded_at','traded_at','published_at','ingested_at','created_at',
  'observation_date','price_date','trade_date','as_of_date','target_date','event_date','date',
];

// Tables whose EVENT-date column (filed_at/traded_at) can lag ingestion by days-to-weeks —
// Congress files STOCK-Act disclosures 30-45d after the trade, insiders file Form-4 a few days
// late. MODE=daily filters `WHERE partCol = yesterday`, so a row that ARRIVES today with an
// event date weeks ago lands in a partition whose daily run already happened → permanently lost
// (2026-07-08 audit: uw_congressional_trades lake was missing 190 back-dated rows). Partition
// these by `ingested_at` (arrival) instead, so daily capture is complete. Scoped to small signal
// tables only — NOT market tables (which must stay event-date partitioned for backfill).
const ARRIVAL_PARTITION = new Set([
  'uw_congressional_trades', 'uw_insider_trades',
]);

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sh = (sql) => execFileSync('duckdb', ['-c', sql], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
const shJson = (sql) => { try { return JSON.parse(execFileSync('duckdb', ['-json','-c', sql], { encoding:'utf8' }) || '[]'); } catch { return []; } };
const qIdent = (s) => '"' + String(s).replace(/"/g, '""') + '"';

async function main() {
  log(`Bronze dump — MODE=${MODE}${MODE==='daily'?` DATE=${DATE}`:''} ROOT=${BRONZE_ROOT}${DRY?' (DRY)':''}`);
  const client = new pg.Client({ connectionString: DBURL });
  await client.connect();
  await client.query(`SET TimeZone='${TZ}'`);   // match DuckDB's session TZ → identical ::date

  // 1. discover tables
  const { rows: tbls } = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
  let tables = tbls.map(r => r.table_name);
  if (ONLY.length) tables = tables.filter(t => ONLY.includes(t));
  if (EXCL.length) tables = tables.filter(t => !EXCL.includes(t));
  log(`tables in scope: ${tables.length}`);

  // 2. load catalog
  const catPath = path.join(BRONZE_ROOT, '_catalog.json');
  let catalog = { tables: {} };
  try { catalog = JSON.parse(fs.readFileSync(catPath, 'utf8')); } catch {}
  const drift = [];

  fs.mkdirSync(BRONZE_ROOT, { recursive: true });
  const summary = [];

  for (const t of tables) {
    // columns + types
    const { rows: cols } = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t]);
    const colmap = Object.fromEntries(cols.map(c => [c.column_name, c.data_type]));
    const colnames = cols.map(c => c.column_name);

    // 3. drift detection vs catalog
    const prev = catalog.tables[t];
    if (!prev) drift.push(`🆕 new table: ${t}`);
    else {
      for (const c of colnames) if (!(c in prev.columns)) drift.push(`➕ ${t}.${c} (new column)`);
      for (const c of Object.keys(prev.columns)) if (!(c in colmap)) drift.push(`➖ ${t}.${c} (dropped)`);
      for (const c of colnames) if (prev.columns[c] && prev.columns[c] !== colmap[c])
        drift.push(`⚠️ ${t}.${c} TYPE ${prev.columns[c]}→${colmap[c]} (manual Silver cast needed)`);
    }

    // pick partition column — arrival-partition the lagging-event tables (see ARRIVAL_PARTITION)
    const partCol = (ARRIVAL_PARTITION.has(t) && 'ingested_at' in colmap)
      ? 'ingested_at'
      : (PART_PRIORITY.find(c => c in colmap) || null);
    const isDateType = partCol && colmap[partCol] === 'date';

    // partition expression (business-day in ET for timestamps)
    let dtExpr, where = '', destLeaf, snapshot = false;
    if (partCol) {
      dtExpr = isDateType ? `CAST(${qIdent(partCol)} AS DATE)`
                          : `CAST(${qIdent(partCol)} AS DATE)`; // TZ set on session below
      if (MODE === 'daily') where = `WHERE ${dtExpr} = DATE '${DATE}'`;
    } else {
      snapshot = true; // no event date → single snapshot partition, overwritten each run
    }

    // source row count (for validation)
    const cntSql = (snapshot || MODE !== 'daily')
      ? `SELECT count(*) n FROM ${qIdent(t)}`
      : `SELECT count(*) n FROM ${qIdent(t)} WHERE CAST(${qIdent(partCol)} AS DATE) = DATE '${DATE}'`;
    const srcRows = Number((await client.query(cntSql)).rows[0].n);

    const tableDir = path.join(BRONZE_ROOT, t);
    if (DRY) {
      summary.push({ t, partCol: partCol || '(snapshot)', srcRows, status: 'DRY' });
      catalog.tables[t] = { partition_col: partCol, columns: colmap, row_count: srcRows };
      continue;
    }

    // 4. write parquet via duckdb postgres scanner
    // 0-row table → write a schema-only parquet so every table has a provable T1 presence
    if (srcRows === 0) {
      const dir = path.join(tableDir, 'dt=__empty__');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'data_0.parquet');
      try {
        sh(`INSTALL postgres; LOAD postgres;
            ATTACH '${DBURL}' AS pg (TYPE POSTGRES, READ_ONLY);
            COPY (SELECT * FROM pg.public.${qIdent(t)} LIMIT 0) TO '${file}' (FORMAT PARQUET);`);
        summary.push({ t, partCol: partCol || '(empty)', srcRows: 0, parquetRows: 0, status: 'GREEN' });
        catalog.tables[t] = { partition_col: partCol, columns: colmap, row_count: 0, last_loaded: 'empty', last_run: new Date().toISOString() };
      } catch (e) {
        summary.push({ t, partCol: partCol || '(empty)', srcRows: 0, parquetRows: '-', status: 'ERROR: ' + String(e.stderr||e.message).slice(0,60) });
      }
      continue;
    }
    let copySql, destForCheck;
    if (snapshot) {
      const dir = path.join(tableDir, 'dt=__snapshot__');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'data_0.parquet');
      copySql = `COPY (SELECT * FROM pg.public.${qIdent(t)}) TO '${file}' (FORMAT PARQUET);`;
      destForCheck = `${dir}/*.parquet`;
    } else if (MODE === 'daily') {
      const dir = path.join(tableDir, `dt=${DATE}`);
      fs.rmSync(dir, { recursive: true, force: true });        // idempotent: replace just this partition
      fs.mkdirSync(tableDir, { recursive: true });
      copySql = `COPY (SELECT *, ${dtExpr} AS dt FROM pg.public.${qIdent(t)} ${where}) `
              + `TO '${tableDir}' (FORMAT PARQUET, PARTITION_BY (dt), OVERWRITE_OR_IGNORE);`;
      destForCheck = `${tableDir}/dt=${DATE}/**/*.parquet`;
    } else { // backfill: clean rebuild of the table dir
      fs.rmSync(tableDir, { recursive: true, force: true });
      fs.mkdirSync(tableDir, { recursive: true });
      copySql = `COPY (SELECT *, ${dtExpr} AS dt FROM pg.public.${qIdent(t)}) `
              + `TO '${tableDir}' (FORMAT PARQUET, PARTITION_BY (dt), OVERWRITE_OR_IGNORE);`;
      destForCheck = `${tableDir}/**/*.parquet`;
    }

    try {
      sh(`INSTALL postgres; LOAD postgres; SET TimeZone='${TZ}';
          ATTACH '${DBURL}' AS pg (TYPE POSTGRES, READ_ONLY);
          ${copySql}`);
    } catch (e) {
      summary.push({ t, partCol: partCol || '(snapshot)', srcRows, parquetRows: '-', status: 'ERROR: ' + String(e.stderr||e.message).slice(0,80) });
      continue;
    }

    // 5. validate: parquet rows == source rows
    const pqRows = Number(shJson(`SELECT count(*) n FROM read_parquet('${destForCheck}')`)[0]?.n ?? 0);
    const status = pqRows === srcRows ? 'GREEN' : `RED (pg=${srcRows} pq=${pqRows})`;
    summary.push({ t, partCol: partCol || '(snapshot)', srcRows, parquetRows: pqRows, status });

    catalog.tables[t] = {
      partition_col: partCol, columns: colmap, row_count: srcRows,
      last_loaded: MODE === 'daily' ? DATE : 'full', last_run: new Date().toISOString(),
    };
  }

  // 6. persist catalog
  catalog.generated_at = new Date().toISOString();
  if (!DRY) fs.writeFileSync(catPath, JSON.stringify(catalog, null, 2));

  await client.end();

  // 7. report
  console.log('\n=== SCHEMA DRIFT ===');
  console.log(drift.length ? drift.join('\n') : '  (none)');
  console.log('\n=== DUMP SUMMARY ===');
  for (const s of summary)
    console.log(`  ${s.status.padEnd(10)} ${s.t.padEnd(28)} part=${String(s.partCol).padEnd(14)} rows=${s.srcRows}${s.parquetRows!==undefined?`/${s.parquetRows}`:''}`);
  const red = summary.filter(s => String(s.status).startsWith('RED') || String(s.status).startsWith('ERROR'));
  console.log(`\nGREEN=${summary.filter(s=>s.status==='GREEN').length}  RED/ERROR=${red.length}  catalog=${catPath}`);
  process.exit(red.length ? 2 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
