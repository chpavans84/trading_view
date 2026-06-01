#!/usr/bin/env node
/**
 * scripts/backfill-mover-retrospective.mjs
 *
 * Populate mover_retrospective + mover_signals tables.
 *
 * For each trading day in the requested window:
 *   1. Find every symbol that closed ≥+3% or ≤-3% vs prior close (from backtest_prices)
 *   2. Enrich with sector / volume_vs_avg / market_cap_band (from tradable_universe)
 *   3. Compute sector_etf_move_pct (XLK / XLF / XLV / etc.) for the same day
 *   4. Left-join every signal source (news / UW flow / insider / congress / bot / earnings)
 *   5. Compute primary_signal verdict + signal_coverage_window tier
 *   6. INSERT into both tables (idempotent — ON CONFLICT DO NOTHING)
 *
 * Usage:
 *   node scripts/backfill-mover-retrospective.mjs              # last 365 days (default)
 *   node scripts/backfill-mover-retrospective.mjs --days 30    # last 30 days
 *   node scripts/backfill-mover-retrospective.mjs --from 2026-01-01 --to 2026-05-29
 *   node scripts/backfill-mover-retrospective.mjs --resume     # skip dates already done
 *
 * Designed to be safe to kill and restart. Each date is independent.
 */

import '../src/core/env-loader.js';
import { query, initDb } from '../src/core/db.js';

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const hasFlag = (name) => args.includes(`--${name}`);

const DAYS_BACK = parseInt(getArg('days', '365'), 10);
const FROM      = getArg('from');
const TO        = getArg('to');
const RESUME    = hasFlag('resume');
const VERBOSE   = hasFlag('verbose');

// ─── Constants ────────────────────────────────────────────────────────────────
const MOVE_THRESHOLD_PCT = 3.0;
const CHUNK_SIZE_DAYS    = 7;          // process 1 week at a time (balances memory vs progress)

// SPDR sector ETFs for sector_etf_move_pct lookup
const SECTOR_TO_ETF = {
  'Technology':              'XLK',
  'Financial Services':      'XLF',
  'Healthcare':              'XLV',
  'Consumer Cyclical':       'XLY',
  'Communication Services':  'XLC',
  'Industrials':             'XLI',
  'Consumer Defensive':      'XLP',
  'Energy':                  'XLE',
  'Utilities':               'XLU',
  'Basic Materials':         'XLB',
  'Real Estate':             'XLRE',
};

// Signal coverage windows (days back from today)
const COVERAGE_FULL_DAYS    = 10;     // news + uw_flow have data
const COVERAGE_PARTIAL_DAYS = 150;    // insider + congress + bot still have data

function _bandFromMarketCap(usd) {
  if (!usd) return null;
  if (usd >= 200_000_000_000) return 'mega';
  if (usd >=  10_000_000_000) return 'large';
  if (usd >=   2_000_000_000) return 'mid';
  if (usd >=     300_000_000) return 'small';
  return 'micro';
}

function _coverageWindow(date, today) {
  const ageDays = Math.floor((today - date) / 86_400_000);
  if (ageDays <= COVERAGE_FULL_DAYS)    return 'full';
  if (ageDays <= COVERAGE_PARTIAL_DAYS) return 'partial';
  return 'sparse';
}

