#!/usr/bin/env node
/**
 * src/research/screener-backfill.js
 *
 * One-shot backfill for the Screener tab. Runs in three modes:
 *
 *   npm run screener:sectors        — fill sector + industry + company_name + country
 *                                     (Yahoo `assetProfile` + `summaryProfile`)
 *   npm run screener:fundamentals   — fill P/E, EPS, dividend yield, beta, ROE,
 *                                     profit margin, growth metrics (Yahoo
 *                                     `summaryDetail` + `defaultKeyStatistics` +
 *                                     `financialData`)
 *   npm run screener:snapshot       — refresh last_price, day_change_pct,
 *                                     day_volume, market_cap_usd, week_52_high/low
 *                                     for ALL tickers (Yahoo `quote()` batch)
 *   npm run screener:technicals     — recompute RSI/SMA/52w from backtest_prices
 *                                     into screener_technicals
 *   npm run screener:all            — runs them in order (default)
 *
 * Design choices:
 *   - Resumable: every row writes back with a `*_synced_at` timestamp, so
 *     re-running picks up from where it left off (skips rows synced in the last
 *     7 days for sectors, 24h for snapshot).
 *   - Throttled: p-limit at concurrency 6 (Yahoo's soft ceiling). Sleep 250ms
 *     between batches. Backs off to 1s on 429.
 *   - Checkpointed: progress prints every 50 rows so you can see it's working
 *     and resume by ctrl-C + restart.
 *   - Idempotent: ON CONFLICT updates everywhere, so reruns are safe.
 *   - Logs everything to console; pipe to a file when running in background.
 */

import 'dotenv/config';
import { query, isDbAvailable, initDb } from '../core/db.js';
import YahooFinance from 'yahoo-finance2';
import pLimit from 'p-limit';

const yf = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

// Tune these if Yahoo gets cranky
const CONCURRENCY    = 6;
const BATCH_SLEEP_MS = 200;
const RETRY_SLEEP_MS = 2500;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Helpers ────────────────────────────────────────────────────────────────
function clampPct(n) {
  // Yahoo returns dividendYield as decimal (0.025) — we want 0.025 (4-digit
  // precision); profitMargins as decimal too. Just clamp to (-10, +10) so a
  // wonky value doesn't blow the column's NUMERIC(6,4).
  if (n == null || isNaN(n)) return null;
  const x = Number(n);
  if (x < -10 || x > 10) return null;
  return x;
}
function clampPe(n) {
  // P/Es over 9999 are basically garbage (Yahoo returns 99999 for unprofitable
  // companies). Cap at NUMERIC(10,2) range.
  if (n == null || isNaN(n)) return null;
  const x = Number(n);
  if (x < -9999 || x > 9999) return null;
  return x;
}
function clampBeta(n) {
  if (n == null || isNaN(n)) return null;
  const x = Number(n);
  if (x < -99 || x > 99) return null;
  return x;
}

async function withRetry(fn, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e?.message || '';
      const transient = /429|too many|timeout|ECONN|ETIMEDOUT|ENOTFOUND|getaddrinfo/i.test(msg);
      if (!transient || attempt === 2) throw e;
      console.warn(`  retry ${attempt + 1}/3 for ${label}: ${msg.slice(0, 80)}`);
      await sleep(RETRY_SLEEP_MS * (attempt + 1));
    }
  }
}

