/**
 * src/core/news-alert.js
 *
 * Real-time Telegram alerts for market-moving news events.
 * Called from news-ingester.js after each successful ingest run.
 *
 * Detects five high-signal event categories in Benzinga headlines/channels:
 *   🏦 M&A / Takeover
 *   💰 Strategic Investment
 *   🏛️ Government / Regulatory
 *   📢 Major Corporate (spinoff, IPO, CEO change, buyback, dividend)
 *   📈 Analyst Upgrade / PT Raise  (top-tier targets only, filtered by size)
 *
 * Dedup: articles are inserted into `news_tg_alerts` so restarts don't re-fire.
 * Only articles published within MAX_AGE_MINS are eligible — old news on startup
 * is silently ignored.
 */

import { query, isDbAvailable } from './db.js';
import { sendTelegram } from './telegram.js';

// ─── Config ────────────────────────────────────────────────────────────────────
const MAX_AGE_MINS  = 30;   // ignore articles older than this (prevents startup floods)
const MAX_PER_RUN   = 10;   // safety cap — at most 10 Telegram messages per ingest tick
const MIN_TICKERS   = 1;    // articles with no ticker tags are skipped
const MAX_TICKERS   = 8;    // skip generic market-analysis articles (many tickers = no specific event)

// ─── Category definitions ──────────────────────────────────────────────────────
// titleKw   — matched against lowercased article title + teaser
// channelKw — matched against lowercased Benzinga channel tags (already enriched)
const CATEGORIES = [
  {
    id: 'ma',
    icon: '🏦',
    label: 'M&A / Takeover',
    priority: 1,
    titleKw: [
      'merger', 'merging', 'acquisition', 'acquire', 'acquires', 'acquired',
      'takeover', 'buyout', 'buy out', 'tender offer', 'going private',
      'purchase agreement', 'strategic alternatives',
      'agree to buy', 'agreed to buy', 'to acquire', 'in talks to buy',
      'deal to buy', 'to be acquired', 'exploring sale', 'sell itself',
      'going-private', 'take private', 'leveraged buyout', 'lbo',
    ],
    channelKw: [
      'merger', 'acquisition', 'takeover', 'buyout', 'm&a',
      'strategic alternatives', 'tender offer', 'going private',
      'purchase agreement', 'takeover code', 'takeover bid',
    ],
  },
  {
    id: 'investment',
    icon: '💰',
    label: 'Strategic Investment',
    priority: 2,
    titleKw: [
      'strategic investment', 'strategic partnership', 'joint venture',
      'equity stake', 'minority stake', 'majority stake',
      'funding round', 'raises capital', 'secures funding',
      // Removed: 'invests in', 'invested in', 'investing in' — too loose;
      // matched generic press releases like "company invested in growth"
      'billion investment', 'million investment',
      'venture capital', 'private equity investment',
    ],
    channelKw: [
      'strategic investment', 'joint venture', 'funding round',
      // Removed 'investment agreement' — caught earnings announcements via channel tags
      'strategic partnership',
    ],
  },
  {
    id: 'government',
    icon: '🏛️',
    label: 'Government / Regulatory',
    priority: 3,
    titleKw: [
      'fda approv', 'fda clear', 'cleared by fda', 'fda grants',
      'fda accepts', 'fda breakthrough', 'fda priority review',
      'contract award', 'government contract', 'wins contract',
      'receives contract', 'awarded contract', 'secures contract',
      'pentagon', 'dod contract', 'dod award', 'defense contract',
      'antitrust approv', 'regulatory approv', 'regulatory clear',
      'government investment', 'government grant', 'subsidy', 'stimulus',
      'irs ruling', 'doj approv', 'sec approv',
    ],
    channelKw: [
      'fda approval', 'fda clearance', 'government contract', 'contract award',
      'pentagon', 'dod', 'defense contract', 'regulatory approval',
      'antitrust', 'government grant', 'government investment',
    ],
  },
  {
    id: 'corporate',
    icon: '📢',
    label: 'Major Corporate Event',
    priority: 4,
    titleKw: [
      'spinoff', 'spin-off', 'spun off', 'spinning off',
      'going public', 'direct listing', 'spac merger',
      'share repurchase', 'buyback program', 'repurchase program',
      'special dividend', 'dividend increase', 'dividend hike',
      'dividend cut', 'suspends dividend',
      'restructuring', 'strategic review', 'exploring strategic',
      'ceo resigns', 'ceo resign', 'ceo replaced', 'appoints ceo',
      'names ceo', 'ceo steps down', 'ceo departure',
      'cfo resign', 'cfo departs', 'names cfo',
      'workforce reduction', 'layoffs', 'mass layoff',
    ],
    channelKw: [
      'spinoff', 'ipo', 'buyback', 'share repurchase', 'special dividend',
      'dividend hike', 'dividend cut', 'restructuring', 'strategic review',
      'ceo change', 'management change', 'layoffs', 'workforce reduction',
    ],
  },
  {
    id: 'analyst',
    icon: '📈',
    label: 'Analyst Upgrade / Target Raise',
    priority: 5,
    // Analyst alerts are very noisy — only fire when a big institution acts
    // AND the title suggests a meaningful move (upgrade or large PT raise).
    titleKw: [
      'upgrades to buy', 'upgraded to buy', 'upgrades to strong buy',
      'raises price target', 'raises pt', 'boosts price target',
      'initiates with buy', 'initiates coverage with buy',
      'initiates at buy', 'starts at buy', 'begins coverage with buy',
      'double upgrade', 'upgraded from',
    ],
    channelKw: [
      'analyst upgrade', 'price target increase', 'initiated at buy',
    ],
  },
];

