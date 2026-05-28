#!/usr/bin/env node
/**
 * scripts/polygon-bulk-download.mjs
 *
 * Generic bulk downloader for Polygon S3 flatfiles. Saves raw .csv.gz files
 * to disk so you have permanent copies — independent of Postgres.
 *
 * Designed to grab ALL accessible data before unsubscribing from Stocks
 * Developer, so you keep the historic data forever.
 *
 * Usage:
 *   node scripts/polygon-bulk-download.mjs \
 *     --prefix us_stocks_sip/minute_aggs_v1 \
 *     --start 2017-01-01 \
 *     --end   2026-05-28 \
 *     --out   ~/polygon-data/minute_aggs \
 *     --concurrency 8
 *
 * Or via npm shortcuts:
 *   npm run polygon:dl:minute        # minute aggs to ~/polygon-data/
 *   npm run polygon:dl:trades        # trades to /Volumes/TimeCapsule/...
 *
 * Resume-safe: skips files already on disk (so you can Ctrl+C + rerun).
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ─── Arg parsing ─────────────────────────────────────────────────────────────
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
function expandPath(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

const PREFIX = arg('prefix');   // e.g. us_stocks_sip/minute_aggs_v1
const START  = arg('start', '2017-01-01');
const END    = arg('end',   new Date().toISOString().slice(0, 10));
const OUT    = expandPath(arg('out', '~/polygon-data'));
const CONCURRENCY = parseInt(arg('concurrency', '8'), 10);
const SKIP_EXISTING = arg('overwrite') !== 'true';
const VERIFY_SIZE = true;  // re-download if local file size doesn't match S3

if (!PREFIX) {
  console.error('Required: --prefix <s3 path>');
  console.error('  e.g. --prefix us_stocks_sip/minute_aggs_v1');
  process.exit(2);
}

const ACCESS = process.env.POLYGON_S3_ACCESS_KEY;
const SECRET = process.env.POLYGON_S3_SECRET_KEY || process.env.POLYGON_S3_SECRETE_KEY;
const ENDPOINT = process.env.POLYGON_S3_ENDPOINT || 'https://files.polygon.io';
const BUCKET   = process.env.POLYGON_S3_BUCKET   || 'flatfiles';

if (!ACCESS || !SECRET) {
  console.error('Need POLYGON_S3_ACCESS_KEY + POLYGON_S3_SECRET_KEY in .env');
  process.exit(2);
}

const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
  forcePathStyle: true,
});

console.log(`\n📥 Polygon bulk download`);
console.log(`   Prefix:       ${PREFIX}`);
console.log(`   Date range:   ${START} → ${END}`);
console.log(`   Output dir:   ${OUT}`);
console.log(`   Concurrency:  ${CONCURRENCY}`);
console.log(`   Skip existing: ${SKIP_EXISTING}\n`);

mkdirSync(OUT, { recursive: true });

// ─── List files in date range ────────────────────────────────────────────────
async function listFiles() {
  const startYear = parseInt(START.slice(0, 4), 10);
  const endYear   = parseInt(END.slice(0, 4), 10);
  const files = [];
  for (let year = startYear; year <= endYear; year++) {
    let token;
    do {
      const r = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: `${PREFIX}/${year}/`,
        ContinuationToken: token,
      }));
      for (const o of (r.Contents || [])) {
        const m = o.Key.match(/(\d{4}-\d{2}-\d{2})\.csv\.gz$/);
        if (!m) continue;
        const date = m[1];
        if (date >= START && date <= END) {
          files.push({ key: o.Key, date, size: o.Size });
        }
      }
      token = r.NextContinuationToken;
    } while (token);
  }
  files.sort((a, b) => a.date.localeCompare(b.date));
  return files;
}

const files = await listFiles();
console.log(`Found ${files.length} files. Total size: ${(files.reduce((s, f) => s + f.size, 0) / 1e9).toFixed(2)} GB compressed\n`);
if (!files.length) { console.log('No files matched.'); process.exit(0); }

// ─── Download one file ───────────────────────────────────────────────────────
async function downloadFile(file) {
  // Mirror S3 path under OUT: e.g. OUT/us_stocks_sip/minute_aggs_v1/2025/01/2025-01-02.csv.gz
  const dest = join(OUT, file.key);
  const destDir = dirname(dest);

  // Skip if already downloaded and size matches
  if (SKIP_EXISTING && existsSync(dest)) {
    try {
      const st = statSync(dest);
      if (!VERIFY_SIZE || st.size === file.size) return { skipped: true, bytes: 0 };
    } catch {}
  }

  mkdirSync(destDir, { recursive: true });
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: file.key }));
  await pipeline(r.Body, createWriteStream(dest));
  return { downloaded: true, bytes: file.size };
}

// ─── Concurrent runner ───────────────────────────────────────────────────────
const t0 = Date.now();
const queue = [...files];
let done = 0, dl = 0, skipped = 0, errors = 0, totalBytes = 0;

async function worker() {
  while (queue.length) {
    const file = queue.shift();
    if (!file) break;
    try {
      const r = await downloadFile(file);
      if (r.downloaded) { dl++; totalBytes += r.bytes; }
      else if (r.skipped) skipped++;
    } catch (e) {
      errors++;
      console.warn(`  ✗ ${file.date} ${file.key}: ${e.message.slice(0, 100)}`);
    }
    done++;
    if (done % 10 === 0 || done === files.length) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = done / elapsed;
      const eta = ((files.length - done) / rate).toFixed(0);
      const mbps = (totalBytes / 1e6 / elapsed).toFixed(1);
      console.log(`  [${done}/${files.length}] ${(done/files.length*100).toFixed(1)}%  dl=${dl} skip=${skipped} err=${errors}  ${mbps} MB/s  ETA ${eta}s`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`\n✅ DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`   Downloaded: ${dl} files (${(totalBytes/1e9).toFixed(2)} GB)`);
console.log(`   Skipped (already on disk): ${skipped}`);
console.log(`   Errors: ${errors}`);
console.log(`   Output: ${OUT}/`);
process.exit(0);
