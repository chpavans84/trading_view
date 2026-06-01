/**
 * src/core/news-categorizer.js
 *
 * Powers the Discover tab's category strip. Pulls recent Benzinga articles,
 * enriches each one with our edge data (bot verdict / UW flow / insider /
 * congress / earnings / your-positions), then filters by the requested
 * category. The whole point is showing news + the context newspapers don't
 * have: "this story is bullish AND smart money is loading up" beats just
 * "this story is bullish".
 *
 * Categories:
 *   hot         — last 2h, mega-cap or multi-source coverage
 *   bullish     — positive sentiment AND (bullish flow OR insider buy OR rising conviction)
 *   bearish     — negative sentiment AND (bearish flow OR insider sell OR falling conviction OR EXIT verdict)
 *   smart_money — recent UW flow / insider buy / congress trade matches the article ticker
 *   earnings    — ticker reports in next 7d
 *   holdings    — ticker is in the user's Alpaca/Moomoo positions
 *   congress    — ticker has congressional activity in last 90d
 *
 * Performance notes:
 *   - Pulls 300 candidates per request, enriches in one batched SQL pass
 *     per signal (5 batched queries total), then filters in-memory.
 *   - All enrichment queries use ANY($1::text[]) so they're O(1) round-trips.
 *   - Designed to return in <500 ms even under load.
 */

import { query } from './db.js';

// ── Category constants ──────────────────────────────────────────────────────
export const CATEGORIES = [
  'hot', 'bullish', 'bearish', 'smart_money', 'earnings', 'holdings', 'congress',
];

// Mega-caps — the names that drive market-wide attention. Used by the Hot tab.
const MEGA_CAPS = new Set([
  'AAPL','MSFT','NVDA','GOOGL','GOOG','AMZN','META','TSLA','AVGO','BRK-B','LLY',
  'JPM','V','UNH','XOM','WMT','MA','JNJ','PG','HD','ABBV','COST','ORCL','MRK',
  'CVX','BAC','KO','NFLX','AMD','ADBE','CRM','PEP','TMO','CSCO','MCD','ABT',
  'PFE','LIN','ACN','DIS','INTC','QCOM','VZ','TXN','IBM','PM','GE','BMY',
  'GS','UBER','PYPL','HOOD','PLTR','COIN','SHOP','SNOW','SOFI'
]);

// ── Main entrypoint ─────────────────────────────────────────────────────────
export async function getCategorizedNews({ category, limit = 50, username, positionsProvider } = {}) {
  if (!CATEGORIES.includes(category)) {
    throw new Error(`Unknown category: ${category}`);
  }

  // Pull a larger candidate pool than `limit` — the category filter is strict
  // (e.g. bullish requires sentiment + flow + insider alignment), so we need
  // headroom or we'd return half-empty pages.
  const CANDIDATES = 300;
  const articles = await _fetchRecentArticles(CANDIDATES);
  if (!articles.length) return { articles: [], count: 0, category };

  // Collect every distinct ticker across all candidate articles
  const allTickers = new Set();
  for (const a of articles) {
    const ts = Array.isArray(a.tickers) ? a.tickers : [];
    for (const t of ts) if (typeof t === 'string') allTickers.add(t.toUpperCase());
  }
  const tickers = [...allTickers];

  // Batched enrichment — one query per signal source, all tickers at once.
  // `Promise.all` keeps total wall time ≈ slowest query, not sum.
  const [bot, flow, insider, congress, earnings] = await Promise.all([
    _fetchBotVerdicts(tickers),
    _fetchRecentFlow(tickers),
    _fetchRecentInsider(tickers),
    _fetchRecentCongress(tickers),
    _fetchUpcomingEarnings(tickers),
  ]);

  // Held positions only needed for the holdings category — skip otherwise
  const holdings = (category === 'holdings' && positionsProvider)
    ? await positionsProvider().catch(() => new Set())
    : new Set();

  // Attach enrichment chips to every article (cheap — frontend uses them too)
  for (const a of articles) {
    const ts = (Array.isArray(a.tickers) ? a.tickers : []).map(t => String(t).toUpperCase());
    a.primary_ticker = ts[0] || null;
    a._enrichment = _attachEnrichment(ts, { bot, flow, insider, congress, earnings });
  }

  // Apply category filter
  const filtered = articles.filter(a =>
    _matchesCategory(a, category, { holdings })
  );

  // Cleanup: remove the internal `_enrichment` map but keep flattened chips
  for (const a of filtered) {
    a.chips = _buildChips(a._enrichment);
    delete a._enrichment;
  }

  return { articles: filtered.slice(0, limit), count: filtered.length, category };
}