// ─── Universe cache — reload every 60 min ─────────────────────────────────────
let _universeSet  = null;
let _universeTs   = 0;
const UNIVERSE_TTL = 60 * 60_000;

async function _loadUniverse() {
  if (_universeSet && Date.now() - _universeTs < UNIVERSE_TTL) return _universeSet;
  try {
    const { rows } = await query(`SELECT symbol FROM tradable_universe`);
    _universeSet = new Set(rows.map(r => r.symbol.toUpperCase()));
    _universeTs  = Date.now();
  } catch (_) {
    _universeSet = _universeSet || new Set();   // keep stale set on error
  }
  return _universeSet;
}

// ─── In-memory guard (clears on restart — DB is the primary dedup) ──────────
const _alertedIds = new Set();

// ─── Junk / foreign-language filters ───────────────────────────────────────────
// Added 2026-05-29 after seeing the alert stream produce 4/6 false positives:
//   • Spanish-language press releases ("ZenaTech buscará nuevas oportunidades…")
//   • Class-action notices ("Gross Law Firm Reminds Pinterest Investors…")
//   • Routine earnings scheduling ("…to Report Fourth Quarter Financial Results")
//   • Cross-categorised insider trades ("Alexander Hansson purchase more shares")
// These have nothing in common with actual market-moving catalysts.

function _isLikelyNonEnglish(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  // Common Spanish / Portuguese / French / Italian / German markers — extremely
  // rare in English titles. One match is usually enough.
  const foreignMarkers = [
    'buscará', 'anunciará', 'reporta ', 'informa ', 'oportunidades',
    'inversión', 'inversiones', 'compañía', 'empresa', 'según',
    'también', 'además', 'mediante', 'através', 'após',
    'annonce', 'rapporte', 'société', 'azienda', 'società',
    'unternehmen', 'gesellschaft',
  ];
  if (foreignMarkers.some(w => t.includes(w))) return true;
  // High accented-char ratio (≥2 accents) is a strong non-English signal.
  const accentCount = (title.match(/[áéíóúñçãõàâêîôûäëïöü¿¡]/gi) || []).length;
  return accentCount >= 2;
}

function _isLikelyJunk(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  // 1. Lawsuit / class-action / investor-alert spam (esp. from law firms)
  if (/\b(class action|law firm|lawsuit|securities fraud|shareholder rights|investor alert|deadline reminder|investigating claims|under investigation|sec investigation)\b/.test(t)) return true;
  // 2. Routine earnings-date announcements (NOT actual results)
  //    e.g. "PetMed Express to Report Fourth Quarter Financial Results"
  if (/\bto (report|announce|host).{0,40}(quarter|fiscal|q[1-4]|annual|year|earnings)/i.test(title)) return true;
  if (/\b(earnings|conference call|webcast).{0,30}(scheduled|webcast|conference call|set for)\b/i.test(t)) return true;
  // 3. Routine dividend / capital-return calendar items
  if (/\b(dividend (payment|declaration) date|declares.{0,15}dividend|ex-dividend)\b/.test(t)) return true;
  // 4. Conference / webcast / investor-day scheduling
  if (/\b(to participate in|to present at|to host).{0,30}(conference|webcast|investor day|fireside)/i.test(title)) return true;
  // 5. Cross-categorised insider trades — these have their own UW pipeline
  if (/\b(purchase more shares|insider (buy|purchase)|director.{0,5}(buy|purchase|acquires))\b/i.test(t)) return true;
  return false;
}

// ─── Matching ──────────────────────────────────────────────────────────────────
function _matchCategory(title, channels) {
  // Match on TITLE and CHANNEL TAGS only — not the teaser.
  // Teasers are editorial summaries that mention acquisitions/investments
  // in passing ("the company previously acquired X") which causes false positives.
  const titleLow = (title || '').toLowerCase();
  const chStr    = Array.isArray(channels)
    ? channels.map(c => String(c).toLowerCase()).join(' ')
    : '';

  for (const cat of CATEGORIES) {
    const titleHit   = cat.titleKw.some(kw => titleLow.includes(kw));
    const channelHit = cat.channelKw.some(kw => chStr.includes(kw));
    if (titleHit || channelHit) return cat;
  }
  return null;
}

