#!/usr/bin/env node
/**
 * scripts/polygon-s3-backfill.mjs
 *
 * One-shot bulk backfill of historic daily-aggregate bars from Polygon's
 * S3 flat files (files.polygon.io / flatfiles bucket, day_aggs_v1).
 *
 * Why this exists: after subscribing to Polygon Stocks Developer, we get S3
 * access to historic daily aggregates back to ~2003. That lets us build a
 * 10-year backtest_prices dataset without rate-limit-throttling Alpaca.
 *
 * Usage:
 *   npm run polygon:backfill                    # default: 2016-01-01 → today
 *   npm run polygon:backfill -- 2020-01-01      # start from 2020
 *   npm run polygon:backfill -- 2020-01-01 2024-12-31
 *
 * Behavior:
 *   - Lists all daily CSV files in the date range
 *   - Downloads N at a time (concurrency = 8)
 *   - Decompresses (csv.gz → csv)
 *   - Upserts into backtest_prices via batch INSERT...ON CONFLICT
 *   - Progress prints every 10 files
 *   - On error: logs and continues (partial backfill better than none)
 *
 * Estimated time: ~2,520 files × ~500 ms / 8-way concurrent = ~3 min download
 *                 + DB upsert overhead = ~10-15 min total for 10 years
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'node:zlib';
import { initDb, query } from '../src/core/db.js';

const ACCESS = process.env.POLYGON_S3_ACCESS_KEY;
const SECRET = process.env.POLYGON_S3_SECRET_KEY || process.env.POLYGON_S3_SECRETE_KEY;
const ENDPOINT = process.env.POLYGON_S3_ENDPOINT || 'https://files.polygon.io';
const BUCKET   = process.env.POLYGON_S3_BUCKET   || 'flatfiles';

if (!ACCESS || !SECRET) {
  console.error('Need POLYGON_S3_ACCESS_KEY + POLYGON_S3_SECRET_KEY in .env');
  process.exit(2);
}

const START_DATE = process.argv[2] || '2016-01-01';
const END_DATE   = process.argv[3] || new Date().toISOString().slice(0, 10);
const CONCURRENCY = 8;
const PROGRESS_EVERY = 10;

await initDb();

const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
  forcePathStyle: true,
});

// ─── List all CSV files in the date range ────────────────────────────────────
console.log(`\n📥 Polygon S3 bulk backfill\n   range: ${START_DATE} → ${END_DATE}\n   concurrency: ${CONCURRENCY}\n`);

async function listAllFiles() {
  // Each year is a separate prefix: us_stocks_sip/day_aggs_v1/YYYY/MM/
  const startYear = parseInt(START_DATE.slice(0, 4), 10);
  const endYear   = parseInt(END_DATE.slice(0, 4), 10);
  const files = [];

  for (let year = startYear; year <= endYear; year++) {
    let token;
    do {
      const r = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: `us_stocks_sip/day_aggs_v1/${year}/`,
        ContinuationToken: token,
      }));
      for (const o of (r.Contents || [])) {
        // Extract date from key like "us_stocks_sip/day_aggs_v1/2024/01/2024-01-02.csv.gz"
        const m = o.Key.match(/(\d{4}-\d{2}-\d{2})\.csv\.gz$/);
        if (!m) continue;
        const date = m[1];
        if (date >= START_DATE && date <= END_DATE) {
          files.push({ key: o.Key, date, size: o.Size });
        }
      }
      token = r.NextContinuationToken;
    } while (token);
  }
  files.sort((a, b) => a.date.localeCompare(b.date));
  return files;
}

const files = await listAllFiles();
console.log(`Found ${files.length} daily files. Starting download...\n`);
if (!files.length) {
  console.log('No files to download.');
  process.exit(0);
}

// ─── Download + upsert one file ──────────────────────────────────────────────
async function processFile(file) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: file.key }));
  const chunks = [];
  for await (const c of r.Body) chunks.push(c);
  const csv = gunzipSync(Buffer.concat(chunks)).toString();

  const lines = csv.split('\n');
  if (lines.length < 2) return { date: file.date, rows: 0 };

  // header: ticker,volume,open,close,high,low,window_start,transactions
  // Build a multi-VALUES insert for batch performance.
  // DEDUP within file: Polygon's CSV can have duplicate ticker rows (share
  // classes, OTC vs primary). Keep the LAST occurrence per ticker (highest
  // volume typically arrives last). Without this, Postgres ON CONFLICT errors:
  // "ON CONFLICT DO UPDATE command cannot affect row a second time".
  const byTicker = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 7) continue;
    const [ticker, volume, open, close, high, low] = cols;
    if (!ticker || !close) continue;
    byTicker.set(ticker.toUpperCase(), { ticker: ticker.toUpperCase(), volume: +volume, open: +open, close: +close, high: +high, low: +low });
  }
  const rows = [...byTicker.values()];
  if (!rows.length) return { date: file.date, rows: 0 };

  // Batch upsert — chunk into 1000-row batches to avoid Postgres parameter limits
  const BATCH = 1000;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let p = 1;
    for (const r of chunk) {
      values.push(`($${p},$${p+1}::date,$${p+2}::numeric,$${p+3}::numeric,$${p+4}::numeric,$${p+5}::numeric,$${p+6}::bigint,$${p+7}::numeric)`);
      params.push(r.ticker.toUpperCase(), file.date, r.open || null, r.high || null, r.low || null, r.close, r.volume || null, r.close);
      p += 8;
    }
    try {
      await query(`
        INSERT INTO backtest_prices (symbol, price_date, open, high, low, close, volume, adj_close)
        VALUES ${values.join(',')}
        ON CONFLICT (symbol, price_date) DO UPDATE SET
          open      = EXCLUDED.open,
          high      = EXCLUDED.high,
          low       = EXCLUDED.low,
          close     = EXCLUDED.close,
          volume    = EXCLUDED.volume,
          adj_close = EXCLUDED.adj_close
      `, params);
      upserted += chunk.length;
    } catch (e) {
      console.warn(`  [batch err ${file.date}]: ${e.message.slice(0, 100)}`);
    }
  }
  return { date: file.date, rows: upserted };
}

// ─── Concurrent runner ───────────────────────────────────────────────────────
const t0 = Date.now();
let done = 0;
let totalRows = 0;
let errors = 0;
const queue = [...files];

async function worker(id) {
  while (queue.length) {
    const file = queue.shift();
    if (!file) break;
    try {
      const r = await processFile(file);
      totalRows += r.rows;
    } catch (e) {
      errors++;
      console.warn(`✗ ${file.date}: ${e.message.slice(0, 100)}`);
    }
    done++;
    if (done % PROGRESS_EVERY === 0 || done === files.length) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = done / elapsed;
      const remaining = files.length - done;
      const eta = (remaining / rate).toFixed(0);
      console.log(`  [${done}/${files.length}] ${(done/files.length*100).toFixed(1)}%  rows=${totalRows.toLocaleString()}  errors=${errors}  ${rate.toFixed(1)}/s  ETA ${eta}s`);
    }
  }
}

const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i));
await Promise.all(workers);

const totalElapsed = (Date.now() - t0) / 1000;
console.log(`\n✅ DONE in ${totalElapsed.toFixed(1)}s`);
console.log(`   Files processed: ${done}/${files.length}`);
console.log(`   Total rows upserted: ${totalRows.toLocaleString()}`);
console.log(`   Errors: ${errors}`);

// Quick sanity check
const r = await query(`SELECT COUNT(*) AS n, MIN(price_date) AS earliest, MAX(price_date) AS latest FROM backtest_prices`);
const summary = r.rows[0];
console.log(`\n📊 backtest_prices table now has:`);
console.log(`   Total rows:  ${Number(summary.n).toLocaleString()}`);
console.log(`   Date range:  ${summary.earliest} → ${summary.latest}`);

process.exit(0);