// ── Mode 1: SECTOR + INDUSTRY + COMPANY NAME (Yahoo assetProfile) ─────────
async function backfillSectors({ refreshDays = 30, onlyMissing = false } = {}) {
  console.log(`[sectors] starting — refreshDays=${refreshDays} onlyMissing=${onlyMissing}`);
  const { rows } = await query(`
    SELECT symbol
    FROM tradable_universe
    WHERE ${onlyMissing
      ? 'sector IS NULL'
      : `(sector IS NULL OR sector_synced_at < NOW() - ($1 || ' days')::INTERVAL)`}
    ORDER BY market_cap_usd DESC NULLS LAST
  `, onlyMissing ? [] : [refreshDays]);

  console.log(`[sectors] ${rows.length} tickers need a refresh`);
  const limit = pLimit(CONCURRENCY);
  let done = 0, ok = 0, miss = 0, err = 0;

  await Promise.all(rows.map(({ symbol }) => limit(async () => {
    try {
      const r = await withRetry(
        () => yf.quoteSummary(symbol, { modules: ['assetProfile', 'summaryProfile', 'price'] }),
        symbol
      );
      const p = r?.assetProfile || r?.summaryProfile || {};
      const sector   = p.sector   || null;
      const industry = p.industry || null;
      const country  = p.country  || null;
      const name     = r?.price?.longName || r?.price?.shortName || null;

      if (!sector && !industry && !name) { miss++; }
      else {
        await query(`
          UPDATE tradable_universe
          SET sector = COALESCE($2, sector),
              industry = COALESCE($3, industry),
              country = COALESCE($4, country),
              company_name = COALESCE($5, company_name),
              sector_synced_at = NOW()
          WHERE symbol = $1
        `, [symbol, sector, industry, country, name]);
        ok++;
      }
    } catch (e) {
      err++;
      if (err <= 5) console.warn(`[sectors] ${symbol} failed: ${e.message?.slice(0, 80)}`);
    }
    done++;
    if (done % 50 === 0) {
      console.log(`[sectors] ${done}/${rows.length}  ok=${ok} miss=${miss} err=${err}`);
      await sleep(BATCH_SLEEP_MS);
    }
  })));

  console.log(`[sectors] DONE — total=${rows.length} ok=${ok} miss=${miss} err=${err}`);
}

// ── Mode 2: FUNDAMENTALS (P/E, EPS, dividend, beta, ROE, margins, growth) ──
async function backfillFundamentals({ refreshDays = 7, onlyMissing = false } = {}) {
  console.log(`[fund] starting — refreshDays=${refreshDays} onlyMissing=${onlyMissing}`);
  const { rows } = await query(`
    SELECT symbol
    FROM tradable_universe
    WHERE ${onlyMissing
      ? 'fundamentals_synced_at IS NULL'
      : `(fundamentals_synced_at IS NULL OR fundamentals_synced_at < NOW() - ($1 || ' days')::INTERVAL)`}
      AND (market_cap_usd IS NULL OR market_cap_usd > 100000000)  -- skip tiny pennies
    ORDER BY market_cap_usd DESC NULLS LAST
  `, onlyMissing ? [] : [refreshDays]);

  console.log(`[fund] ${rows.length} tickers need a refresh`);
  const limit = pLimit(CONCURRENCY);
  let done = 0, ok = 0, miss = 0, err = 0;

  await Promise.all(rows.map(({ symbol }) => limit(async () => {
    try {
      const r = await withRetry(
        () => yf.quoteSummary(symbol, {
          modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData', 'price'],
        }),
        symbol
      );
      const sd = r?.summaryDetail        || {};
      const ks = r?.defaultKeyStatistics || {};
      const fd = r?.financialData        || {};

      const pe          = clampPe(sd.trailingPE         ?? ks.trailingPE);
      const forwardPe   = clampPe(sd.forwardPE          ?? ks.forwardPE);
      const eps         = clampPe(ks.trailingEps        ?? sd.epsTrailingTwelveMonths);
      const divYield    = clampPct(sd.dividendYield);
      const beta        = clampBeta(sd.beta             ?? ks.beta);
      const roe         = clampPct(fd.returnOnEquity);
      const margin      = clampPct(fd.profitMargins     ?? ks.profitMargins);
      const revGrowth   = clampPct(fd.revenueGrowth);
      const earnGrowth  = clampPct(fd.earningsGrowth    ?? ks.earningsQuarterlyGrowth);

      const anyData = pe || forwardPe || eps || divYield || beta || roe || margin || revGrowth || earnGrowth;
      if (!anyData) { miss++; }
      else {
        await query(`
          UPDATE tradable_universe
          SET pe_ratio        = COALESCE($2,  pe_ratio),
              forward_pe      = COALESCE($3,  forward_pe),
              eps_ttm         = COALESCE($4,  eps_ttm),
              dividend_yield  = COALESCE($5,  dividend_yield),
              beta            = COALESCE($6,  beta),
              roe             = COALESCE($7,  roe),
              profit_margin   = COALESCE($8,  profit_margin),
              revenue_growth  = COALESCE($9,  revenue_growth),
              earnings_growth = COALESCE($10, earnings_growth),
              fundamentals_synced_at = NOW()
          WHERE symbol = $1
        `, [symbol, pe, forwardPe, eps, divYield, beta, roe, margin, revGrowth, earnGrowth]);
        ok++;
      }
    } catch (e) {
      err++;
      if (err <= 5) console.warn(`[fund] ${symbol} failed: ${e.message?.slice(0, 80)}`);
    }
    done++;
    if (done % 50 === 0) {
      console.log(`[fund] ${done}/${rows.length}  ok=${ok} miss=${miss} err=${err}`);
      await sleep(BATCH_SLEEP_MS);
    }
  })));

  console.log(`[fund] DONE — total=${rows.length} ok=${ok} miss=${miss} err=${err}`);
}

