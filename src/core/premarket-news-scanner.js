/**
 * Pre-market news scanner.
 * Runs at 4 AM ET Mon-Fri. Queries benzinga_news for overnight articles
 * touching held positions (Alpaca + Moomoo) and watchlist tickers, then
 * sends a styled digest email + PWA push for critical items.
 *
 * No new schema required — reads benzinga_news (Phase D) and
 * push_subscriptions (Phase 5).
 */

import { Resend }                                  from 'resend';
import { query, isDbAvailable, getAllWatchlistSymbols } from './db.js';
import { getPositions as getAlpacaPositions }       from './trader.js';
import { getPositions as getMoomooPositions }        from './moomoo-tcp.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const SCAN_WINDOW_HOURS = 12;   // look back 12 h (4 PM prior day → 4 AM today)

const CRITICAL_CHANNELS = new Set([
  'Bankruptcy', 'Lawsuit', 'SEC', 'Recall', 'Layoffs',
  'Earnings Miss', 'Downgrades', 'Fraud',
]);

// ─── Classification ───────────────────────────────────────────────────────────

function _classify({ isHeld, sentiment, channels }) {
  if (isHeld) {
    const channelHit = Array.isArray(channels) && channels.some(c => CRITICAL_CHANNELS.has(c));
    if (sentiment === 'negative' || channelHit) return 'critical';
    return 'important';
  }
  return 'standard';
}

// ─── Main entry ───────────────────────────────────────────────────────────────

let _isRunning = false;

export async function runPreMarketScan({ manual = false } = {}) {
  if (_isRunning) {
    console.log('[premarket-scan] skip — previous run still in progress');
    return { skipped: true };
  }
  if (!isDbAvailable()) return { skipped: true, reason: 'no db' };

  _isRunning = true;
  try {
    // 1. Gather symbols of interest ──────────────────────────────────────────
    const heldSymbols  = await _gatherHeldSymbols();
    const watchSymbols = await getAllWatchlistSymbols();
    const heldSet      = new Set(heldSymbols.map(s => s.toUpperCase()));
    const allSymbols   = new Set([...heldSymbols, ...watchSymbols].map(s => s.toUpperCase()));

    if (!allSymbols.size) {
      console.log('[premarket-scan] no positions or watchlist symbols');
      return { skipped: true, reason: 'no symbols' };
    }

    // 2. Query benzinga_news for overnight window ─────────────────────────────
    // tickers ?| text[]  →  any element of the JSONB array exists in the set.
    // Uses the GIN index on tickers for performance.
    const symArray = [...allSymbols];
    const { rows: articles } = await query(
      `SELECT article_id, title, teaser, url, source, published_at,
              sentiment, channels, tickers
       FROM benzinga_news
       WHERE published_at > NOW() - ($1 || ' hours')::interval
         AND tickers ?| $2::text[]
       ORDER BY published_at DESC`,
      [String(SCAN_WINDOW_HOURS), symArray]
    );

    if (!articles.length) {
      console.log('[premarket-scan] no overnight news for tracked symbols');
      return { sent: false, reason: 'no news' };
    }

    // 3. Bucket articles by ticker, classify each ────────────────────────────
    const byTicker = new Map();  // ticker → { isHeld, articles: [...] }
    for (const a of articles) {
      const tickers = Array.isArray(a.tickers) ? a.tickers : [];
      for (const rawT of tickers) {
        const t = String(rawT).toUpperCase();
        if (!allSymbols.has(t)) continue;
        if (!byTicker.has(t)) {
          byTicker.set(t, { isHeld: heldSet.has(t), articles: [] });
        }
        const entry = byTicker.get(t);
        entry.articles.push({
          ...a,
          classification: _classify({
            isHeld:   entry.isHeld,
            sentiment: a.sentiment,
            channels:  a.channels,
          }),
        });
      }
    }

    // 4. Sort into severity buckets ───────────────────────────────────────────
    const critical  = [];
    const important = [];
    const standard  = [];

    for (const [ticker, info] of byTicker) {
      const hasCritical = info.articles.some(a => a.classification === 'critical');
      if (hasCritical)        critical.push({ ticker, ...info });
      else if (info.isHeld)   important.push({ ticker, ...info });
      else                    standard.push({ ticker, ...info });
    }

    // Sort each bucket — held positions first within bucket
    const byCount = (a, b) => b.articles.length - a.articles.length;
    critical.sort(byCount);
    important.sort(byCount);
    standard.sort(byCount);

    // 5. Compose + send digest email ─────────────────────────────────────────
    await _sendDigestEmail({ critical, important, standard });

    // 6. Fire critical PWA pushes ────────────────────────────────────────────
    if (critical.length) {
      await _sendCriticalPushes(critical).catch(e =>
        console.error('[premarket-scan] push dispatch failed:', e.message)
      );
    }

    const counts = {
      critical:  critical.length,
      important: important.length,
      standard:  standard.length,
      articles:  articles.length,
    };
    console.log('[premarket-scan] done', counts);
    return { sent: true, counts, manual };

  } catch (e) {
    console.error('[premarket-scan] fatal:', e);
    return { error: e.message };
  } finally {
    _isRunning = false;
  }
}