// ── Data fetchers ───────────────────────────────────────────────────────────

async function _fetchRecentArticles(limit) {
  const { rows } = await query(`
    SELECT article_id, title, teaser, url, source, author, image_url,
           channels, tickers, sentiment, published_at
    FROM benzinga_news
    WHERE published_at >= NOW() - INTERVAL '7 days'
    ORDER BY published_at DESC, article_id DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

/** Most-recent bot decision per ticker (across all bots) */
async function _fetchBotVerdicts(tickers) {
  if (!tickers.length) return {};
  const { rows } = await query(`
    SELECT DISTINCT ON (symbol)
      symbol, action, composite_score, setup_type, scanned_at
    FROM bot_decisions
    WHERE symbol = ANY($1::text[])
      AND scanned_at >= NOW() - INTERVAL '7 days'
    ORDER BY symbol, scanned_at DESC
  `, [tickers]);

  // Layer in the conviction grade where available (more recent table)
  const { rows: cvRows } = await query(`
    SELECT DISTINCT ON (symbol)
      symbol, score, grade, scored_at
    FROM conviction_scores
    WHERE symbol = ANY($1::text[])
      AND scored_at >= NOW() - INTERVAL '7 days'
    ORDER BY symbol, scored_at DESC
  `, [tickers]);

  const map = {};
  for (const r of rows) {
    map[r.symbol] = {
      action:     r.action,
      score:      Number(r.composite_score) || null,
      setup:      r.setup_type,
      decided_at: r.scanned_at,
    };
  }
  for (const r of cvRows) {
    map[r.symbol] = {
      ...(map[r.symbol] || {}),
      grade:     r.grade,
      cv_score:  r.score,
      scored_at: r.scored_at,
    };
  }
  return map;
}

/** Recent UW options-flow alerts per ticker (highest premium first) */
async function _fetchRecentFlow(tickers) {
  if (!tickers.length) return {};
  const { rows } = await query(`
    SELECT DISTINCT ON (ticker)
      ticker, side, premium, sentiment, alerted_at
    FROM uw_flow_alerts
    WHERE ticker = ANY($1::text[])
      AND alerted_at >= NOW() - INTERVAL '48 hours'
      AND premium >= 50000
    ORDER BY ticker, premium DESC NULLS LAST
  `, [tickers]);
  const map = {};
  for (const r of rows) {
    map[r.ticker] = {
      side:       r.side,
      premium:    Number(r.premium) || 0,
      sentiment:  r.sentiment,
      alerted_at: r.alerted_at,
    };
  }
  return map;
}

/** Recent insider Form 4 activity per ticker (net buy/sell value) */
async function _fetchRecentInsider(tickers) {
  if (!tickers.length) return {};
  const { rows } = await query(`
    SELECT ticker,
           SUM(CASE WHEN LOWER(transaction_type) LIKE '%buy%'   THEN COALESCE(value,0) ELSE 0 END) AS buy_value,
           SUM(CASE WHEN LOWER(transaction_type) LIKE '%sell%'  THEN COALESCE(value,0) ELSE 0 END) AS sell_value,
           COUNT(*) AS event_count,
           MAX(filed_at) AS last_filed
    FROM uw_insider_trades
    WHERE ticker = ANY($1::text[])
      AND filed_at >= NOW() - INTERVAL '14 days'
    GROUP BY ticker
  `, [tickers]);
  const map = {};
  for (const r of rows) {
    const buy  = Number(r.buy_value) || 0;
    const sell = Number(r.sell_value) || 0;
    map[r.ticker] = {
      buy_value:  buy,
      sell_value: sell,
      net_value:  buy - sell,
      count:      Number(r.event_count) || 0,
      last_filed: r.last_filed,
    };
  }
  return map;
}

/** Recent congressional trades per ticker (last 90d) */
async function _fetchRecentCongress(tickers) {
  if (!tickers.length) return {};
  const { rows } = await query(`
    SELECT ticker, COUNT(*) AS trade_count, MAX(traded_at) AS last_traded
    FROM uw_congressional_trades
    WHERE ticker = ANY($1::text[])
      AND traded_at >= CURRENT_DATE - INTERVAL '90 days'
    GROUP BY ticker
  `, [tickers]);
  const map = {};
  for (const r of rows) {
    map[r.ticker] = {
      count:       Number(r.trade_count) || 0,
      last_traded: r.last_traded,
    };
  }
  return map;
}

/** Upcoming earnings per ticker — no calendar table in DB today, so this
 *  is a placeholder. The 'earnings' category instead matches articles whose
 *  Benzinga `channels` array contains earnings-related tags (handled in
 *  `_matchesCategory`). When an earnings_calendar table gets backfilled,
 *  flesh out this function with the per-ticker date join. */
async function _fetchUpcomingEarnings(tickers) {
  return {};
}

/** Channel-tag regex used by the 'earnings' category */
const EARNINGS_CHANNEL_RX = /earnings|earnings\s*beat|earnings\s*report|earnings\s*preview|earnings\s*miss|Q[1-4]\s*\d{4}/i;

// ── Per-article enrichment ──────────────────────────────────────────────────

function _attachEnrichment(tickers, { bot, flow, insider, congress, earnings }) {
  const out = { bot: null, flow: null, insider: null, congress: null, earnings: null };
  for (const t of tickers) {
    if (!out.bot      && bot[t])      out.bot      = { ticker: t, ...bot[t] };
    if (!out.flow     && flow[t])     out.flow     = { ticker: t, ...flow[t] };
    if (!out.insider  && insider[t])  out.insider  = { ticker: t, ...insider[t] };
    if (!out.congress && congress[t]) out.congress = { ticker: t, ...congress[t] };
    if (!out.earnings && earnings[t]) out.earnings = { ticker: t, ...earnings[t] };
  }
  return out;
}

// ── Category filter rules ───────────────────────────────────────────────────

function _matchesCategory(article, category, { holdings }) {
  const tickers = (Array.isArray(article.tickers) ? article.tickers : []).map(t => String(t).toUpperCase());
  const e = article._enrichment;
  const publishedAt = new Date(article.published_at).getTime();
  const ageMin = (Date.now() - publishedAt) / 60000;

  switch (category) {
    case 'hot': {
      // Last 6h AND (mega-cap ticker OR positive sentiment OR has bot verdict)
      if (ageMin > 360) return false;
      const hasMega = tickers.some(t => MEGA_CAPS.has(t));
      const hasBot  = !!e.bot;
      const hot     = hasMega || hasBot || article.sentiment === 'positive';
      return hot;
    }

    case 'bullish': {
      // Positive sentiment AND at least one bullish signal
      if (article.sentiment !== 'positive') return false;
      const flowBullish    = e.flow?.sentiment === 'bullish' || /buy|call/i.test(e.flow?.side || '');
      const insiderBullish = (e.insider?.net_value || 0) > 50000;
      const botBullish     = e.bot?.action === 'BUY' || (e.bot?.cv_score >= 60);
      return flowBullish || insiderBullish || botBullish;
    }

    case 'bearish': {
      if (article.sentiment !== 'negative') return false;
      const flowBearish    = e.flow?.sentiment === 'bearish' || /sell|put/i.test(e.flow?.side || '');
      const insiderBearish = (e.insider?.net_value || 0) < -50000;
      const botBearish     = e.bot?.action === 'EXIT' || e.bot?.action === 'SELL' || (e.bot?.cv_score != null && e.bot?.cv_score < 40);
      return flowBearish || insiderBearish || botBearish;
    }

    case 'smart_money': {
      // Any UW flow OR insider buy OR congress trade on this ticker
      const bigFlow    = (e.flow?.premium || 0) >= 100000;
      const insiderBuy = (e.insider?.buy_value || 0) > 0;
      const congress   = (e.congress?.count || 0) > 0;
      return bigFlow || insiderBuy || congress;
    }

    case 'earnings': {
      // Match articles tagged with earnings-related channels
      const channels = Array.isArray(article.channels) ? article.channels : [];
      return channels.some(c => EARNINGS_CHANNEL_RX.test(String(c)));
    }

    case 'holdings':
      return tickers.some(t => holdings.has(t));

    case 'congress':
      return !!e.congress;

    default:
      return false;
  }
}

// ── Chip builder (flattens enrichment into UI-ready chips) ──────────────────

function _buildChips(e) {
  const chips = [];

  if (e.bot) {
    const action = e.bot.action || (e.bot.grade ? `${e.bot.grade}-grade` : null);
    if (action) {
      const score = e.bot.cv_score ?? e.bot.score;
      const label = action + (score != null ? ` · ${Math.round(score)}` : '');
      // Tone: BUY/A/B = pos · SELL/EXIT/F = neg · everything else = neu
      let tone = 'neu';
      if (/BUY/i.test(action) || /^[AB]/i.test(e.bot.grade || ''))      tone = 'pos';
      else if (/SELL|EXIT/i.test(action) || /^F/i.test(e.bot.grade || '')) tone = 'neg';
      else if (score != null && score >= 60)                              tone = 'pos';
      else if (score != null && score < 40)                               tone = 'neg';
      chips.push({ kind: 'bot', ticker: e.bot.ticker, label, tone });
    }
  }

  if (e.flow) {
    const m = Math.round((e.flow.premium || 0) / 1000);
    chips.push({
      kind:   'flow',
      ticker: e.flow.ticker,
      label:  `🐋 $${m >= 1000 ? (m/1000).toFixed(1) + 'M' : m + 'K'} ${e.flow.side || 'flow'}`,
      tone:   e.flow.sentiment === 'bullish' ? 'pos' : e.flow.sentiment === 'bearish' ? 'neg' : 'neu',
    });
  }

  if (e.insider) {
    const net = e.insider.net_value || 0;
    if (Math.abs(net) >= 50000) {
      const m = Math.abs(net) >= 1e6 ? `$${(Math.abs(net)/1e6).toFixed(1)}M` : `$${Math.round(Math.abs(net)/1000)}K`;
      chips.push({
        kind:   'insider',
        ticker: e.insider.ticker,
        label:  `👤 ${net > 0 ? 'bought' : 'sold'} ${m}`,
        tone:   net > 0 ? 'pos' : 'neg',
      });
    }
  }

  if (e.congress) {
    chips.push({
      kind:   'congress',
      ticker: e.congress.ticker,
      label:  `🏛️ ${e.congress.count} congress trade${e.congress.count === 1 ? '' : 's'}`,
      tone:   'neu',
    });
  }

  if (e.earnings) {
    const dt = new Date(e.earnings.next_date);
    const days = Math.max(0, Math.round((dt - Date.now()) / 86400000));
    chips.push({
      kind:   'earnings',
      ticker: e.earnings.ticker,
      label:  days === 0 ? `📊 earnings today` : `📊 earnings in ${days}d`,
      tone:   'neu',
    });
  }

  return chips;
}