// ── Mode 3: DAILY SNAPSHOT (price, day_change, volume, mcap, 52w hi/lo) ────
async function refreshSnapshot() {
  console.log('[snap] starting daily snapshot refresh');
  // Pull every symbol — we want fresh prices on the whole universe
  const { rows } = await query(`SELECT symbol FROM tradable_universe ORDER BY market_cap_usd DESC NULLS LAST`);
  console.log(`[snap] ${rows.length} tickers`);

  // Yahoo `quote()` accepts ARRAYS. Tested batch sizes: 200 works, 250 sometimes 400s.
  const BATCH = 150;
  let done = 0, ok = 0, miss = 0, err = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map(r => r.symbol);
    try {
      const quotes = await withRetry(() => yf.quote(batch), `batch[${i}]`);
      const list = Array.isArray(quotes) ? quotes : [quotes];
      // Upsert one row per symbol
      for (const q of list) {
        if (!q?.symbol) { miss++; continue; }
        const price   = q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice ?? null;
        const chg     = q.regularMarketChangePercent != null ? Number(q.regularMarketChangePercent) : null;
        const vol     = q.regularMarketVolume ?? q.averageDailyVolume3Month ?? null;
        const mcap    = q.marketCap ?? null;
        const w52hi   = q.fiftyTwoWeekHigh ?? null;
        const w52lo   = q.fiftyTwoWeekLow  ?? null;
        await query(`
          UPDATE tradable_universe
          SET last_price       = COALESCE($2, last_price),
              day_change_pct   = COALESCE($3, day_change_pct),
              day_volume       = COALESCE($4, day_volume),
              market_cap_usd   = COALESCE($5, market_cap_usd),
              week_52_high     = COALESCE($6, week_52_high),
              week_52_low      = COALESCE($7, week_52_low),
              price_synced_at  = NOW()
          WHERE symbol = $1
        `, [q.symbol, price, chg, vol, mcap, w52hi, w52lo]);
        ok++;
      }
    } catch (e) {
      err += batch.length;
      console.warn(`[snap] batch[${i}] failed: ${e.message?.slice(0, 80)}`);
    }
    done += batch.length;
    if (done % 600 === 0) console.log(`[snap] ${done}/${rows.length}  ok=${ok} miss=${miss} err=${err}`);
    await sleep(BATCH_SLEEP_MS);
  }
  console.log(`[snap] DONE — total=${rows.length} ok=${ok} miss=${miss} err=${err}`);
}

// ── Mode 4: TECHNICALS (RSI/SMA/52w from local backtest_prices) ──────────
function calcSMA(closes, n) {
  if (closes.length < n) return null;
  const slice = closes.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}
function calcRSI(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gains = 0, losses = 0;
  // Wilder's smoothing — first n bars set the baseline
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / n) / (losses / n);
  return 100 - 100 / (1 + rs);
}
function calcATRPct(highs, lows, closes, n = 14) {
  if (closes.length < n + 1) return null;
  let atr = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1]),
    );
    atr += tr;
  }
  atr /= n;
  return (atr / closes[closes.length - 1]) * 100;
}
function pctReturn(closes, lookback) {
  if (closes.length < lookback + 1) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - lookback];
  if (!then) return null;
  return ((now - then) / then) * 100;
}

