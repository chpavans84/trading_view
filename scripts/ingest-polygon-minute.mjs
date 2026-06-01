#!/usr/bin/env node
/**
 * scripts/ingest-polygon-minute.mjs
 *
 * Ingest already-downloaded Polygon minute-aggregate flat files into
 * `intraday_bars_1m`. Designed for the disk dump at
 * ~/polygon-data/us_stocks_sip/minute_aggs_v1/YYYY/MM/YYYY-MM-DD.csv.gz
 *
 * Uses PostgreSQL COPY for the fastest possible bulk load (~10× faster than
 * INSERT statements). Idempotent via temp-table + ON CONFLICT pattern.
 *
 * Usage:
 *   node scripts/ingest-polygon-minute.mjs                       # default: last 365d
 *   node scripts/ingest-polygon-minute.mjs --days 30
 *   node scripts/ingest-polygon-minute.mjs --from 2026-04-01 --to 2026-04-30
 *   node scripts/ingest-polygon-minute.mjs --from 2020-01-01 --to 2021-12-31  # COVID era
 *   node scripts/ingest-polygon-minute.mjs --resume               # skip days already done
 *
 * Performance: ~1.8M rows per file → COPY takes ~25-40 seconds per day on
 * average hardware. 365 days → ~3-4 hours.
 *
 * Polygon CSV format:
 *   ticker, volume, open, close, high, low, window_start (ns), transactions
 *
 * Note: window_start is nanoseconds since epoch — we divide by 1e9 to seconds.
 */

import '../src/core/env-loader.js';
import { initDb, query, getClient } from '../src/core/db.js';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg  = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const hasFlag = (n) => args.includes(`--${n}`);

