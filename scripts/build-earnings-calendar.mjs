#!/usr/bin/env node
/**
 * scripts/build-earnings-calendar.mjs
 *
 * Backfills `earnings_calendar` table for every symbol in `tradable_universe`
 * using yahoo-finance2 quoteSummary { calendarEvents, earningsHistory }.
 *
 * Rate-limit: 8 concurrent + 100ms inter-request floor → effectively ~10 req/sec.
 * Yahoo tolerates this without 429s in practice.
 *
 * For 12K symbols → ~20-25 min total.
 *
 * Usage:
 *   node scripts/build-earnings-calendar.mjs                  # full universe
 *   node scripts/build-earnings-calendar.mjs --resume         # skip already-fetched
 *   node scripts/build-earnings-calendar.mjs --liquid-only    # only symbols with adv_dollar_30d >= $1M
 *   node scripts/build-earnings-calendar.mjs --symbols AAPL,NVDA,TSLA
 *   node scripts/build-earnings-calendar.mjs --refresh-stale 7   # re-fetch rows older than N days
 */

import '../src/core/env-loader.js';
import { initDb, query } from '../src/core/db.js';
import YahooFinance from 'yahoo-finance2';

// yahoo-finance2 v3+ requires explicit instantiation
const yahooFinance = new YahooFinance();
try { yahooFinance.suppressNotices?.(['yahooSurvey', 'ripHistorical']); } catch {}

const args = process.argv.slice(2);
const getArg  = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const hasFlag = (n) => args.includes(`--${n}`);

const CONCURRENCY = parseInt(getArg('concurrency', '8'), 10);
const RESUME      = hasFlag('resume');
const LIQUID_ONLY = hasFlag('liquid-only');
const SYMBOLS_CSV = getArg('symbols');
const REFRESH_DAYS = parseInt(getArg('refresh-stale', '0'), 10);

function dateOrNull(d) {
  if (!d) return null;
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return null;
    return dt.toISOString().slice(0, 10);
  } catch { return null; }
}
function callTime(t) {
  if (!t) return null;
  const s = String(t).toLowerCase();
  if (s.includes('before')) return 'BMO';
  if (s.includes('after'))  return 'AMC';
  if (s.includes('time')   || s.includes('during')) return 'TAS';
  return s.slice(0, 10);
}

async function fetchOne(symbol) {
  try {
    const r = await yahooFinance.quoteSummary(symbol, {
      modules: ['calendarEvents', 'earningsHistory', 'earningsTrend'],
    }, { validateResult: false });

    const ce  = r?.calendarEvents ?? {};
    const eh  = r?.earningsHistory?.history ?? [];
    const et  = r?.earningsTrend?.trend ?? [];

    // Next earnings: calendarEvents.earnings.earningsDate is usually an array of 1-2 dates
    const nextEarningsRaw = ce?.earnings?.earningsDate?.[0] ?? null;
    const next_earnings   = dateOrNull(nextEarningsRaw);

    // BMO/AMC indication is sometimes in earnings.earningsCallTimeIso8601 or similar
    const next_call_time  = callTime(ce?.earnings?.earningsCallTime
                                 || ce?.earnings?.earningsCallTimeIso8601 || null);

    // Upcoming estimates from earningsTrend (current quarter)
    const curQ = et.find(t => t.period === '0q') ?? null;
    const earnings_avg_est = curQ?.earningsEstimate?.avg?.raw
                           ?? curQ?.earningsEstimate?.avg ?? null;
    const revenue_avg_est  = curQ?.revenueEstimate?.avg?.raw
                           ?? curQ?.revenueEstimate?.avg ?? null;

    // Last reported earnings: most recent past entry in earningsHistory
    const past = (eh || []).filter(h => h.quarter?.fmt || h.quarter)
                           .sort((a, b) => new Date(b.quarter || b.quarter?.raw) - new Date(a.quarter || a.quarter?.raw));
    const lastRow = past[0] ?? null;
    const last_earnings    = lastRow ? dateOrNull(lastRow.quarter || lastRow.quarter?.fmt || lastRow.quarter?.raw) : null;
    const last_eps_actual  = lastRow?.epsActual?.raw   ?? lastRow?.epsActual   ?? null;
    const last_eps_estimate= lastRow?.epsEstimate?.raw ?? lastRow?.epsEstimate ?? null;
    const last_surprise_pct = lastRow?.surprisePercent?.raw ?? lastRow?.surprisePercent ?? null;

    // Dividends (bonus from same call)
    const ex_dividend_date = dateOrNull(ce?.exDividendDate);
    const dividend_date    = dateOrNull(ce?.dividendDate);

    return {
      symbol, next_earnings, next_call_time, last_earnings,
      last_eps_actual, last_eps_estimate, last_surprise_pct,
      earnings_avg_est, revenue_avg_est,
      ex_dividend_date, dividend_date,
      status: next_earnings || last_earnings ? 'ok' : 'no_data',
      error: null,
    };
  } catch (e) {
    return { symbol, status: 'error', error: e.message?.slice(0, 200) };
  }
}