async function computeTechnicals() {
  console.log('[tech] computing technicals from backtest_prices');
  // Pull all distinct symbols with at least 250 days of data
  const { rows: syms } = await query(`
    SELECT symbol, COUNT(*) AS days
    FROM backtest_prices
    GROUP BY symbol
    HAVING COUNT(*) >= 50
    ORDER BY symbol
  `);
  console.log(`[tech] ${syms.length} symbols have ≥50 days of price history`);

  const limit = pLimit(8);
  let done = 0, ok = 0;
  const today = new Date();
  const ytdStart = new Date(today.getFullYear(), 0, 1);

  await Promise.all(syms.map(({ symbol }) => limit(async () => {
    try {
      const { rows } = await query(`
        SELECT price_date, open, high, low, close, volume
        FROM backtest_prices
        WHERE symbol = $1
        ORDER BY price_date ASC
        LIMIT 500
      `, [symbol]);
      if (rows.length < 50) return;

      const closes = rows.map(r => Number(r.close));
      const highs  = rows.map(r => Number(r.high));
      const lows   = rows.map(r => Number(r.low));
      const vols   = rows.map(r => Number(r.volume));
      const dates  = rows.map(r => r.price_date);
      const last   = closes[closes.length - 1];
      const lastDate = dates[dates.length - 1];

      const sma20  = calcSMA(closes, 20);
      const sma50  = calcSMA(closes, 50);
      const sma200 = calcSMA(closes, 200);
      const rsi    = calcRSI(closes, 14);
      const atrPct = calcATRPct(highs, lows, closes, 14);
      const w52hi  = Math.max(...closes.slice(-252));
      const w52lo  = Math.min(...closes.slice(-252));
      const pctH   = w52hi ? ((last - w52hi) / w52hi) * 100 : null;
      const pctL   = w52lo ? ((last - w52lo) / w52lo) * 100 : null;
      const r5d    = pctReturn(closes, 5);
      const r1m    = pctReturn(closes, 21);
      const r3m    = pctReturn(closes, 63);
      const r6m    = pctReturn(closes, 126);

      // YTD return — find the index closest to Jan 1.
      // FIXED 2026-06-01: ytdIdx >= 0 (not > 0). A valid index of 0 was
      // previously treated as "not found", silently dropping YTD calculation
      // for any stock whose first row in the slice happens to be on/after Jan 1.
      let ytdIdx = rows.findIndex(r => new Date(r.price_date) >= ytdStart);
      const ytd = ytdIdx >= 0 ? ((last - closes[ytdIdx]) / closes[ytdIdx]) * 100 : null;

      // Recent vs 30d avg volume → RVOL (last 5d avg / prior 30d avg)
      const recent5 = vols.slice(-5);
      const prior30 = vols.slice(-35, -5);
      const recent5Avg = recent5.reduce((a, b) => a + b, 0) / recent5.length;
      const prior30Avg = prior30.length ? prior30.reduce((a, b) => a + b, 0) / prior30.length : 0;
      const rvol = prior30Avg > 0 ? recent5Avg / prior30Avg : null;

      const goldenCross = sma50 != null && sma200 != null && sma50 > sma200;
      const aboveS50    = sma50 != null  ? last > sma50  : null;
      const aboveS200   = sma200 != null ? last > sma200 : null;

      await query(`
        INSERT INTO screener_technicals (
          symbol, last_close, last_close_date,
          sma_20, sma_50, sma_200, rsi_14, atr_14_pct, rvol_30d,
          week_52_high, week_52_low, pct_from_52w_high, pct_from_52w_low,
          ret_5d, ret_1m, ret_3m, ret_6m, ret_ytd,
          above_sma_50, above_sma_200, golden_cross, computed_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
        ON CONFLICT (symbol) DO UPDATE SET
          last_close = EXCLUDED.last_close, last_close_date = EXCLUDED.last_close_date,
          sma_20 = EXCLUDED.sma_20, sma_50 = EXCLUDED.sma_50, sma_200 = EXCLUDED.sma_200,
          rsi_14 = EXCLUDED.rsi_14, atr_14_pct = EXCLUDED.atr_14_pct, rvol_30d = EXCLUDED.rvol_30d,
          week_52_high = EXCLUDED.week_52_high, week_52_low = EXCLUDED.week_52_low,
          pct_from_52w_high = EXCLUDED.pct_from_52w_high, pct_from_52w_low = EXCLUDED.pct_from_52w_low,
          ret_5d = EXCLUDED.ret_5d, ret_1m = EXCLUDED.ret_1m, ret_3m = EXCLUDED.ret_3m,
          ret_6m = EXCLUDED.ret_6m, ret_ytd = EXCLUDED.ret_ytd,
          above_sma_50 = EXCLUDED.above_sma_50, above_sma_200 = EXCLUDED.above_sma_200,
          golden_cross = EXCLUDED.golden_cross, computed_at = NOW()
      `, [
        symbol, last, lastDate,
        sma20, sma50, sma200, rsi, atrPct, rvol,
        w52hi, w52lo, pctH, pctL,
        r5d, r1m, r3m, r6m, ytd,
        aboveS50, aboveS200, goldenCross,
      ]);
      ok++;
    } catch (e) {
      console.warn(`[tech] ${symbol} failed: ${e.message?.slice(0, 80)}`);
    }
    done++;
    if (done % 100 === 0) console.log(`[tech] ${done}/${syms.length}  ok=${ok}`);
  })));
  console.log(`[tech] DONE — total=${syms.length} ok=${ok}`);
}

