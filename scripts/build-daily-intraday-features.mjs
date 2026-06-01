#!/usr/bin/env node
/**
 * scripts/build-daily-intraday-features.mjs
 *
 * Aggregates minute bars from `intraday_bars_1m` into one daily-summary row
 * per (symbol, price_date) in `daily_intraday_features`.
 *
 * One SQL pass per date — uses the BRIN index on ts_event to scan only the
 * day's slice of the parent table (~1.8M bars → ~13K summary rows in ~30 sec).
 *
 * Sessions are computed in America/New_York time:
 *   pre-market     04:00-09:29
 *   opening range  09:30-09:59
 *   regular        09:30-15:59
 *   post-market    16:00-19:59
 *
 * Usage:
 *   node scripts/build-daily-intraday-features.mjs                  # all dates
 *   node scripts/build-daily-intraday-features.mjs --days 30        # last 30 days
 *   node scripts/build-daily-intraday-features.mjs --from 2026-05-01 --to 2026-05-27
 *   node scripts/build-daily-intraday-features.mjs --resume         # skip already-built dates
 */

import '../src/core/env-loader.js';
import { initDb, query } from '../src/core/db.js';

const args = process.argv.slice(2);
const getArg  = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const hasFlag = (n) => args.includes(`--${n}`);

const DAYS_BACK = parseInt(getArg('days', '0'), 10);
const FROM      = getArg('from');
const TO        = getArg('to');
const RESUME    = hasFlag('resume');

