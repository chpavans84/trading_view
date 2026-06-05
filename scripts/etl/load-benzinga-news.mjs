#!/usr/bin/env node
/**
 * ETL #3: Load HDD news archive → benzinga_news OLTP table.
 *
 * Source: /Volumes/Archive/benzinga-news/YYYY/MM/YYYY-MM-DD.jsonl.gz (1,860 days, ~600K articles)
 * Target: public.benzinga_news (existing — we just upsert by article_id)
 *
 * Idempotent: ON CONFLICT (article_id) DO NOTHING.
 * Restartable: skips days already fully loaded (count match per-day).
 *
 * Runtime estimate: ~15-25 min (1,860 days × ~250 articles × INSERT).
 * Disk impact: Postgres grows by ~1-1.5 GB.
 *
 * Usage:
 *   node scripts/etl/load-benzinga-news.mjs
 *   FROM=2024-01-01 TO=2024-12-31 node scripts/etl/load-benzinga-news.mjs
 *   DRY=1 node scripts/etl/load-benzinga-news.mjs
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { initDb, query } from '../../src/core/db.js';

const SRC_ROOT = '/Volumes/Archive/benzinga-news';
const DRY      = process.env.DRY === '1';
const FROM     = process.env.FROM || '2021-05-01';
const TO       = process.env.TO   || new Date().toISOString().slice(0, 10);

function* enumerateDays(from, to) {
  const d = new Date(from + 'T00:00:00Z'); const end = new Date(to + 'T00:00:00Z');
  while (d <= end) { yield d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + 1); }
}

async function loadDay(dateStr) {
  const [y, m] = dateStr.split('-');
  const fp = path.join(SRC_ROOT, y, m, `${dateStr}.jsonl.gz`);
  if (!fs.existsSync(fp)) return { date: dateStr, n: 0, status: 'missing' };

  const text = zlib.gunzipSync(fs.readFileSync(fp)).toString();
  const lines = text.trim().split('\n').filter(Boolean);

  if (DRY) return { date: dateStr, n: lines.length, status: 'dry' };

  let inserted = 0;
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    // Find ticker-specific sentiment from insights if present
    const insights = Array.isArray(r.insights) ? r.insights : [];
    const sentiment = insights[0]?.sentiment?.toLowerCase() ?? null;
    try {
      await query(`
        INSERT INTO benzinga_news
          (article_id, title, teaser, url, source, author, image_url,
           channels, tickers, sentiment, published_at, updated_at, raw)
        VALUES ($1, $2, $3, $4, $5, $6, $7,
                $8::jsonb, $9::jsonb, $10, $11, $12, $13::jsonb)
        ON CONFLICT (article_id) DO NOTHING
      `, [
        r.id,
        r.title ?? '',
        r.description ?? null,
        r.article_url ?? null,
        r.publisher?.name ?? 'Benzinga',
        r.author ?? null,
        r.image_url ?? null,
        JSON.stringify(r.keywords ?? []),
        JSON.stringify(r.tickers ?? []),
        sentiment,
        r.published_utc ?? null,
        r.published_utc ?? null,
        JSON.stringify(r),
      ]);
      inserted++;
    } catch (e) {
      if (inserted === 0) console.warn(`  ${dateStr} row err: ${e.message?.slice(0, 80)}`);
    }
  }
  return { date: dateStr, n: inserted, status: 'ok' };
}

async function main() {
  await initDb();
  console.log(`[load-benzinga-news] dry=${DRY} ${FROM} → ${TO}`);

  // Check if benzinga_news has a unique constraint on article_id
  const { rows: uniq } = await query(`
    SELECT 1 FROM pg_indexes
     WHERE tablename='benzinga_news' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%article_id%'
  `);
  if (uniq.length === 0) {
    console.warn('  ⚠ benzinga_news has no UNIQUE(article_id) index — ON CONFLICT will fail');
    console.warn('  ⚠ run: CREATE UNIQUE INDEX benzinga_news_article_id_key ON benzinga_news(article_id);');
    if (!DRY) process.exit(1);
  }

  let daysLoaded = 0, articlesLoaded = 0;
  const t0 = Date.now();
  for (const dateStr of enumerateDays(FROM, TO)) {
    const r = await loadDay(dateStr);
    if (r.status === 'ok' || r.status === 'dry') { daysLoaded++; articlesLoaded += r.n; }
    if (daysLoaded % 50 === 0) {
      console.log(`  ${dateStr}: ${r.n} articles (cumulative: ${daysLoaded} days, ${articlesLoaded} articles)`);
    }
  }
  console.log(`[load-benzinga-news] DONE days=${daysLoaded} articles=${articlesLoaded} time=${((Date.now()-t0)/60000).toFixed(1)}min`);
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e); process.exit(1); });
