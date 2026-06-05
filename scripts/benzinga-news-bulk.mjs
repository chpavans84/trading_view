#!/usr/bin/env node
/**
 * Benzinga / Polygon News v2 bulk backfill to HDD.
 *
 * Pulls all available news (~3 years history, 2023-01-01 → now) and writes
 * per-day JSONL.gz files to /Volumes/Archive/benzinga-news/.
 *
 * Why:
 *   - Polygon Newsfeed v2 (via api.massive.com) is plan-gated; if the
 *     subscription ever lapses we lose access.
 *   - News + sentiment is a 22% weight in the bot's composite score.
 *   - Historical news is needed for ML retraining / new feature R&D.
 *
 * Schema (one article per line):
 *   { id, published_utc, title, description, author, publisher, tickers,
 *     insights, keywords, image_url, article_url }
 *
 * Layout:
 *   /Volumes/Archive/benzinga-news/
 *     2023/01/2023-01-01.jsonl.gz
 *     ...
 *     2026/06/2026-06-02.jsonl.gz
 *     manifests/news-backfill-{TIMESTAMP}.log
 *     manifests/days_completed.json
 *
 * Usage:
 *   node scripts/benzinga-news-bulk.mjs                     # full backfill
 *   FROM=2026-05-01 TO=2026-06-02 node scripts/benzinga-news-bulk.mjs
 *   RPS=5 node scripts/benzinga-news-bulk.mjs               # rate limit
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const KEY  = process.env.BENZINGA_API;
if (!KEY) { console.error('Missing BENZINGA_API'); process.exit(1); }
const BASE = 'https://api.massive.com';
const ROOT = '/Volumes/Archive/benzinga-news';
const RPS  = Number(process.env.RPS) || 5;
const FROM = process.env.FROM || '2023-01-01';
const TO   = process.env.TO   || new Date().toISOString().slice(0, 10);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

fs.mkdirSync(path.join(ROOT, 'manifests'), { recursive: true });
const LOG_FILE = path.join(ROOT, 'manifests', `news-backfill-${STAMP}.log`);
const CHECKPOINT = path.join(ROOT, 'manifests', 'days_completed.json');
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
};

// ─── Rate limiter ────────────────────────────────────────────────────────────
const _times = [];
async function rateLimit() {
  const now = Date.now();
  while (_times.length && _times[0] < now - 1000) _times.shift();
  if (_times.length >= RPS) {
    await new Promise(r => setTimeout(r, 1000 - (now - _times[0]) + 5));
  }
  _times.push(Date.now());
}

async function fetchJson(url, attempt = 1) {
  await rateLimit();
  try {
    const sep = url.includes('?') ? '&' : '?';
    const r = await fetch(`${url}${sep}apiKey=${KEY}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 429) {
      await new Promise(rs => setTimeout(rs, 1000 * attempt));
      if (attempt < 5) return fetchJson(url, attempt + 1);
      throw new Error('429 after 5 retries');
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
    return await r.json();
  } catch (e) {
    if (attempt < 3) {
      await new Promise(rs => setTimeout(rs, 500 * attempt));
      return fetchJson(url, attempt + 1);
    }
    throw e;
  }
}

async function writeJsonl(filepath, articles) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const tmp = filepath + '.tmp';
  const lines = articles.map(a => JSON.stringify(a)).join('\n') + '\n';
  await pipeline(Readable.from([lines]), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp));
  fs.renameSync(tmp, filepath);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function pullDay(date) {
  // Articles published in [date, date + 1 day)
  const next = addDays(date, 1);
  let url = `${BASE}/v2/reference/news?published_utc.gte=${date}&published_utc.lt=${next}&limit=1000`;
  const all = [];
  let pages = 0;
  while (url) {
    const data = await fetchJson(url);
    if (Array.isArray(data?.results)) all.push(...data.results);
    url = data?.next_url || null;
    pages++;
    if (pages > 50) { log(`  ${date}: hit 50-page cap with ${all.length} articles`); break; }
  }
  return all;
}

async function main() {
  log(`Benzinga news bulk — FROM=${FROM} TO=${TO} RPS=${RPS}`);
  const done = fs.existsSync(CHECKPOINT) ? new Set(JSON.parse(fs.readFileSync(CHECKPOINT))) : new Set();
  log(`  resume: ${done.size} days already complete`);

  let totalArticles = 0, daysPulled = 0;
  let date = FROM;
  while (date <= TO) {
    const [y, m, d] = date.split('-');
    const outFile = path.join(ROOT, y, m, `${date}.jsonl.gz`);
    if (done.has(date) && fs.existsSync(outFile)) { date = addDays(date, 1); continue; }
    try {
      const articles = await pullDay(date);
      if (articles.length) {
        await writeJsonl(outFile, articles);
        totalArticles += articles.length;
      }
      done.add(date);
      daysPulled++;
      if (daysPulled % 10 === 0) {
        fs.writeFileSync(CHECKPOINT, JSON.stringify([...done]));
        log(`  progress: ${daysPulled} days pulled, ${totalArticles} articles total. Last: ${date} = ${articles.length}`);
      } else if (articles.length > 100) {
        log(`  ${date}: ${articles.length} articles`);
      }
    } catch (e) {
      log(`  ✗ ${date}: ${e.message?.slice(0, 80)}`);
    }
    date = addDays(date, 1);
  }
  fs.writeFileSync(CHECKPOINT, JSON.stringify([...done]));
  log(`COMPLETE: ${daysPulled} days, ${totalArticles} articles`);
}

main().then(() => process.exit(0))
      .catch(e => { console.error('FATAL:', e); process.exit(1); });
