#!/usr/bin/env node
/**
 * Intelligent-Exit Backtest — Option B (Synthetic Universe)
 *
 * For each historical trading day D in the backtest window:
 *   1. Re-run ml_v2_intelligence scoreUniverse() with date=D (POINT-IN-TIME)
 *   2. Pick the top-N candidates (mimics what the bot would have bought)
 *   3. For each pick, simulate forward holding through 3 strategies:
 *
 *      V_actual      — mechanical: hard_sl 6%, trail 30%, time_stop 5d
 *      V_intel       — thesis-break: exit when re-score < entry_prob × 0.7
 *                       OR catastrophic floor (-15%)
 *                       NO time stop, NO trail %, NO mechanical hard stop
 *      V_intel_strict— thesis-break (×0.6) + tight floor (-10%)
 *
 *   4. Also record an "oracle" = best exit possible in the holding window
 *      (upper bound on what intelligence could ever achieve).
 *
 *   5. Persist every row to backtest_intelligent_exit, print rolling summary.
 *
 * Usage:
 *   node scripts/backtest-intelligent-exit.mjs                 # full 30-day run
 *   DAYS=5 node scripts/backtest-intelligent-exit.mjs          # quick validation
 *   TOP_N=10 DAYS=30 node scripts/backtest-intelligent-exit.mjs
 *
 * Output:
 *   - backtest_intelligent_exit table (per-trade rows)
 *   - stdout: progress lines + final aggregate table
 *   - log file: /tmp/intel-exit-backtest.log (when run with `&> file`)
 */
import 'dotenv/config';
import { initDb, query } from '../src/core/db.js';
import { scoreUniverse, POOR_SECTORS_DEFAULT } from '../src/core/model-v2-scorer.js';