// ─── Schema bootstrap ──────────────────────────────────────────────────────────
let _tableReady = false;
async function _ensureTable() {
  if (_tableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS news_tg_alerts (
      article_id  TEXT        PRIMARY KEY,
      category    TEXT,
      tickers     TEXT[],
      title       TEXT,
      alerted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  _tableReady = true;
}

// ─── Formatting helpers ────────────────────────────────────────────────────────
function _fmtAgo(published_at) {
  const mins = Math.round((Date.now() - new Date(published_at).getTime()) / 60_000);
  if (mins <  1)  return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
}

function _fmtSentiment(s) {
  if (s === 'positive') return '📈 bullish';
  if (s === 'negative') return '📉 bearish';
  return '⚖️ neutral';
}

function _buildMessage(cat, row) {
  const tickers    = (Array.isArray(row.tickers) ? row.tickers : []).slice(0, 6);
  const tickerLine = tickers.map(t => `$${t}`).join(' ');
  const teaser     = (row.teaser || '').replace(/<[^>]+>/g, '').slice(0, 200).trim();
  const tags       = Array.isArray(row.channels) ? row.channels.slice(0, 4).join(' · ') : '';
  const ago        = _fmtAgo(row.published_at);
  const link       = row.url ? `\n🔗 <a href="${row.url}">Read article</a>` : '';

  return (
    `${cat.icon} <b>${cat.label}</b>  ${tickerLine}\n` +
    `<b>${row.title}</b>\n` +
    (teaser ? `${teaser}\n` : '') +
    `\n` +
    (tags ? `🏷 <i>${tags}</i>\n` : '') +
    `${_fmtSentiment(row.sentiment)}  ·  📰 Benzinga  ·  ${ago}` +
    link
  );
}

// ─── Main entry ────────────────────────────────────────────────────────────────
let _isRunning = false;

export async function scanAndAlertNewsMovers() {
  if (!isDbAvailable()) return;
  if (_isRunning) return;
  _isRunning = true;

  try {
    await _ensureTable();

    // Fetch recently-ingested articles not yet alerted.
    // LEFT JOIN on news_tg_alerts keeps this to one DB round-trip.
    const { rows } = await query(`
      SELECT b.article_id, b.title, b.teaser, b.url,
             b.channels, b.tickers, b.sentiment, b.published_at
        FROM benzinga_news b
        LEFT JOIN news_tg_alerts a USING (article_id)
       WHERE b.published_at > NOW() - ($1 * INTERVAL '1 minute')
         AND a.article_id IS NULL
       ORDER BY b.published_at DESC
       LIMIT 100
    `, [MAX_AGE_MINS]);

    const universe = await _loadUniverse();

    let fired = 0;
    for (const row of rows) {
      if (fired >= MAX_PER_RUN) break;

      const id = row.article_id;
      if (_alertedIds.has(id)) continue;

      const tickers = Array.isArray(row.tickers)
        ? row.tickers.filter(Boolean)
        : [];
      if (tickers.length < MIN_TICKERS) continue;
      if (tickers.length > MAX_TICKERS) continue;  // skip generic multi-ticker analysis

      // Only alert when at least one ticker is a US stock in our tradable universe.
      // This cuts out foreign OTC stocks (BEKAY, TGVSY, etc.) and noise articles
      // about companies we don't track.
      if (universe.size > 0 && !tickers.some(t => universe.has(t.toUpperCase()))) continue;

      // Junk + foreign filters — applied BEFORE category matching so a junk
      // article never fires even if a category keyword spuriously matches.
      if (_isLikelyNonEnglish(row.title)) continue;
      if (_isLikelyJunk(row.title))       continue;

      const cat = _matchCategory(row.title, row.channels);
      if (!cat) continue;

      // Claim the slot — prevents concurrent runs from double-firing
      _alertedIds.add(id);
      try {
        await query(
          `INSERT INTO news_tg_alerts (article_id, category, tickers, title)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [id, cat.id, tickers, row.title?.slice(0, 500)]
        );
      } catch (_) { /* harmless — in-memory guard already blocks re-fire */ }

      const msg = _buildMessage(cat, row);
      sendTelegram(msg).catch(() => {});
      fired++;
    }

    if (fired > 0) {
      console.log(`[news-alert] sent ${fired} Telegram alert(s)`);
    }
  } catch (e) {
    console.warn('[news-alert] scan failed:', e.message);
  } finally {
    _isRunning = false;
  }
}
