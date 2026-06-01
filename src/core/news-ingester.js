import cron from 'node-cron';
import { getBzNews, isBenzingaConfigured } from './benzinga.js';
import { query, isDbAvailable } from './db.js';
import { scanAndAlertNewsMovers } from './news-alert.js';

let _isRunning = false;
let _lastRunAt = null;
let _lastUpsertedCount = 0;

export async function ingestNews({ limit = 100 } = {}) {
  if (_isRunning) {
    console.log('[news-ingester] skip — previous run still in progress');
    return { skipped: true };
  }
  if (!isBenzingaConfigured()) {
    console.log('[news-ingester] skip — BENZINGA_API not set');
    return { skipped: true };
  }
  if (!isDbAvailable()) {
    console.log('[news-ingester] skip — DB unavailable');
    return { skipped: true };
  }
  _isRunning = true;
  try {
    const result = await getBzNews({ limit });
    const articles = result?.articles || [];
    let upserted = 0;
    for (const a of articles) {
      if (!a.id || !a.title || !a.published_at) continue;
      try {
        await query(
          `INSERT INTO benzinga_news
             (article_id, title, teaser, url, source, author, image_url,
              channels, tickers, sentiment, published_at, updated_at, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13::jsonb)
           ON CONFLICT (article_id) DO UPDATE
             SET title       = EXCLUDED.title,
                 teaser      = COALESCE(EXCLUDED.teaser,    benzinga_news.teaser),
                 url         = COALESCE(EXCLUDED.url,       benzinga_news.url),
                 source      = COALESCE(EXCLUDED.source,    benzinga_news.source),
                 author      = COALESCE(EXCLUDED.author,    benzinga_news.author),
                 image_url   = COALESCE(EXCLUDED.image_url, benzinga_news.image_url),
                 channels    = CASE
                                 WHEN EXCLUDED.channels IS NULL OR EXCLUDED.channels = '[]'::jsonb
                                   THEN benzinga_news.channels
                                 ELSE EXCLUDED.channels
                               END,
                 tickers     = CASE
                                 WHEN EXCLUDED.tickers IS NULL OR EXCLUDED.tickers = '[]'::jsonb
                                   THEN benzinga_news.tickers
                                 ELSE EXCLUDED.tickers
                               END,
                 sentiment   = COALESCE(EXCLUDED.sentiment, benzinga_news.sentiment),
                 updated_at  = COALESCE(EXCLUDED.updated_at, benzinga_news.updated_at),
                 raw         = EXCLUDED.raw,
                 ingested_at = NOW()`,
          [
            String(a.id),
            a.title,
            a.teaser ?? null,
            a.url ?? null,
            a.source ?? null,
            a.author ?? null,
            a.image_url ?? null,
            JSON.stringify(a.channels ?? []),
            JSON.stringify(a.tickers ?? []),
            a.sentiment ?? null,
            a.published_at,
            a.updated_at ?? null,
            JSON.stringify(a),
          ]
        );
        upserted++;
      } catch (rowErr) {
        console.error('[news-ingester] row error', a.id, rowErr.message);
      }
    }
    _lastRunAt = new Date();
    _lastUpsertedCount = upserted;
    console.log(`[news-ingester] upserted ${upserted}/${articles.length}`);

    // Scan for market-moving events and push to Telegram (fire-and-forget).
    if (upserted > 0) scanAndAlertNewsMovers().catch(() => {});

    return { fetched: articles.length, upserted };
  } catch (e) {
    console.error('[news-ingester] fatal:', e.message);
    return { error: e.message };
  } finally {
    _isRunning = false;
  }
}

export function getIngesterStatus() {
  return {
    configured: isBenzingaConfigured(),
    is_running: _isRunning,
    last_run_at: _lastRunAt,
    last_upserted: _lastUpsertedCount,
  };
}

export function startNewsIngesterCrons() {
  if (!isBenzingaConfigured()) {
    console.log('[news-ingester] crons disabled — BENZINGA_API not set');
    return;
  }
  const TZ = { timezone: 'America/New_York' };
  // Market hours 9:30am – 3:59pm ET: every minute Mon-Fri
  cron.schedule('30-59 9 * * 1-5', () => ingestNews(), TZ);
  cron.schedule('* 10-15 * * 1-5', () => ingestNews(), TZ);
  // Pre-market 4am – 9:25am ET: every 5 min Mon-Fri
  cron.schedule('*/5 4-8 * * 1-5', () => ingestNews(), TZ);
  cron.schedule('0,5,10,15,20,25 9 * * 1-5', () => ingestNews(), TZ);
  // After-hours 4pm – 7:59pm ET: every 5 min Mon-Fri
  cron.schedule('*/5 16-19 * * 1-5', () => ingestNews(), TZ);
  // Overnight 8pm – 3:59am ET Mon-Fri + all weekend: every 30 min
  cron.schedule('*/30 20-23,0-3 * * 1-5', () => ingestNews(), TZ);
  cron.schedule('*/30 * * * 0,6', () => ingestNews(), TZ);

  // Initial run on boot (5-second delay so DB schema is ready)
  setTimeout(() => ingestNews(), 5000);
  console.log('[news-ingester] crons scheduled');
}