const DAYS         = Number(process.env.DAYS) || 30;            // backtest window
const TOP_N        = Number(process.env.TOP_N) || 10;           // picks per day
const MAX_HOLD     = Number(process.env.MAX_HOLD) || 15;        // max simulated hold days
const MIN_PRICE    = Number(process.env.MIN_PRICE) || 5;
const MAX_PRICE    = Number(process.env.MAX_PRICE) || null;     // null = no cap
const RUN_ID       = process.env.RUN_ID || `backtest_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

// Exit-strategy parameters
const MECH_HARD_SL_PCT    = 0.06;
const MECH_TRAIL_PCT      = 0.30;   // 30% of peak retracement
const MECH_TIME_STOP_DAYS = 5;
const INTEL_THESIS_FACTOR = 0.70;   // exit when new score < entry × 0.70
const INTEL_FLOOR_PCT     = 0.15;   // catastrophic stop at -15%
const INTEL_STRICT_FACTOR = 0.60;
const INTEL_STRICT_FLOOR  = 0.10;

console.log(`[backtest] run_id=${RUN_ID} days=${DAYS} top_n=${TOP_N} max_hold=${MAX_HOLD}`);

// Cache: score the whole universe ONCE per date, look up per symbol later.
// Without this, the script does ~3000 scoreUniverse calls (200 picks × 15 hold days).
// With this, ~35 calls (one per distinct date used as entry-or-hold).
const _scoreCacheByDate = new Map();   // date(YYYY-MM-DD) → Map<symbol, prob>
async function scoreCacheFor(dateStr) {
  if (_scoreCacheByDate.has(dateStr)) return _scoreCacheByDate.get(dateStr);
  try {
    const r = await scoreUniverse({
      date: dateStr, limit: 5000, minPrice: MIN_PRICE, maxPrice: MAX_PRICE,
      minVolume: 1, excludeSectors: null, bullishMin: null, bullishMax: null,
    });
    const m = new Map(r.results.map(p => [p.symbol, Number(p.prob)]));
    _scoreCacheByDate.set(dateStr, m);
    return m;
  } catch {
    _scoreCacheByDate.set(dateStr, new Map());
    return _scoreCacheByDate.get(dateStr);
  }
}

async function main() {
  await initDb();

  // 1. Get the list of trading dates to use as ENTRY dates.
  //    Need at least MAX_HOLD days of forward data, so skip the last MAX_HOLD dates.
  const { rows: allDates } = await query(`
    SELECT price_date::date AS d
      FROM daily_intraday_features
     GROUP BY price_date
     ORDER BY price_date DESC
  `);
  const dates = allDates.map(r => r.d).reverse(); // chronological order
  if (dates.length < DAYS + MAX_HOLD) {
    console.warn(`[backtest] only ${dates.length} dates available, want ${DAYS + MAX_HOLD}`);
  }
  // Last MAX_HOLD dates are reserved for forward-data; entries can't use them
  const eligibleEntryDates = dates.slice(-DAYS - MAX_HOLD, -MAX_HOLD);
  console.log(`[backtest] entry dates: ${eligibleEntryDates.length} from ${eligibleEntryDates[0]} to ${eligibleEntryDates[eligibleEntryDates.length-1]}`);

  // 2. Iterate each entry date
  let totalEntries = 0;
  let totalSimulated = 0;
  const dateStart = Date.now();

  for (let i = 0; i < eligibleEntryDates.length; i++) {
    const entryDate = eligibleEntryDates[i];
    const dateStr = (entryDate instanceof Date ? entryDate : new Date(entryDate)).toISOString().slice(0, 10);

    // Re-run scoreUniverse as-of this date.
    // 2026-06-02: drop the quality entry filters (bullishMin/Max, sector blocklist).
    // Reason: UW flow data is sparser on earlier dates → bullishMin=20 wipes out
    // all candidates pre-May. We're benchmarking the EXIT strategy here, not the
    // entry filter. Take top-N by model probability — that's the most honest
    // "names the model ranked highest each day" basket.
    let picks;
    try {
      const r = await scoreUniverse({
        date: dateStr,
        limit: TOP_N,
        minPrice: MIN_PRICE,
        maxPrice: MAX_PRICE,
        minVolume: 1_000_000,
      });
      picks = r.results;
    } catch (e) {
      console.warn(`[backtest] ${dateStr} scoreUniverse failed: ${e.message}`);
      continue;
    }
    if (!picks?.length) {
      console.log(`[backtest] ${dateStr} no picks`);
      continue;
    }

    // Get next-day open price (entry price proxy)
    const nextIdx = dates.findIndex(d => {
      const ds = (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
      return ds === dateStr;
    }) + 1;
    if (nextIdx >= dates.length) continue;
    const exitWindowDates = dates.slice(nextIdx, nextIdx + MAX_HOLD + 1);
    const exitWindowStrs  = exitWindowDates.map(d => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10));

    // 3. For each pick, simulate forward
    for (const pick of picks) {
      totalEntries++;
      const symbol = pick.symbol;
      const entryProb = Number(pick.prob);
      const entryRank = picks.findIndex(p => p.symbol === symbol) + 1;

      // Fetch forward bars (next-day open through end of window)
      const { rows: bars } = await query(`
        SELECT price_date::date AS d, open::numeric, high::numeric, low::numeric, close::numeric
          FROM backtest_prices
         WHERE symbol = $1
           AND price_date >= $2::date
           AND price_date <= $3::date
         ORDER BY price_date ASC
      `, [symbol, exitWindowStrs[0], exitWindowStrs[exitWindowStrs.length - 1]]);

      if (bars.length < 1) continue;  // no forward data
      const entryPrice = Number(bars[0].open);
      if (!(entryPrice > 0)) continue;

      // Daily re-scores for this symbol — uses the per-date cache.
      const dailyScores = {};
      for (const ds of exitWindowStrs) {
        const cache = await scoreCacheFor(ds);
        const prob = cache.get(symbol);
        if (prob != null) dailyScores[ds] = prob;
      }

      // Simulate the three strategies
      const sim = simulate(entryPrice, bars, dailyScores, entryProb);

      // Oracle: best exit price in the window
      const oraclePrice = bars.reduce((max, b) => Math.max(max, Number(b.high)), 0);
      const oracleDate  = bars.find(b => Number(b.high) === oraclePrice)?.d || bars[0].d;
      const oraclePct   = ((oraclePrice - entryPrice) / entryPrice) * 100;

      await query(`
        INSERT INTO backtest_intelligent_exit (
          run_id, entry_date, symbol, entry_rule, entry_price, entry_score, entry_rank,
          mech_exit_date, mech_exit_price, mech_exit_reason, mech_hold_days, mech_pnl_pct,
          intel_exit_date, intel_exit_price, intel_exit_reason, intel_hold_days, intel_pnl_pct,
          intelS_exit_date, intelS_exit_price, intelS_exit_reason, intelS_hold_days, intelS_pnl_pct,
          oracle_exit_date, oracle_exit_price, oracle_pnl_pct
        ) VALUES ($1, $2, $3, $4, $5, $6, $7,
                  $8, $9, $10, $11, $12,
                  $13, $14, $15, $16, $17,
                  $18, $19, $20, $21, $22,
                  $23, $24, $25)
      `, [
        RUN_ID, dateStr, symbol, 'ml_v2_intelligence', entryPrice, entryProb, entryRank,
        sim.mech.exitDate, sim.mech.exitPrice, sim.mech.reason, sim.mech.holdDays, sim.mech.pnlPct,
        sim.intel.exitDate, sim.intel.exitPrice, sim.intel.reason, sim.intel.holdDays, sim.intel.pnlPct,
        sim.intelS.exitDate, sim.intelS.exitPrice, sim.intelS.reason, sim.intelS.holdDays, sim.intelS.pnlPct,
        oracleDate, oraclePrice, oraclePct,
      ]);
      totalSimulated++;
    }

    const pct = ((i + 1) / eligibleEntryDates.length * 100).toFixed(1);
    const elapsed = ((Date.now() - dateStart) / 1000).toFixed(0);
    console.log(`[backtest] ${dateStr} (${i+1}/${eligibleEntryDates.length}, ${pct}%) picks=${picks.length} simulated=${totalSimulated} elapsed=${elapsed}s`);
  }

  console.log(`\n[backtest] COMPLETE: ${totalSimulated}/${totalEntries} entries simulated`);

  // 4. Print aggregate comparison
  await printSummary(RUN_ID);
}

function simulate(entryPrice, bars, dailyScores, entryProb) {
  let mechExit = null, intelExit = null, intelSExit = null;
  let peak = entryPrice;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const ds = (b.d instanceof Date ? b.d : new Date(b.d)).toISOString().slice(0, 10);
    const day = i + 1;
    const high = Number(b.high), low = Number(b.low), close = Number(b.close);
    peak = Math.max(peak, high);

    // Mechanical
    if (!mechExit) {
      // Hard stop: low <= entry * (1 - hard_sl_pct)
      if (low <= entryPrice * (1 - MECH_HARD_SL_PCT)) {
        const stopPrice = entryPrice * (1 - MECH_HARD_SL_PCT);
        mechExit = { exitDate: b.d, exitPrice: +stopPrice.toFixed(4), reason: 'hard_stop', holdDays: day, pnlPct: -MECH_HARD_SL_PCT * 100 };
      } else if (peak > entryPrice * 1.01 && low <= peak * (1 - MECH_TRAIL_PCT)) {
        // Trail stop (require peak > 1% before trail engages)
        const trailPrice = peak * (1 - MECH_TRAIL_PCT);
        mechExit = { exitDate: b.d, exitPrice: +trailPrice.toFixed(4), reason: 'trail_stop', holdDays: day, pnlPct: ((trailPrice - entryPrice) / entryPrice) * 100 };
      } else if (day >= MECH_TIME_STOP_DAYS) {
        // Time stop at close
        mechExit = { exitDate: b.d, exitPrice: +close.toFixed(4), reason: 'time_stop', holdDays: day, pnlPct: ((close - entryPrice) / entryPrice) * 100 };
      }
    }

    // Intelligent (loose)
    if (!intelExit) {
      // Catastrophic floor
      if (low <= entryPrice * (1 - INTEL_FLOOR_PCT)) {
        const stopPrice = entryPrice * (1 - INTEL_FLOOR_PCT);
        intelExit = { exitDate: b.d, exitPrice: +stopPrice.toFixed(4), reason: 'catastrophic_floor', holdDays: day, pnlPct: -INTEL_FLOOR_PCT * 100 };
      } else {
        // Re-score: thesis broken?
        const score = dailyScores[ds];
        if (score != null && score < entryProb * INTEL_THESIS_FACTOR) {
          intelExit = { exitDate: b.d, exitPrice: +close.toFixed(4), reason: 'thesis_broken', holdDays: day, pnlPct: ((close - entryPrice) / entryPrice) * 100 };
        }
      }
    }

    // Intelligent strict (tighter)
    if (!intelSExit) {
      if (low <= entryPrice * (1 - INTEL_STRICT_FLOOR)) {
        const stopPrice = entryPrice * (1 - INTEL_STRICT_FLOOR);
        intelSExit = { exitDate: b.d, exitPrice: +stopPrice.toFixed(4), reason: 'tight_floor', holdDays: day, pnlPct: -INTEL_STRICT_FLOOR * 100 };
      } else {
        const score = dailyScores[ds];
        if (score != null && score < entryProb * INTEL_STRICT_FACTOR) {
          intelSExit = { exitDate: b.d, exitPrice: +close.toFixed(4), reason: 'thesis_broken', holdDays: day, pnlPct: ((close - entryPrice) / entryPrice) * 100 };
        }
      }
    }
  }

  // If no exit triggered, close at last bar's close
  const lastBar = bars[bars.length - 1];
  const lastClose = Number(lastBar.close);
  const lastDays = bars.length;
  const lastPct = ((lastClose - entryPrice) / entryPrice) * 100;
  if (!mechExit)  mechExit  = { exitDate: lastBar.d, exitPrice: +lastClose.toFixed(4), reason: 'window_end',     holdDays: lastDays, pnlPct: lastPct };
  if (!intelExit) intelExit = { exitDate: lastBar.d, exitPrice: +lastClose.toFixed(4), reason: 'window_end',     holdDays: lastDays, pnlPct: lastPct };
  if (!intelSExit) intelSExit= { exitDate: lastBar.d, exitPrice: +lastClose.toFixed(4), reason: 'window_end',     holdDays: lastDays, pnlPct: lastPct };

  return { mech: mechExit, intel: intelExit, intelS: intelSExit };
}

async function printSummary(runId) {
  console.log('\n========== AGGREGATE COMPARISON ==========');
  const { rows: agg } = await query(`
    SELECT
      COUNT(*) AS n,
      AVG(mech_pnl_pct)::numeric(8,3)    AS mech_avg,
      AVG(intel_pnl_pct)::numeric(8,3)   AS intel_avg,
      AVG(intelS_pnl_pct)::numeric(8,3)  AS intelS_avg,
      AVG(oracle_pnl_pct)::numeric(8,3)  AS oracle_avg,
      (SUM(CASE WHEN mech_pnl_pct  > 0 THEN 1.0 ELSE 0 END)/COUNT(*))::numeric(5,3)  AS mech_winrate,
      (SUM(CASE WHEN intel_pnl_pct > 0 THEN 1.0 ELSE 0 END)/COUNT(*))::numeric(5,3)  AS intel_winrate,
      (SUM(CASE WHEN intelS_pnl_pct> 0 THEN 1.0 ELSE 0 END)/COUNT(*))::numeric(5,3)  AS intelS_winrate,
      AVG(mech_hold_days)::numeric(5,2)   AS mech_hold,
      AVG(intel_hold_days)::numeric(5,2)  AS intel_hold,
      AVG(intelS_hold_days)::numeric(5,2) AS intelS_hold
    FROM backtest_intelligent_exit
    WHERE run_id = $1
  `, [runId]);
  console.table(agg[0]);

  // Breakdown by exit reason for intel
  const { rows: reasons } = await query(`
    SELECT intel_exit_reason AS reason, COUNT(*) AS n,
           AVG(intel_pnl_pct)::numeric(8,3) AS avg_pct
      FROM backtest_intelligent_exit
     WHERE run_id = $1
     GROUP BY intel_exit_reason ORDER BY n DESC
  `, [runId]);
  console.log('\nIntelligent exit reasons:');
  console.table(reasons);

  // Top winners that intelligent caught but mechanical missed
  const { rows: wins } = await query(`
    SELECT symbol, entry_date, entry_price::numeric(8,2) AS entry,
           mech_pnl_pct::numeric(6,2)  AS mech,
           intel_pnl_pct::numeric(6,2) AS intel,
           oracle_pnl_pct::numeric(6,2) AS oracle,
           (intel_pnl_pct - mech_pnl_pct)::numeric(6,2) AS delta
      FROM backtest_intelligent_exit
     WHERE run_id = $1
     ORDER BY (intel_pnl_pct - mech_pnl_pct) DESC LIMIT 10
  `, [runId]);
  console.log('\nTop 10 trades where INTELLIGENT beat MECHANICAL:');
  console.table(wins);

  // Top trades where mechanical beat intelligent (anti-evidence)
  const { rows: losses } = await query(`
    SELECT symbol, entry_date, entry_price::numeric(8,2) AS entry,
           mech_pnl_pct::numeric(6,2)  AS mech,
           intel_pnl_pct::numeric(6,2) AS intel,
           (mech_pnl_pct - intel_pnl_pct)::numeric(6,2) AS mech_advantage
      FROM backtest_intelligent_exit
     WHERE run_id = $1
     ORDER BY (mech_pnl_pct - intel_pnl_pct) DESC LIMIT 10
  `, [runId]);
  console.log('\nTop 10 trades where MECHANICAL beat INTELLIGENT (anti-evidence):');
  console.table(losses);
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error('FATAL:', e); process.exit(1); });