// ── Mode 5: SIGNALS — populate sparkline + signal_tags from existing tables ──
// All sources are local DB queries, no network. Fast: 8K rows in ~30 sec.
//
// Signal weighting (signal_score column, higher = more interesting):
//   👤 insider buy ≥ $250K, last 30d        +25
//   👤 insider buy ≥ $1M,   last 30d        +35 (caps replace prior)
//   🐋 bullish UW flow ≥ $200K, last 7d      +20
//   🐋 bullish UW flow ≥ $1M,   last 7d      +30
//   🏛️ congress trade, last 90d              +10
//   📊 earnings in next 3-14d                +15
//   🐂 conviction grade A                    +20
//   🐂 conviction grade B                    +10
//   🚀 within 3% of 52w high                 +10
//   📉 RSI < 30 AND above SMA 200            +15 (mean-reversion-in-trend)
//   ⚡ day move > +5% on RVOL > 1.5x         +10
async function backfillSignals() {
  console.log('[signals] starting — populating sparklines + signal tags');

  // ── Sparklines: last 30 closes per symbol from backtest_prices ──────────
  // One pass, batched insert via a temp aggregation
  console.log('[signals] computing sparklines from backtest_prices...');
  const { rows: sparkRows } = await query(`
    WITH ranked AS (
      SELECT symbol, close, price_date,
             ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY price_date DESC) AS rn
      FROM backtest_prices
    )
    SELECT symbol,
           JSON_AGG(close ORDER BY price_date ASC) FILTER (WHERE rn <= 30) AS sparkline
    FROM ranked
    WHERE rn <= 30
    GROUP BY symbol
    HAVING COUNT(*) >= 5
  `);
  console.log(`[signals] ${sparkRows.length} symbols have ≥5 days of price history`);

  // Write sparklines in chunks of 500
  const CHUNK = 500;
  for (let i = 0; i < sparkRows.length; i += CHUNK) {
    const chunk = sparkRows.slice(i, i + CHUNK);
    await Promise.all(chunk.map(r =>
      query(`UPDATE tradable_universe SET sparkline = $2 WHERE symbol = $1`,
            [r.symbol, JSON.stringify(r.sparkline)])
    ));
  }
  console.log(`[signals] sparklines written`);

  // ── Conviction grade (latest scored_at per symbol) ──────────────────────
  await query(`
    WITH latest AS (
      SELECT DISTINCT ON (symbol) symbol, score, grade
      FROM conviction_scores
      WHERE scored_at >= NOW() - INTERVAL '14 days'
      ORDER BY symbol, scored_at DESC
    )
    UPDATE tradable_universe u
    SET conviction_grade = l.grade,
        conviction_score = l.score
    FROM latest l
    WHERE u.symbol = l.symbol
  `);

  // ── Insider net buy/sell last 30d ───────────────────────────────────────
  await query(`
    WITH net AS (
      SELECT ticker,
             SUM(CASE WHEN LOWER(transaction_type) LIKE '%buy%'  THEN COALESCE(value,0) ELSE 0 END) -
             SUM(CASE WHEN LOWER(transaction_type) LIKE '%sell%' THEN COALESCE(value,0) ELSE 0 END) AS net_value
      FROM uw_insider_trades
      WHERE filed_at >= NOW() - INTERVAL '30 days'
      GROUP BY ticker
    )
    UPDATE tradable_universe u
    SET insider_net_30d = net.net_value
    FROM net
    WHERE u.symbol = net.ticker
  `);

  // ── UW flow last 7d, biggest premium per symbol ─────────────────────────
  await query(`
    WITH latest AS (
      SELECT DISTINCT ON (ticker)
             ticker, premium, sentiment
      FROM uw_flow_alerts
      WHERE alerted_at >= NOW() - INTERVAL '7 days'
      ORDER BY ticker, premium DESC NULLS LAST
    )
    UPDATE tradable_universe u
    SET flow_premium_7d = latest.premium,
        flow_sentiment  = latest.sentiment
    FROM latest
    WHERE u.symbol = latest.ticker
  `);

  // ── Congress trades count last 90d ──────────────────────────────────────
  await query(`
    WITH cnt AS (
      SELECT ticker, COUNT(*) AS n
      FROM uw_congressional_trades
      WHERE traded_at >= CURRENT_DATE - INTERVAL '90 days'
      GROUP BY ticker
    )
    UPDATE tradable_universe u
    SET congress_count_90d = cnt.n
    FROM cnt
    WHERE u.symbol = cnt.ticker
  `);

  // ── Compute signal_tags + signal_score + signal_count in one update ─────
  // Each WHEN adds to score and pushes a tag — array_remove(NULL) strips empties.
  const { rowCount } = await query(`
    UPDATE tradable_universe u
    SET signal_tags = ARRAY_REMOVE(ARRAY[
      CASE WHEN u.insider_net_30d >= 1000000  THEN 'insider_xl'
           WHEN u.insider_net_30d >= 250000   THEN 'insider'
           END,
      CASE WHEN u.flow_premium_7d >= 1000000  AND (u.flow_sentiment = 'bullish' OR u.flow_sentiment LIKE '%call%') THEN 'flow_xl'
           WHEN u.flow_premium_7d >= 200000   AND (u.flow_sentiment = 'bullish' OR u.flow_sentiment LIKE '%call%') THEN 'flow'
           END,
      CASE WHEN u.congress_count_90d > 0 THEN 'congress' END,
      CASE WHEN u.conviction_grade = 'A' THEN 'grade_a'
           WHEN u.conviction_grade = 'B' THEN 'grade_b' END,
      CASE WHEN t.pct_from_52w_high IS NOT NULL AND t.pct_from_52w_high >= -3 THEN 'near_52w_high' END,
      CASE WHEN t.rsi_14 IS NOT NULL AND t.rsi_14 < 30 AND t.above_sma_200 = true THEN 'mean_reversion' END,
      CASE WHEN u.day_change_pct >= 5 AND t.rvol_30d IS NOT NULL AND t.rvol_30d >= 1.5 THEN 'volume_spike' END
    ], NULL),
    signal_score = (
      CASE WHEN u.insider_net_30d >= 1000000  THEN 35
           WHEN u.insider_net_30d >= 250000   THEN 25 ELSE 0 END +
      CASE WHEN u.flow_premium_7d >= 1000000  AND (u.flow_sentiment = 'bullish' OR u.flow_sentiment LIKE '%call%') THEN 30
           WHEN u.flow_premium_7d >= 200000   AND (u.flow_sentiment = 'bullish' OR u.flow_sentiment LIKE '%call%') THEN 20 ELSE 0 END +
      CASE WHEN u.congress_count_90d > 0 THEN 10 ELSE 0 END +
      CASE WHEN u.conviction_grade = 'A' THEN 20
           WHEN u.conviction_grade = 'B' THEN 10 ELSE 0 END +
      CASE WHEN t.pct_from_52w_high IS NOT NULL AND t.pct_from_52w_high >= -3 THEN 10 ELSE 0 END +
      CASE WHEN t.rsi_14 IS NOT NULL AND t.rsi_14 < 30 AND t.above_sma_200 = true THEN 15 ELSE 0 END +
      CASE WHEN u.day_change_pct >= 5 AND t.rvol_30d IS NOT NULL AND t.rvol_30d >= 1.5 THEN 10 ELSE 0 END
    ),
    signals_synced_at = NOW()
    FROM (SELECT symbol, pct_from_52w_high, rsi_14, above_sma_200, rvol_30d FROM screener_technicals) t
    -- FIXED 2026-06-01: the `OR (t.symbol IS NULL AND u.symbol IS NOT NULL)` clause was a
    -- no-op (subquery never returns NULL symbols) and made the UPDATE's match semantics
    -- confusing. The backstop UPDATE below already handles rows without technicals; here
    -- we only want to update matched rows.
    WHERE u.symbol = t.symbol
  `);
  // Backstop: also update rows without technicals (so signal_tags is at least []
  // instead of NULL — keeps the API contract clean).
  await query(`
    UPDATE tradable_universe
    SET signal_tags = ARRAY_REMOVE(ARRAY[
      CASE WHEN insider_net_30d >= 1000000 THEN 'insider_xl'
           WHEN insider_net_30d >= 250000  THEN 'insider' END,
      CASE WHEN flow_premium_7d >= 1000000 AND (flow_sentiment = 'bullish' OR flow_sentiment LIKE '%call%') THEN 'flow_xl'
           WHEN flow_premium_7d >= 200000  AND (flow_sentiment = 'bullish' OR flow_sentiment LIKE '%call%') THEN 'flow' END,
      CASE WHEN congress_count_90d > 0 THEN 'congress' END,
      CASE WHEN conviction_grade = 'A' THEN 'grade_a'
           WHEN conviction_grade = 'B' THEN 'grade_b' END
    ], NULL),
    signal_score = COALESCE(signal_score, 0) +
      CASE WHEN insider_net_30d >= 1000000 THEN 35 WHEN insider_net_30d >= 250000 THEN 25 ELSE 0 END +
      CASE WHEN flow_premium_7d >= 1000000 AND (flow_sentiment = 'bullish' OR flow_sentiment LIKE '%call%') THEN 30
           WHEN flow_premium_7d >= 200000  AND (flow_sentiment = 'bullish' OR flow_sentiment LIKE '%call%') THEN 20 ELSE 0 END +
      CASE WHEN congress_count_90d > 0 THEN 10 ELSE 0 END +
      CASE WHEN conviction_grade = 'A' THEN 20 WHEN conviction_grade = 'B' THEN 10 ELSE 0 END,
    signals_synced_at = NOW()
    WHERE signals_synced_at IS NULL
       OR signals_synced_at < NOW() - INTERVAL '1 hour'
  `);

  // signal_count = array_length(signal_tags, 1)
  await query(`
    UPDATE tradable_universe
    SET signal_count = COALESCE(array_length(signal_tags, 1), 0)
  `);

  const { rows: stats } = await query(`
    SELECT COUNT(*) AS total,
           COUNT(sparkline) AS with_spark,
           COUNT(CASE WHEN signal_count > 0 THEN 1 END) AS with_signal,
           COUNT(CASE WHEN signal_count >= 2 THEN 1 END) AS with_2plus,
           MAX(signal_score) AS max_score
    FROM tradable_universe
  `);
  console.log(`[signals] DONE — sparklines=${stats[0].with_spark}/${stats[0].total} with_signal=${stats[0].with_signal} 2+signals=${stats[0].with_2plus} max_score=${stats[0].max_score}`);
}

