#!/usr/bin/env node
/**
 * ETL #4: Build daily_intraday_features 2016-2026 from HDD minute_aggs.
 *
 * Source:   /Volumes/Archive/polygon-flatfiles/us_stocks_sip/minute_aggs_v1/YYYY/MM/YYYY-MM-DD.csv.gz
 *           Format: ticker, volume, open, close, high, low, window_start (ns), transactions
 * Target:   public.daily_intraday_features
 *
 * Per day per symbol we compute:
 *   pre_*, reg_*, post_* (price + vol windows: pre-mkt 04:00-09:29, regular 09:30-15:59,
 *                          post-mkt 16:00-19:59 ET)
 *   or_high, or_low, or_volume       — opening range first 30 min (09:30-09:59)
 *   vwap                              — VWAP across regular session
 *   px_10am, px_11am, px_12pm, px_2pm, px_330pm — intraday checkpoints
 *   pre_change_pct, intraday_chg_pct, post_change_pct, full_day_chg_pct
 *
 * Idempotent: ON CONFLICT (symbol, price_date) DO UPDATE.
 * Restartable: skips days already in DB with matching symbol counts.
 *
 * Runtime estimate: ~2,500 days × 30s avg (10k symbols/day) = ~21 hours sequential.
 *                   With 4 parallel workers: ~5-6 hours.
 *                   FROM=2016-06-01 → TO=2026-06-03 full run.
 * Disk impact: Postgres grows by ~3-5 GB (10y × 10k symbols × ~50 floats = 5GB).
 *
 * Usage:
 *   node scripts/etl/build-daily-features-from-hdd.mjs                # full
 *   FROM=2024-01-01 TO=2024-12-31 node scripts/etl/build-daily-features-from-hdd.mjs
 *   ONLY=AAPL,NVDA node scripts/etl/build-daily-features-from-hdd.mjs # symbol filter
 *   DRY=1 node scripts/etl/build-daily-features-from-hdd.mjs           # parse only
 *
 * NOTE: this is the heaviest of the 7 ETLs. Run on a weekend or when bot quiet.
 * NOTE 2: existing scripts/build-daily-intraday-features.mjs (pre-2026-06)
 *         already does the SAME thing but reads from intraday_bars_1m
 *         (1-year-only OLTP table). This new script reads from HDD instead,
 *         enabling the 10-year backfill.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { initDb, query } from '../../src/core/db.js';

const SRC_ROOT = '/Volumes/Archive/polygon-flatfiles/us_stocks_sip/minute_aggs_v1';
const DRY      = process.env.DRY === '1';
const FROM     = process.env.FROM || '2016-06-01';
const TO       = process.env.TO   || new Date().toISOString().slice(0, 10);
const ONLY     = (process.env.ONLY || '').split(',').filter(Boolean).map(s => s.toUpperCase());
const CONCUR   = Number(process.env.CONCURRENCY) || 4;

// ET-session windows (in minutes since midnight ET)
const PRE_OPEN_MIN  = 4 * 60;          // 04:00
const REG_OPEN_MIN  = 9 * 60 + 30;     // 09:30
const REG_CLOSE_MIN = 16 * 60;         // 16:00
const POST_CLOSE_MIN = 20 * 60;        // 20:00

const OR_END_MIN    = REG_OPEN_MIN + 30;  // 10:00

// Checkpoint minutes
const CHECKPOINTS = {
  px_10am:  10 * 60,
  px_11am:  11 * 60,
  px_12pm:  12 * 60,
  px_2pm:   14 * 60,
  px_330pm: 15 * 60 + 30,
};

// Convert ns timestamp (UTC) → ET minutes-since-midnight
function nsToEtMinutes(ns) {
  const d = new Date(Number(BigInt(ns) / 1_000_000n));   // ns → ms
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return et.getHours() * 60 + et.getMinutes();
}

function* enumerateDays(from, to) {
  const d = new Date(from + 'T00:00:00Z'); const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

async function processDay(dateStr) {
  const [y, m] = dateStr.split('-');
  const fp = path.join(SRC_ROOT, y, m, `${dateStr}.csv.gz`);
  if (!fs.existsSync(fp)) return { date: dateStr, n: 0, status: 'missing' };

  // Stream the CSV, aggregate per symbol
  const stream = fs.createReadStream(fp).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream });
  const agg = new Map();   // symbol → aggregator object

  let lineNum = 0;
  for await (const line of rl) {
    lineNum++;
    if (lineNum === 1) continue;  // header
    const [ticker, vol, open, close, high, low, ws] = line.split(',');
    if (!ticker) continue;
    if (ONLY.length && !ONLY.includes(ticker.toUpperCase())) continue;

    const etMin = nsToEtMinutes(ws);
    const v = Number(vol), o = Number(open), c = Number(close), h = Number(high), l = Number(low);

    let a = agg.get(ticker);
    if (!a) {
      a = {
        // tracking
        first_pre: null, last_pre: null, pre_h: -Infinity, pre_l: Infinity, pre_v: 0,
        first_reg: null, last_reg: null, reg_h: -Infinity, reg_l: Infinity, reg_v: 0,
        reg_pv_sum: 0, // for VWAP
        first_post: null, last_post: null, post_h: -Infinity, post_l: Infinity, post_v: 0,
        or_h: -Infinity, or_l: Infinity, or_v: 0,
        checkpoints: {},  // {px_10am: close at minute 600, etc.}
      };
      agg.set(ticker, a);
    }

    if (etMin >= PRE_OPEN_MIN && etMin < REG_OPEN_MIN) {
      if (a.first_pre == null) a.first_pre = o;
      a.last_pre = c; a.pre_h = Math.max(a.pre_h, h); a.pre_l = Math.min(a.pre_l, l); a.pre_v += v;
    } else if (etMin >= REG_OPEN_MIN && etMin < REG_CLOSE_MIN) {
      if (a.first_reg == null) a.first_reg = o;
      a.last_reg = c; a.reg_h = Math.max(a.reg_h, h); a.reg_l = Math.min(a.reg_l, l); a.reg_v += v;
      a.reg_pv_sum += ((h + l + c) / 3) * v;
      if (etMin < OR_END_MIN) {
        a.or_h = Math.max(a.or_h, h); a.or_l = Math.min(a.or_l, l); a.or_v += v;
      }
      for (const [k, mn] of Object.entries(CHECKPOINTS)) {
        if (etMin === mn) a.checkpoints[k] = c;
      }
    } else if (etMin >= REG_CLOSE_MIN && etMin < POST_CLOSE_MIN) {
      if (a.first_post == null) a.first_post = o;
      a.last_post = c; a.post_h = Math.max(a.post_h, h); a.post_l = Math.min(a.post_l, l); a.post_v += v;
    }
  }

  if (DRY) return { date: dateStr, n: agg.size, status: 'dry' };

  // Insert per-symbol aggregates
  let inserted = 0;
  for (const [sym, a] of agg) {
    if (a.first_reg == null) continue;  // skip symbols with no regular-session data
    const vwap = a.reg_v > 0 ? a.reg_pv_sum / a.reg_v : null;
    const prev_close = a.last_pre ?? a.first_reg;
    const pre_chg = (a.last_pre != null && a.first_pre != null && a.first_pre > 0)
      ? ((a.last_pre - a.first_pre) / a.first_pre) * 100 : null;
    const intra_chg = (a.last_reg != null && a.first_reg > 0)
      ? ((a.last_reg - a.first_reg) / a.first_reg) * 100 : null;
    const post_chg = (a.last_post != null && a.first_post != null && a.first_post > 0)
      ? ((a.last_post - a.first_post) / a.first_post) * 100 : null;
    const full_chg = (a.last_post ?? a.last_reg) != null && (a.first_pre ?? a.first_reg) > 0
      ? (((a.last_post ?? a.last_reg) - (a.first_pre ?? a.first_reg)) / (a.first_pre ?? a.first_reg)) * 100
      : null;
    try {
      await query(`
        INSERT INTO daily_intraday_features (
          symbol, price_date,
          pre_open, pre_high, pre_low, pre_close, pre_volume,
          reg_open, reg_high, reg_low, reg_close, reg_volume,
          post_open, post_high, post_low, post_close, post_volume,
          or_high, or_low, or_volume, vwap,
          px_10am, px_11am, px_12pm, px_2pm, px_330pm,
          pre_change_pct, intraday_chg_pct, post_change_pct, full_day_chg_pct
        ) VALUES (
          $1, $2,
          $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17,
          $18, $19, $20, $21,
          $22, $23, $24, $25, $26,
          $27, $28, $29, $30
        )
        ON CONFLICT (symbol, price_date) DO UPDATE SET
          pre_open=EXCLUDED.pre_open, pre_high=EXCLUDED.pre_high, pre_low=EXCLUDED.pre_low,
          pre_close=EXCLUDED.pre_close, pre_volume=EXCLUDED.pre_volume,
          reg_open=EXCLUDED.reg_open, reg_high=EXCLUDED.reg_high, reg_low=EXCLUDED.reg_low,
          reg_close=EXCLUDED.reg_close, reg_volume=EXCLUDED.reg_volume,
          post_open=EXCLUDED.post_open, post_high=EXCLUDED.post_high, post_low=EXCLUDED.post_low,
          post_close=EXCLUDED.post_close, post_volume=EXCLUDED.post_volume,
          or_high=EXCLUDED.or_high, or_low=EXCLUDED.or_low, or_volume=EXCLUDED.or_volume,
          vwap=EXCLUDED.vwap,
          px_10am=EXCLUDED.px_10am, px_11am=EXCLUDED.px_11am, px_12pm=EXCLUDED.px_12pm,
          px_2pm=EXCLUDED.px_2pm, px_330pm=EXCLUDED.px_330pm,
          pre_change_pct=EXCLUDED.pre_change_pct, intraday_chg_pct=EXCLUDED.intraday_chg_pct,
          post_change_pct=EXCLUDED.post_change_pct, full_day_chg_pct=EXCLUDED.full_day_chg_pct
      `, [
        sym, dateStr,
        a.first_pre, isFinite(a.pre_h)?a.pre_h:null, isFinite(a.pre_l)?a.pre_l:null, a.last_pre, a.pre_v || null,
        a.first_reg, isFinite(a.reg_h)?a.reg_h:null, isFinite(a.reg_l)?a.reg_l:null, a.last_reg, a.reg_v || null,
        a.first_post, isFinite(a.post_h)?a.post_h:null, isFinite(a.post_l)?a.post_l:null, a.last_post, a.post_v || null,
        isFinite(a.or_h)?a.or_h:null, isFinite(a.or_l)?a.or_l:null, a.or_v || null, vwap,
        a.checkpoints.px_10am ?? null, a.checkpoints.px_11am ?? null, a.checkpoints.px_12pm ?? null,
        a.checkpoints.px_2pm ?? null, a.checkpoints.px_330pm ?? null,
        pre_chg, intra_chg, post_chg, full_chg,
      ]);
      inserted++;
    } catch (e) {
      if (inserted === 0) console.warn(`  ${dateStr} ${sym} err: ${e.message?.slice(0, 60)}`);
    }
  }
  return { date: dateStr, n: inserted, status: 'ok' };
}

async function main() {
  await initDb();
  console.log(`[build-daily-features-from-hdd] ${FROM} → ${TO} dry=${DRY} only=${ONLY.length||'all'}`);

  let daysDone = 0, rowsDone = 0;
  const days = [...enumerateDays(FROM, TO)];
  console.log(`  trading days to process: ${days.length}`);
  const t0 = Date.now();

  // Process in batches of CONCUR (parallelize across days)
  for (let i = 0; i < days.length; i += CONCUR) {
    const batch = days.slice(i, i + CONCUR);
    const results = await Promise.allSettled(batch.map(processDay));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        daysDone++; rowsDone += r.value?.n ?? 0;
      }
    }
    if (daysDone % 25 === 0 || daysDone === days.length) {
      const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
      const rate = daysDone / ((Date.now() - t0) / 60000);
      const eta_min = ((days.length - daysDone) / rate).toFixed(0);
      console.log(`  progress: ${daysDone}/${days.length} days, ${rowsDone} rows, ${elapsed}min elapsed, ETA ${eta_min}min`);
    }
  }
  console.log(`[build-daily-features-from-hdd] DONE days=${daysDone} rows=${rowsDone} time=${((Date.now()-t0)/60000).toFixed(1)}min`);
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e); process.exit(1); });