const FEATURE_SQL = `
INSERT INTO daily_intraday_features (
  symbol, price_date,
  pre_open,  pre_high,  pre_low,  pre_close,  pre_volume,
  reg_open,  reg_high,  reg_low,  reg_close,  reg_volume,
  post_open, post_high, post_low, post_close, post_volume,
  or_high, or_low, or_volume,
  vwap,
  px_10am, px_11am, px_12pm, px_2pm, px_330pm,
  intraday_chg_pct, post_change_pct, intraday_range_pct, or_range_pct,
  total_volume, total_transactions, avg_minute_volume, first_30min_pct_vol,
  bar_count
)
WITH bars AS (
  SELECT
    b.symbol,
    b.ts_event,
    (b.ts_event AT TIME ZONE 'America/New_York')::time AS t_et,
    b.open, b.high, b.low, b.close, b.volume, b.transactions
    FROM intraday_bars_1m b
   WHERE b.ts_event >= ($1::date AT TIME ZONE 'America/New_York')
     AND b.ts_event <  (($1::date + 1) AT TIME ZONE 'America/New_York')
),
sessions AS (
  SELECT
    symbol, ts_event, t_et, open, high, low, close, volume, transactions,
    CASE
      WHEN t_et >= '04:00' AND t_et <  '09:30'           THEN 'pre'
      WHEN t_et >= '09:30' AND t_et <  '16:00'           THEN 'reg'
      WHEN t_et >= '16:00' AND t_et <  '20:00'           THEN 'post'
      ELSE 'other'
    END AS sess,
    CASE WHEN t_et >= '09:30' AND t_et < '10:00' THEN 1 ELSE 0 END AS is_or
    FROM bars
),
ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY symbol, sess ORDER BY ts_event)               AS rn_first,
    ROW_NUMBER() OVER (PARTITION BY symbol, sess ORDER BY ts_event DESC)          AS rn_last
    FROM sessions
)
SELECT
  symbol,
  $1::date AS price_date,
  -- PRE
  MAX(open)  FILTER (WHERE sess='pre'  AND rn_first=1)                                AS pre_open,
  MAX(high)  FILTER (WHERE sess='pre')                                                AS pre_high,
  MIN(low)   FILTER (WHERE sess='pre')                                                AS pre_low,
  MAX(close) FILTER (WHERE sess='pre'  AND rn_last=1)                                 AS pre_close,
  SUM(volume) FILTER (WHERE sess='pre')                                               AS pre_volume,
  -- REG
  MAX(open)  FILTER (WHERE sess='reg'  AND rn_first=1)                                AS reg_open,
  MAX(high)  FILTER (WHERE sess='reg')                                                AS reg_high,
  MIN(low)   FILTER (WHERE sess='reg')                                                AS reg_low,
  MAX(close) FILTER (WHERE sess='reg'  AND rn_last=1)                                 AS reg_close,
  SUM(volume) FILTER (WHERE sess='reg')                                               AS reg_volume,
  -- POST
  MAX(open)  FILTER (WHERE sess='post' AND rn_first=1)                                AS post_open,
  MAX(high)  FILTER (WHERE sess='post')                                               AS post_high,
  MIN(low)   FILTER (WHERE sess='post')                                               AS post_low,
  MAX(close) FILTER (WHERE sess='post' AND rn_last=1)                                 AS post_close,
  SUM(volume) FILTER (WHERE sess='post')                                              AS post_volume,
  -- OPENING RANGE
  MAX(high)   FILTER (WHERE is_or=1)                                                  AS or_high,
  MIN(low)    FILTER (WHERE is_or=1)                                                  AS or_low,
  SUM(volume) FILTER (WHERE is_or=1)                                                  AS or_volume,
  -- VWAP regular session
  CASE WHEN SUM(volume) FILTER (WHERE sess='reg') > 0
    THEN SUM(close * volume) FILTER (WHERE sess='reg') / SUM(volume) FILTER (WHERE sess='reg')
    ELSE NULL
  END                                                                                  AS vwap,
  -- Snapshots at specific times (closest bar)
  MAX(close) FILTER (WHERE t_et = '10:00')                                            AS px_10am,
  MAX(close) FILTER (WHERE t_et = '11:00')                                            AS px_11am,
  MAX(close) FILTER (WHERE t_et = '12:00')                                            AS px_12pm,
  MAX(close) FILTER (WHERE t_et = '14:00')                                            AS px_2pm,
  MAX(close) FILTER (WHERE t_et = '15:30')                                            AS px_330pm,
  -- Derived intraday metrics (computed inline using sub-aggregations)
  CASE WHEN MAX(open)  FILTER (WHERE sess='reg' AND rn_first=1) > 0
    THEN ROUND(
      ((MAX(close) FILTER (WHERE sess='reg' AND rn_last=1) - MAX(open)  FILTER (WHERE sess='reg' AND rn_first=1))
       / MAX(open)  FILTER (WHERE sess='reg' AND rn_first=1) * 100)::numeric, 2)
    ELSE NULL
  END                                                                                  AS intraday_chg_pct,
  CASE WHEN MAX(close) FILTER (WHERE sess='reg' AND rn_last=1) > 0
    THEN ROUND(
      ((MAX(close) FILTER (WHERE sess='post' AND rn_last=1) - MAX(close) FILTER (WHERE sess='reg' AND rn_last=1))
       / MAX(close) FILTER (WHERE sess='reg' AND rn_last=1) * 100)::numeric, 2)
    ELSE NULL
  END                                                                                  AS post_change_pct,
  CASE WHEN MAX(open) FILTER (WHERE sess='reg' AND rn_first=1) > 0
    THEN ROUND(
      ((MAX(high) FILTER (WHERE sess='reg') - MIN(low) FILTER (WHERE sess='reg'))
       / MAX(open) FILTER (WHERE sess='reg' AND rn_first=1) * 100)::numeric, 2)
    ELSE NULL
  END                                                                                  AS intraday_range_pct,
  CASE WHEN MAX(open) FILTER (WHERE sess='reg' AND rn_first=1) > 0
    THEN ROUND(
      ((MAX(high) FILTER (WHERE is_or=1) - MIN(low) FILTER (WHERE is_or=1))
       / MAX(open) FILTER (WHERE sess='reg' AND rn_first=1) * 100)::numeric, 2)
    ELSE NULL
  END                                                                                  AS or_range_pct,
  -- Liquidity / activity
  SUM(volume)                                                                          AS total_volume,
  SUM(transactions)::integer                                                           AS total_transactions,
  ROUND(AVG(volume)::numeric, 2)                                                       AS avg_minute_volume,
  CASE WHEN SUM(volume) > 0
    THEN ROUND((SUM(volume) FILTER (WHERE is_or=1)::numeric / SUM(volume) * 100), 2)
    ELSE NULL
  END                                                                                  AS first_30min_pct_vol,
  COUNT(*)::int                                                                        AS bar_count
  FROM ranked
 GROUP BY symbol
 HAVING COUNT(*) FILTER (WHERE sess='reg') > 0    -- skip symbols with no regular-session bars
ON CONFLICT (symbol, price_date) DO NOTHING
RETURNING 1
`;