// ── Mode 6: PRICES BACKFILL — fetch 1y of OHLCV for top-N by mcap ─────────
// Extends backtest_prices beyond the 539 SP500/NASDAQ100 names so the
// technicals work for the broader universe. We cap at the top 2500 by market
// cap because:
//   - That covers ~98% of dollar volume
//   - Yahoo `chart()` is rate-limit-friendly at 1 call per ticker
//   - 2500 × ~250 bars/yr ≈ 600K rows = ~50MB DB growth
async function backfillPrices({ topN = 2500, days = 400 } = {}) {
  console.log(`[prices] backfilling top ${topN} by mcap, ${days} days`);
  const { rows: targets } = await query(`
    SELECT u.symbol
    FROM tradable_universe u
    LEFT JOIN (SELECT symbol, COUNT(*) AS n FROM backtest_prices GROUP BY symbol) bp ON bp.symbol = u.symbol
    WHERE u.market_cap_usd IS NOT NULL
      AND u.market_cap_usd >= 300000000        -- skip pennies <$300M
      AND COALESCE(bp.n, 0) < 200              -- only fetch those missing or partial
    ORDER BY u.market_cap_usd DESC
    LIMIT $1
  `, [topN]);

  console.log(`[prices] ${targets.length} symbols need history`);
  if (!targets.length) return;

  const limit = pLimit(4);  // gentle on Yahoo
  let done = 0, ok = 0, err = 0, totalRows = 0;

  await Promise.all(targets.map(({ symbol }) => limit(async () => {
    try {
      const period1 = new Date(Date.now() - (days + 30) * 86_400_000);
      const result = await withRetry(
        () => yf.chart(symbol, { period1, interval: '1d' }),
        symbol
      );
      const quotes = (result.quotes || []).filter(q => q.close > 0);
      if (quotes.length < 30) { err++; return; }
      // Batch insert
      const values = quotes.map((q, i) => {
        const date = q.date instanceof Date ? q.date.toISOString().split('T')[0] : String(q.date).slice(0,10);
        const idx = i * 7;
        return `($${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7})`;
      }).join(',');
      const params = [];
      for (const q of quotes) {
        const date = q.date instanceof Date ? q.date.toISOString().split('T')[0] : String(q.date).slice(0,10);
        params.push(symbol, date, q.open, q.high, q.low, q.adjclose ?? q.close, q.volume ?? 0);
      }
      await query(
        `INSERT INTO backtest_prices (symbol, price_date, open, high, low, close, volume)
         VALUES ${values}
         ON CONFLICT (symbol, price_date) DO UPDATE SET
           open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
           close = EXCLUDED.close, volume = EXCLUDED.volume`,
        params
      );
      totalRows += quotes.length;
      ok++;
    } catch (e) {
      err++;
      if (err <= 5) console.warn(`[prices] ${symbol} failed: ${e.message?.slice(0, 80)}`);
    }
    done++;
    if (done % 50 === 0) {
      console.log(`[prices] ${done}/${targets.length}  ok=${ok} err=${err} rowsInserted=${totalRows}`);
      await sleep(BATCH_SLEEP_MS);
    }
  })));

  console.log(`[prices] DONE — ok=${ok} err=${err} total rows inserted=${totalRows}`);
}

// ── CLI dispatch ───────────────────────────────────────────────────────────
async function main() {
  await initDb();
  if (!isDbAvailable()) { console.error('DB not available'); process.exit(1); }
  const mode = process.argv[2] || 'all';
  console.log(`[screener-backfill] mode=${mode} started ${new Date().toISOString()}`);
  const t0 = Date.now();
  try {
    if (mode === 'sectors' || mode === 'all')      await backfillSectors({ onlyMissing: false });
    if (mode === 'fundamentals' || mode === 'all') await backfillFundamentals({ onlyMissing: false });
    if (mode === 'snapshot' || mode === 'all')     await refreshSnapshot();
    if (mode === 'prices')                          await backfillPrices({ topN: 2500 });
    if (mode === 'technicals' || mode === 'all')   await computeTechnicals();
    if (mode === 'signals' || mode === 'all')       await backfillSignals();
  } catch (e) {
    console.error('[screener-backfill] FATAL:', e);
    process.exit(2);
  }
  const dt = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log(`[screener-backfill] DONE in ${dt} min`);
  process.exit(0);
}

main();