// ─── Per-chunk processing ────────────────────────────────────────────────────
async function processChunk(fromDate, toDate, today) {
  if (VERBOSE) console.log(`\n[backfill] chunk ${fromDate} → ${toDate}`);

  // 1. Pull all ±3% movers in the window from backtest_prices.
  //    Join with previous day's close to compute pct change.
  //    Filter to symbols in tradable_universe (excludes junk tickers).
  const { rows: moversRaw } = await query(`
    WITH today_prev AS (
      SELECT a.symbol, a.price_date, a.close, a.volume,
             LAG(a.close) OVER (PARTITION BY a.symbol ORDER BY a.price_date) AS prev_close
        FROM backtest_prices a
       WHERE a.price_date BETWEEN $1::date - INTERVAL '5 days' AND $2::date
    )
    SELECT t.symbol, t.price_date, t.prev_close, t.close, t.volume,
           ((t.close - t.prev_close) / NULLIF(t.prev_close, 0) * 100)::numeric(8,2) AS chg_pct,
           u.sector, u.market_cap_usd, u.avg_volume_30d
      FROM today_prev t
      JOIN tradable_universe u ON u.symbol = t.symbol
     WHERE t.price_date BETWEEN $1::date AND $2::date
       AND t.prev_close IS NOT NULL
       AND ABS((t.close - t.prev_close) / NULLIF(t.prev_close, 0) * 100) >= $3
  `, [fromDate, toDate, MOVE_THRESHOLD_PCT]);

  if (!moversRaw.length) {
    if (VERBOSE) console.log(`[backfill] chunk ${fromDate}→${toDate}: 0 movers`);
    return { movers: 0 };
  }

  // 2. Sector ETF moves per day (for sector_etf_move_pct enrichment)
  const dates    = [...new Set(moversRaw.map(r => (typeof r.price_date === 'string' ? r.price_date : r.price_date.toISOString()).slice(0, 10)))];
  const etfs     = [...new Set(Object.values(SECTOR_TO_ETF))];
  const { rows: etfRows } = await query(`
    WITH prev AS (
      SELECT symbol, price_date, close,
             LAG(close) OVER (PARTITION BY symbol ORDER BY price_date) AS prev_close
        FROM backtest_prices
       WHERE symbol = ANY($1::text[])
         AND price_date BETWEEN $2::date - INTERVAL '5 days' AND $3::date
    )
    SELECT symbol, price_date,
           ((close - prev_close) / NULLIF(prev_close, 0) * 100)::numeric(8,2) AS chg_pct
      FROM prev
     WHERE price_date BETWEEN $2::date AND $3::date AND prev_close IS NOT NULL
  `, [etfs, fromDate, toDate]);
  const etfMoveByDateETF = new Map();
  for (const r of etfRows) {
    const ds = (typeof r.price_date === 'string' ? r.price_date : r.price_date.toISOString()).slice(0, 10);
    etfMoveByDateETF.set(`${ds}::${r.symbol}`, r.chg_pct);
  }

  // 3. Bulk insert mover_retrospective rows (idempotent)
  const insertedIds = [];
  for (const m of moversRaw) {
    const dir = Number(m.chg_pct) >= 0 ? 'UP' : 'DOWN';
    const dateStr = (typeof m.price_date === 'string' ? m.price_date : m.price_date.toISOString()).slice(0, 10);
    const etf = SECTOR_TO_ETF[m.sector] || null;
    const sectorEtfMove = etf ? etfMoveByDateETF.get(`${dateStr}::${etf}`) ?? null : null;
    const volRatio = m.avg_volume_30d && Number(m.avg_volume_30d) > 0
      ? +(Number(m.volume) / Number(m.avg_volume_30d)).toFixed(2)
      : null;

    const { rows: idRows } = await query(`
      INSERT INTO mover_retrospective
        (price_date, symbol, direction, prev_close, close, chg_pct,
         volume, volume_vs_30d_avg, sector, sector_etf_move_pct, market_cap_band)
      VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (price_date, symbol, direction) DO NOTHING
      RETURNING id, price_date, symbol
    `, [
      dateStr, m.symbol, dir, m.prev_close, m.close, m.chg_pct,
      m.volume, volRatio, m.sector, sectorEtfMove,
      _bandFromMarketCap(m.market_cap_usd ? Number(m.market_cap_usd) : null),
    ]);
    if (idRows[0]) insertedIds.push({ id: idRows[0].id, date: dateStr, symbol: m.symbol });
  }

  if (!insertedIds.length) return { movers: moversRaw.length, inserted: 0 };

  // 4. Build signal-context per inserted row, then bulk INSERT mover_signals
  let signalsWritten = 0;
  for (const { id, date, symbol } of insertedIds) {
    const sig = await buildSignals(symbol, date, today);
    await query(`
      INSERT INTO mover_signals
        (mover_id, had_earnings_in_window, earnings_date,
         news_count_24h, news_sentiment, news_categories, top_headline,
         uw_flow_premium_24h, uw_flow_sentiment, uw_flow_largest,
         insider_buys_30d_value, insider_sells_30d_value, insider_net_signal,
         congress_activity_30d, congress_details,
         bot_conviction_score, bot_grade, bot_action, bot_in_daily_picks,
         primary_signal, signal_coverage_window, caught_by_bot)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19, $20, $21, $22)
      ON CONFLICT (mover_id) DO NOTHING
    `, [
      id,
      sig.had_earnings, sig.earnings_date,
      sig.news_count, sig.news_sentiment, sig.news_categories, sig.top_headline,
      sig.uw_flow_premium, sig.uw_flow_sentiment, sig.uw_flow_largest,
      sig.insider_buys_value, sig.insider_sells_value, sig.insider_net,
      sig.congress_activity, sig.congress_details ? JSON.stringify(sig.congress_details) : null,
      sig.bot_score, sig.bot_grade, sig.bot_action, sig.bot_in_picks,
      sig.primary_signal, _coverageWindow(new Date(date), today), sig.caught_by_bot,
    ]);
    signalsWritten++;
  }

  return { movers: moversRaw.length, inserted: insertedIds.length, signals: signalsWritten };
}