async function upsert(row) {
  const safeSurprise = (() => {
    if (row.last_surprise_pct == null) return null;
    // FIXED 2026-06-01: previously multiplied any |n|<1 by 100, which incorrectly
    // converted a legit 0.5% surprise into 50%. Yahoo's quoteSummary always returns
    // surprisePercent as percent (e.g. 5.54 for +5.54%), never as a fraction.
    // Just parse and return — no rescaling.
    const n = Number(row.last_surprise_pct);
    if (!Number.isFinite(n)) return null;
    return n;
  })();

  await query(`
    INSERT INTO earnings_calendar
      (symbol, next_earnings, next_call_time, last_earnings,
       last_eps_actual, last_eps_estimate, last_surprise_pct,
       earnings_avg_est, revenue_avg_est, ex_dividend_date, dividend_date,
       fetched_at, fetch_status, fetch_error)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW(), $12, $13)
    ON CONFLICT (symbol) DO UPDATE SET
      next_earnings      = EXCLUDED.next_earnings,
      next_call_time     = EXCLUDED.next_call_time,
      last_earnings      = EXCLUDED.last_earnings,
      last_eps_actual    = EXCLUDED.last_eps_actual,
      last_eps_estimate  = EXCLUDED.last_eps_estimate,
      last_surprise_pct  = EXCLUDED.last_surprise_pct,
      earnings_avg_est   = EXCLUDED.earnings_avg_est,
      revenue_avg_est    = EXCLUDED.revenue_avg_est,
      ex_dividend_date   = EXCLUDED.ex_dividend_date,
      dividend_date      = EXCLUDED.dividend_date,
      fetched_at         = NOW(),
      fetch_status       = EXCLUDED.fetch_status,
      fetch_error        = EXCLUDED.fetch_error
  `, [
    row.symbol, row.next_earnings, row.next_call_time, row.last_earnings,
    row.last_eps_actual, row.last_eps_estimate, safeSurprise,
    row.earnings_avg_est, row.revenue_avg_est, row.ex_dividend_date, row.dividend_date,
    row.status, row.error,
  ]);
}

// p-limit-style concurrency without dep
async function runWithConcurrency(items, limit, worker) {
  const out = [];
  let idx = 0;
  let done = 0;
  const tStart = Date.now();

  async function runWorker() {
    while (idx < items.length) {
      const i = idx++;
      const r = await worker(items[i], i);
      out.push(r);
      done++;
      if (done % 200 === 0 || done === items.length) {
        const elapsed = ((Date.now() - tStart) / 60_000).toFixed(1);
        const rate    = (done / ((Date.now() - tStart) / 1000)).toFixed(1);
        const ok      = out.filter(r => r?.status === 'ok').length;
        const noData  = out.filter(r => r?.status === 'no_data').length;
        const err     = out.filter(r => r?.status === 'error').length;
        console.log(`[earnings] ${done}/${items.length}  ok=${ok}  no_data=${noData}  err=${err}  ${rate}/s  (${elapsed}m elapsed)`);
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return out;
}

async function main() {
  await initDb();

  // 1. Pick the list of symbols
  let symbols;
  if (SYMBOLS_CSV) {
    symbols = SYMBOLS_CSV.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  } else {
    const conditions = ['asset_class IS NULL OR asset_class = \'us_equity\''];
    if (LIQUID_ONLY) conditions.push('adv_dollar_30d >= 1000000');
    const sql = `SELECT symbol FROM tradable_universe WHERE ${conditions.join(' AND ')} ORDER BY COALESCE(adv_dollar_30d, 0) DESC`;
    const { rows } = await query(sql);
    symbols = rows.map(r => r.symbol);
  }

  console.log(`[earnings] universe: ${symbols.length} symbols${LIQUID_ONLY ? ' (liquid-only)' : ''}`);

  if (RESUME || REFRESH_DAYS > 0) {
    const cutoffSql = REFRESH_DAYS > 0
      ? `fetched_at > NOW() - ($1 * INTERVAL '1 day')`
      : `fetch_status IN ('ok', 'no_data')`;
    const params = REFRESH_DAYS > 0 ? [REFRESH_DAYS] : [];
    const { rows: done } = await query(`SELECT symbol FROM earnings_calendar WHERE ${cutoffSql}`, params);
    const doneSet = new Set(done.map(r => r.symbol));
    const before = symbols.length;
    symbols = symbols.filter(s => !doneSet.has(s));
    console.log(`[earnings] resume — skipping ${before - symbols.length} already-fetched, ${symbols.length} to do`);
  }

  if (!symbols.length) { console.log('[earnings] nothing to do'); process.exit(0); }

  // 2. Concurrent fetch + upsert
  await runWithConcurrency(symbols, CONCURRENCY, async (sym) => {
    const row = await fetchOne(sym);
    try { await upsert(row); } catch (e) { console.warn(`[earnings] upsert failed ${sym}:`, e.message); }
    return row;
  });

  // 3. Final summary
  const { rows: summary } = await query(`
    SELECT fetch_status, COUNT(*)
      FROM earnings_calendar GROUP BY fetch_status ORDER BY COUNT(*) DESC
  `);
  console.log('\n[earnings] final breakdown:');
  summary.forEach(r => console.log(`  ${r.fetch_status || 'null'}: ${r.count}`));

  const { rows: upcoming } = await query(`
    SELECT COUNT(*) AS upcoming_14d
      FROM earnings_calendar
     WHERE next_earnings BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '14 days'
  `);
  console.log(`[earnings] upcoming in next 14 days: ${upcoming[0].upcoming_14d}`);

  process.exit(0);
}

main().catch(e => { console.error('[earnings] FATAL:', e); process.exit(1); });