// ─── Gather held symbols ──────────────────────────────────────────────────────

async function _gatherHeldSymbols() {
  const symbols = new Set();

  const [alpacaRes, moomooRes] = await Promise.allSettled([
    getAlpacaPositions(),
    getMoomooPositions(),
  ]);

  if (alpacaRes.status === 'fulfilled') {
    for (const p of alpacaRes.value || []) {
      const s = p.symbol;
      if (s) symbols.add(String(s).toUpperCase());
    }
  } else {
    console.warn('[premarket-scan] alpaca positions failed:', alpacaRes.reason?.message);
  }

  if (moomooRes.status === 'fulfilled') {
    const mooArr = moomooRes.value?.positions ?? moomooRes.value ?? [];
    for (const p of Array.isArray(mooArr) ? mooArr : []) {
      const s = p.symbol || p.code;
      if (s) symbols.add(String(s).toUpperCase());
    }
  } else {
    console.warn('[premarket-scan] moomoo positions failed:', moomooRes.reason?.message);
  }

  return [...symbols];
}

// ─── Email dispatch ───────────────────────────────────────────────────────────

async function _sendDigestEmail({ critical, important, standard }) {
  const apiKey = process.env.RESEND_API;
  if (!apiKey) {
    console.warn('[premarket-scan] RESEND_API not configured — email skipped');
    return;
  }
  const to = process.env.ALERT_EMAIL || process.env.SENTINEL_EMAIL_TO;
  if (!to) {
    console.warn('[premarket-scan] ALERT_EMAIL not configured — email skipped');
    return;
  }

  const totalArticles = [...critical, ...important, ...standard]
    .reduce((sum, t) => sum + t.articles.length, 0);

  const subject = critical.length
    ? `🚨 Pre-Market Alert: ${critical.length} critical · ${totalArticles} articles`
    : `📰 Pre-Market Digest: ${totalArticles} overnight articles`;

  const html = _renderEmailHtml({ critical, important, standard });

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from:    process.env.RESEND_FROM || 'info@dlpinnovations.com',
      to,
      subject,
      html,
    });
    console.log('[premarket-scan] email sent:', result?.data?.id || result?.id);
  } catch (e) {
    console.error('[premarket-scan] email send failed:', e.message);
  }
}

// ─── Email template ───────────────────────────────────────────────────────────