const DAYS_BACK = parseInt(getArg('days', '365'), 10);
const FROM      = getArg('from');
const TO        = getArg('to');
const RESUME    = hasFlag('resume');
const DATA_ROOT = getArg('root', join(homedir(), 'polygon-data/us_stocks_sip/minute_aggs_v1'));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function dateRange(from, to) {
  const out = [];
  const cur = new Date(from);
  const end = new Date(to);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function fileForDate(dateStr) {
  // 2026-05-22 → ~/polygon-data/us_stocks_sip/minute_aggs_v1/2026/05/2026-05-22.csv.gz
  const [y, m] = dateStr.split('-');
  return join(DATA_ROOT, y, m, `${dateStr}.csv.gz`);
}

async function alreadyIngested(dateStr) {
  // Cheap check: any row in intraday_bars_1m for this date?
  const { rows } = await query(
    `SELECT 1 FROM intraday_bars_1m WHERE ts_event::date = $1::date LIMIT 1`,
    [dateStr]
  );
  return rows.length > 0;
}

// ─── Ingest one day file via COPY (idempotent through staging table) ─────────
async function ingestDay(dateStr) {
  const file = fileForDate(dateStr);
  if (!existsSync(file)) {
    console.log(`[ingest] skip ${dateStr} — file not found (${file})`);
    return { day: dateStr, rows: 0, skipped: 'missing_file' };
  }

  const sz = statSync(file).size;
  const tStart = Date.now();

  // Acquire one client for the whole day's load (COPY + temp table need same conn)
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Staging table: same shape as target minus pkey + indexes, dropped on commit
    await client.query(`
      CREATE TEMP TABLE _stage_intraday (
        symbol_csv     text,
        volume_csv     text,
        open_csv       text,
        close_csv      text,
        high_csv       text,
        low_csv        text,
        ts_ns_csv      text,
        transactions_csv text
      ) ON COMMIT DROP
    `);

    // Stream: file → gunzip → COPY into stage
    const copyStream = client.query(copyFrom(`
      COPY _stage_intraday (symbol_csv, volume_csv, open_csv, close_csv,
                            high_csv, low_csv, ts_ns_csv, transactions_csv)
      FROM STDIN WITH (FORMAT csv, HEADER true)
    `));

    await pipeline(
      createReadStream(file),
      createGunzip(),
      copyStream
    );

    // Insert from stage → real table, with type conversions + dedup
    // Polygon timestamps are nanoseconds since epoch — convert to timestamptz
    const insertRes = await client.query(`
      INSERT INTO intraday_bars_1m
        (symbol, ts_event, open, high, low, close, volume, transactions, source)
      SELECT
        UPPER(symbol_csv),
        TO_TIMESTAMP(ts_ns_csv::numeric / 1e9)            AT TIME ZONE 'UTC',
        NULLIF(open_csv, '')::numeric(14,4),
        NULLIF(high_csv, '')::numeric(14,4),
        NULLIF(low_csv, '')::numeric(14,4),
        NULLIF(close_csv, '')::numeric(14,4),
        NULLIF(volume_csv, '')::numeric::bigint,
        NULLIF(transactions_csv, '')::integer,
        'polygon'
      FROM _stage_intraday
      WHERE symbol_csv IS NOT NULL AND ts_ns_csv IS NOT NULL
      ON CONFLICT (symbol, ts_event) DO NOTHING
    `);

    await client.query('COMMIT');

    const ms = Date.now() - tStart;
    return {
      day:      dateStr,
      rows:     insertRes.rowCount ?? 0,
      ms,
      file_mb:  (sz / 1024 / 1024).toFixed(1),
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  await initDb();

  let from, to;
  if (FROM && TO) {
    from = FROM;
    to   = TO;
  } else {
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - DAYS_BACK);
    from = start.toISOString().slice(0, 10);
    to   = today.toISOString().slice(0, 10);
  }

  const allDates = dateRange(from, to);
  console.log(`[ingest] window: ${from} → ${to} (${allDates.length} calendar days, will skip weekends/missing)`);

  // Filter to only dates that have files (skip weekends, holidays, etc.)
  const candidateDates = allDates.filter(d => existsSync(fileForDate(d)));
  console.log(`[ingest] ${candidateDates.length} candidate trading days have files on disk`);

  let alreadyDone = new Set();
  if (RESUME) {
    const { rows } = await query(`
      SELECT DISTINCT ts_event::date::text AS d
        FROM intraday_bars_1m
       WHERE ts_event::date BETWEEN $1::date AND $2::date
    `, [from, to]);
    alreadyDone = new Set(rows.map(r => r.d));
    console.log(`[ingest] resume — ${alreadyDone.size} days already ingested, will skip`);
  }

  const todo = candidateDates.filter(d => !alreadyDone.has(d));
  if (!todo.length) {
    console.log('[ingest] nothing to do');
    process.exit(0);
  }
  console.log(`[ingest] ${todo.length} days to ingest`);

  // Process newest-first so we get fresh data into Postgres ASAP
  todo.sort().reverse();

  const tStart = Date.now();
  let totalRows = 0;
  let totalDays = 0;
  let failed   = 0;

  for (const d of todo) {
    try {
      const r = await ingestDay(d);
      totalRows += r.rows;
      totalDays += 1;
      const sec = ((r.ms || 0) / 1000).toFixed(1);
      const elapsedMin = ((Date.now() - tStart) / 60_000).toFixed(1);
      const progress = `${totalDays}/${todo.length}`;
      console.log(`[ingest] ${d}  ${String(r.rows).padStart(8)} rows  ${sec}s  (${r.file_mb || '-'} MB)  [${progress}, ${elapsedMin}m elapsed]`);
    } catch (e) {
      failed++;
      console.error(`[ingest] FAIL ${d}: ${e.message}`);
    }
  }

  const totalMin = ((Date.now() - tStart) / 60_000).toFixed(1);
  console.log(`\n[ingest] DONE — ${totalDays} days, ${totalRows.toLocaleString()} rows, ${failed} failed, ${totalMin} min`);
  process.exit(0);
}

main().catch(e => {
  console.error('[ingest] FATAL:', e);
  process.exit(1);
});