async function buildOneDay(dateStr) {
  const t0 = Date.now();
  const { rowCount } = await query(FEATURE_SQL, [dateStr]);
  return { day: dateStr, rows: rowCount, ms: Date.now() - t0 };
}

async function main() {
  await initDb();

  // Discover date range
  let from, to;
  if (FROM && TO) { from = FROM; to = TO; }
  else if (DAYS_BACK > 0) {
    const today = new Date();
    const start = new Date(today); start.setDate(today.getDate() - DAYS_BACK);
    from = start.toISOString().slice(0, 10);
    to   = today.toISOString().slice(0, 10);
  } else {
    // Default: cover every date with data in intraday_bars_1m.
    // FIXED 2026-06-01: use America/New_York date (matches buildOneDay's session
    // boundaries). Previously used UTC ts_event::date which drifted at session
    // edges — e.g. a 04:00 UTC bar belongs to the previous ET session.
    const { rows } = await query(
      `SELECT
         MIN((ts_event AT TIME ZONE 'America/New_York')::date)::text AS oldest,
         MAX((ts_event AT TIME ZONE 'America/New_York')::date)::text AS newest
         FROM intraday_bars_1m`
    );
    from = rows[0]?.oldest;
    to   = rows[0]?.newest;
    if (!from) { console.log('[features] no source data'); process.exit(0); }
  }

  console.log(`[features] window: ${from} → ${to}`);

  // Enumerate trading dates from the source table directly (skips weekends/holidays naturally).
  // FIXED 2026-06-01: same fix — enumerate ET-local dates so resume + window discovery
  // align with buildOneDay (which converts to America/New_York for session boundaries).
  const { rows: dateRows } = await query(`
    SELECT DISTINCT (ts_event AT TIME ZONE 'America/New_York')::date::text AS d
      FROM intraday_bars_1m
     WHERE (ts_event AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date
     ORDER BY d DESC
  `, [from, to]);
  const allDates = dateRows.map(r => r.d);
  console.log(`[features] ${allDates.length} trading days have source data`);

  let alreadyDone = new Set();
  if (RESUME) {
    const { rows } = await query(`
      SELECT DISTINCT price_date::text AS d FROM daily_intraday_features
       WHERE price_date BETWEEN $1::date AND $2::date
    `, [from, to]);
    alreadyDone = new Set(rows.map(r => r.d));
    console.log(`[features] resume — ${alreadyDone.size} days already built, will skip`);
  }

  const todo = allDates.filter(d => !alreadyDone.has(d));
  if (!todo.length) { console.log('[features] nothing to do'); process.exit(0); }
  console.log(`[features] ${todo.length} days to build`);

  const tStart = Date.now();
  let totalRows = 0, done = 0, failed = 0;
  for (const d of todo) {
    try {
      const r = await buildOneDay(d);
      totalRows += r.rows;
      done++;
      const sec = (r.ms / 1000).toFixed(1);
      const elapsed = ((Date.now() - tStart) / 60_000).toFixed(1);
      console.log(`[features] ${d}  ${String(r.rows).padStart(6)} symbols  ${sec}s  [${done}/${todo.length}, ${elapsed}m elapsed]`);
    } catch (e) {
      failed++;
      console.error(`[features] FAIL ${d}: ${e.message}`);
    }
  }
  const totalMin = ((Date.now() - tStart) / 60_000).toFixed(1);
  console.log(`\n[features] DONE — ${done} days, ${totalRows.toLocaleString()} rows, ${failed} failed, ${totalMin} min`);
  process.exit(0);
}

main().catch(e => { console.error('[features] FATAL:', e); process.exit(1); });