// ─── Signal enrichment per (symbol, date) ────────────────────────────────────
async function buildSignals(symbol, dateStr, today) {
  const dayStart = `${dateStr} 00:00:00`;
  const dayEnd   = `${dateStr} 23:59:59`;

  // All 6 queries in parallel — independent, allSettled-safe
  const [earnRes, newsRes, flowRes, insRes, congRes, botRes] = await Promise.allSettled([

    // Earnings: any earnings date within ±1 day window? (Use fundamentals.period_end)
    query(`
      SELECT period_end FROM fundamentals
       WHERE symbol = $1
         AND period_end BETWEEN $2::date - INTERVAL '1 day' AND $2::date + INTERVAL '1 day'
       ORDER BY period_end DESC LIMIT 1
    `, [symbol, dateStr]),

    // Benzinga news: published in 24h before market close on the move date
    query(`
      SELECT COUNT(*)::int AS n,
             MODE() WITHIN GROUP (ORDER BY sentiment) AS dominant_sentiment,
             (ARRAY_AGG(title ORDER BY published_at DESC))[1] AS top_title,
             ARRAY_AGG(DISTINCT channels::text) AS channels_arr
        FROM benzinga_news
       WHERE tickers ? $1
         AND published_at BETWEEN $2::timestamptz - INTERVAL '24 hours' AND $3::timestamptz
    `, [symbol, dayStart, dayEnd]),

    // UW flow: sum of premium in 24h before close
    query(`
      SELECT COALESCE(SUM(premium), 0)::numeric AS total_premium,
             MAX(premium)::numeric AS largest,
             MODE() WITHIN GROUP (ORDER BY sentiment) AS dominant_sentiment
        FROM uw_flow_alerts
       WHERE ticker = $1
         AND alerted_at BETWEEN $2::timestamptz - INTERVAL '24 hours' AND $3::timestamptz
    `, [symbol, dayStart, dayEnd]),

    // UW insider: net buys vs sells in last 30 days BEFORE the move date
    query(`
      SELECT
        COALESCE(SUM(CASE WHEN transaction_type = 'P' THEN value ELSE 0 END), 0)::numeric AS buys,
        COALESCE(SUM(CASE WHEN transaction_type = 'S' THEN value ELSE 0 END), 0)::numeric AS sells
        FROM uw_insider_trades
       WHERE ticker = $1
         AND filed_at BETWEEN $2::timestamptz - INTERVAL '30 days' AND $3::timestamptz
    `, [symbol, dayStart, dayEnd]),

    // UW congress: any disclosure in last 30 days before the move
    query(`
      SELECT
        member_name, party, chamber, transaction_type, amount_range, traded_at, filed_at
        FROM uw_congressional_trades
       WHERE ticker = $1
         AND filed_at BETWEEN $2::timestamptz - INTERVAL '30 days' AND $3::timestamptz
       ORDER BY filed_at DESC LIMIT 5
    `, [symbol, dayStart, dayEnd]),

    // Bot signal: conviction score on or just before the move date
    query(`
      SELECT score, grade FROM conviction_scores
       WHERE symbol = $1
         AND scored_at BETWEEN $2::timestamptz - INTERVAL '24 hours' AND $3::timestamptz
       ORDER BY scored_at DESC LIMIT 1
    `, [symbol, dayStart, dayEnd]),
  ]);

  // Unpack
  const earnRow  = earnRes.status  === 'fulfilled' ? earnRes.value.rows[0]  : null;
  const newsRow  = newsRes.status  === 'fulfilled' ? newsRes.value.rows[0]  : null;
  const flowRow  = flowRes.status  === 'fulfilled' ? flowRes.value.rows[0]  : null;
  const insRow   = insRes.status   === 'fulfilled' ? insRes.value.rows[0]   : null;
  const congRows = congRes.status  === 'fulfilled' ? congRes.value.rows     : [];
  const botRow   = botRes.status   === 'fulfilled' ? botRes.value.rows[0]   : null;

  // Decode insider net signal
  const buys  = insRow ? Number(insRow.buys || 0)  : 0;
  const sells = insRow ? Number(insRow.sells || 0) : 0;
  const insiderNet = buys >= 100_000 && buys > sells * 1.5  ? 'buying'
                   : sells >= 100_000 && sells > buys * 1.5 ? 'selling'
                   : null;

  // Decode news categories from channels arrays
  let categories = null;
  if (newsRow?.channels_arr?.length) {
    const allCh = newsRow.channels_arr.join(' ').toLowerCase();
    const cats = [];
    if (/m&a|merger|acquisition|takeover/.test(allCh))     cats.push('m&a');
    if (/fda|clinical|approval/.test(allCh))                cats.push('fda');
    if (/contract|government|pentagon/.test(allCh))          cats.push('govt');
    if (/upgrade|price target/.test(allCh))                  cats.push('analyst');
    if (/spinoff|ipo|buyback/.test(allCh))                   cats.push('corporate');
    if (cats.length) categories = cats;
  }

  const flowPrem = flowRow ? Number(flowRow.total_premium || 0) : 0;
  const newsN    = newsRow ? Number(newsRow.n || 0) : 0;
  const congActive = congRows.length > 0;
  const botBuy = botRow && Number(botRow.score) >= 70;

  // ─── primary_signal verdict (priority: earnings > news_ma > uw_flow > insider > congress > sector > unknown) ─
  let primary = 'unknown';
  if (earnRow)                                             primary = 'earnings';
  else if (newsN > 0 && categories?.includes('m&a'))       primary = 'news_ma';
  else if (newsN > 0 && categories?.includes('fda'))       primary = 'news_fda';
  else if (newsN > 0 && categories?.includes('govt'))      primary = 'news_govt';
  else if (newsN > 0)                                      primary = 'news_other';
  else if (flowPrem >= 500_000)                            primary = 'uw_flow';
  else if (insiderNet === 'buying' || insiderNet === 'selling') primary = 'insider';
  else if (congActive)                                     primary = 'congress';
  // (sector and unknown handled implicitly by leaving primary='unknown'; UI can drill into sector_etf_move_pct)

  return {
    had_earnings:     !!earnRow,
    earnings_date:    earnRow?.period_end ?? null,
    news_count:       newsN,
    news_sentiment:   newsRow?.dominant_sentiment ?? null,
    news_categories:  categories,
    top_headline:     newsRow?.top_title?.slice(0, 500) ?? null,
    uw_flow_premium:  flowPrem || null,
    uw_flow_sentiment: flowRow?.dominant_sentiment ?? null,
    uw_flow_largest:  flowRow?.largest ? Number(flowRow.largest) : null,
    insider_buys_value:  buys || null,
    insider_sells_value: sells || null,
    insider_net:      insiderNet,
    congress_activity: congActive,
    congress_details:  congActive ? congRows : null,
    bot_score:        botRow?.score ?? null,
    bot_grade:        botRow?.grade ?? null,
    bot_action:       botBuy ? 'BUY' : (botRow?.score >= 50 ? 'NEAR' : botRow ? 'WATCH' : null),
    bot_in_picks:     null,   // would need daily_picks join — skipped for now (sparse 30d only)
    primary_signal:   primary,
    caught_by_bot:    botBuy === true,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  await initDb();

  // Compute date window
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

  const fromDate = new Date(from);
  const toDate   = new Date(to);
  const today    = new Date();
  const totalDays = Math.ceil((toDate - fromDate) / 86_400_000) + 1;

  console.log(`[backfill] window: ${from} → ${to} (${totalDays} days)`);
  console.log(`[backfill] threshold: ±${MOVE_THRESHOLD_PCT}% close-to-close`);
  console.log(`[backfill] chunk size: ${CHUNK_SIZE_DAYS} days`);

  // Optional resume mode: skip dates that already have >0 mover rows
  let alreadyDone = new Set();
  if (RESUME) {
    const { rows } = await query(`
      SELECT DISTINCT price_date FROM mover_retrospective
       WHERE price_date BETWEEN $1::date AND $2::date
    `, [from, to]);
    alreadyDone = new Set(rows.map(r => (typeof r.price_date === 'string' ? r.price_date : r.price_date.toISOString()).slice(0, 10)));
    console.log(`[backfill] resume mode — skipping ${alreadyDone.size} dates already processed`);
  }

  // Process in CHUNK_SIZE_DAYS chunks (most recent first so we get newest data quickly)
  const tStart = Date.now();
  let totalMovers = 0, totalInserted = 0;

  for (let dayOffset = 0; dayOffset < totalDays; dayOffset += CHUNK_SIZE_DAYS) {
    const chunkEnd = new Date(toDate);
    chunkEnd.setDate(toDate.getDate() - dayOffset);
    const chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkEnd.getDate() - (CHUNK_SIZE_DAYS - 1));
    if (chunkStart < fromDate) chunkStart.setTime(fromDate.getTime());

    const chunkFromStr = chunkStart.toISOString().slice(0, 10);
    const chunkToStr   = chunkEnd.toISOString().slice(0, 10);

    // Skip if all dates in chunk are already done (resume mode)
    if (RESUME) {
      let allDone = true;
      const cur = new Date(chunkStart);
      while (cur <= chunkEnd) {
        if (!alreadyDone.has(cur.toISOString().slice(0, 10))) { allDone = false; break; }
        cur.setDate(cur.getDate() + 1);
      }
      if (allDone) { console.log(`[backfill] skip ${chunkFromStr}→${chunkToStr} (resume)`); continue; }
    }

    const tChunk = Date.now();
    const r = await processChunk(chunkFromStr, chunkToStr, today);
    const dur = Math.round((Date.now() - tChunk) / 1000);

    totalMovers   += r.movers   || 0;
    totalInserted += r.inserted || 0;

    console.log(`[backfill] ${chunkFromStr} → ${chunkToStr}: ` +
                `${r.movers || 0} movers, ${r.inserted || 0} new rows, ${r.signals || 0} signals (${dur}s)`);
  }

  const totalDur = Math.round((Date.now() - tStart) / 60);
  console.log(`\n[backfill] DONE — ${totalInserted} rows inserted from ${totalMovers} movers in ${totalDur}m`);
  process.exit(0);
}

main().catch(e => { console.error('[backfill] FATAL:', e); process.exit(1); });