function _renderEmailHtml({ critical, important, standard }) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));

  const fmtTime = ts => {
    try {
      return new Date(ts).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      }) + ' ET';
    } catch { return String(ts); }
  };

  const sentimentColor = s =>
    s === 'negative' ? '#f85149' : s === 'positive' ? '#3fb950' : '#8b949e';

  const renderArticle = a => `
    <div style="margin-top:10px">
      <a href="${esc(a.url || '#')}"
         style="color:#58a6ff;text-decoration:none;font-size:0.87rem;line-height:1.4"
      >${esc(a.title)}</a>
      <div style="color:#8b949e;font-size:0.76rem;margin-top:3px">
        ${esc(a.source || 'Benzinga')} · ${esc(fmtTime(a.published_at))}
        ${a.sentiment
          ? ` · <span style="color:${sentimentColor(a.sentiment)}">${esc(a.sentiment)}</span>`
          : ''}
      </div>
    </div>`;

  const renderTicker = (t, borderColor) => `
    <div style="margin:12px 0;padding:12px 14px;background:#161b22;
                border-left:4px solid ${borderColor};border-radius:6px">
      <div style="font-weight:700;font-size:1rem;color:#e6edf3;margin-bottom:4px">
        ${esc(t.ticker)}
        <span style="font-weight:400;font-size:0.82rem;color:#8b949e">
          · ${t.articles.length} article${t.articles.length > 1 ? 's' : ''}
          ${t.isHeld ? ' · <span style="color:#f0883e">held position</span>' : ''}
        </span>
      </div>
      ${t.articles.slice(0, 5).map(renderArticle).join('')}
      ${t.articles.length > 5
        ? `<div style="color:#6e7681;font-size:0.76rem;margin-top:6px">+${t.articles.length - 5} more articles</div>`
        : ''}
    </div>`;

  const renderSection = (heading, color, items) => {
    if (!items.length) return '';
    return `
      <h2 style="color:${color};font-size:1.05rem;margin:24px 0 8px;
                 padding-bottom:6px;border-bottom:1px solid #21262d">
        ${heading}
      </h2>
      ${items.map(t => renderTicker(t, color)).join('')}`;
  };

  return `
    <!DOCTYPE html>
    <html>
    <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
                 background:#0d1117;color:#c9d1d9;padding:24px;margin:0">
      <div style="max-width:680px;margin:auto">
        <h1 style="color:#e6edf3;font-size:1.35rem;margin:0 0 4px">
          📰 Pre-Market News Digest
        </h1>
        <div style="color:#8b949e;font-size:0.8rem;margin-bottom:20px">
          Generated ${esc(fmtTime(new Date()))}
        </div>

        ${renderSection('🚨 Critical — negative news on held positions', '#f85149', critical)}
        ${renderSection('📊 Your Positions — overnight news', '#58a6ff', important)}
        ${renderSection('👁️ Your Watchlist', '#8b949e', standard)}

        <hr style="border:none;border-top:1px solid #21262d;margin:28px 0 16px">
        <div style="font-size:0.73rem;color:#6e7681">
          Trading Dashboard · Auto-generated at 4 AM ET · Not financial advice
        </div>
      </div>
    </body>
    </html>`;
}

// ─── PWA push for critical tickers ───────────────────────────────────────────
// Mirrors sendCriticalPush() in system-alerts.js (not exported — replicated here).

async function _sendCriticalPushes(criticalTickers) {
  if (!isDbAvailable()) return;

  const vapidPublic  = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) return;

  const { default: webpush } = await import('web-push');
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:info@trading.dlpinnovations.com',
    vapidPublic,
    vapidPrivate
  );

  const { rows: subs } = await query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions'
  );
  if (!subs.length) return;

  for (const c of criticalTickers.slice(0, 5)) {
    const payload = JSON.stringify({
      title: `🚨 Pre-market: ${c.ticker}`,
      body:  `${c.articles.length} negative article${c.articles.length > 1 ? 's' : ''} overnight — review before open`,
      url:   `/?tab=discover&ticker=${encodeURIComponent(c.ticker)}`,
      key:   `premarket/critical/${c.ticker}`,
    });

    await Promise.allSettled(
      subs.map(sub =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        ).catch(e => {
          if (e.statusCode === 410) {
            query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]).catch(() => {});
          }
        })
      )
    );
  }

  console.log('[premarket-scan] push sent to', subs.length, 'subscriber(s) for',
    criticalTickers.slice(0, 5).map(c => c.ticker).join(', '));
}
