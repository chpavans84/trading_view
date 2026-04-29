/**
 * Calculates forward returns for every historical score and detects dips with reasons.
 * For each score_date: what was the return 1d / 1w / 1m / 3m later?
 * Also flags significant dips (>4% drop in 5 days) and classifies the reason.
 *
 * Run:  npm run research:backtest
 */

import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Build a price lookup map for fast access: { symbol: { 'YYYY-MM-DD': close } }
async function buildPriceMap() {
  const { rows } = await pool.query(
    `SELECT symbol, price_date, close FROM backtest_prices ORDER BY symbol, price_date`
  );
  const map = {};
  for (const r of rows) {
    const sym  = r.symbol;
    const date = r.price_date.toISOString().split('T')[0];
    if (!map[sym]) map[sym] = {};
    map[sym][date] = parseFloat(r.close);
  }
  return map;
}

// Get sorted trading dates for a symbol
function getSortedDates(priceMap, symbol) {
  return Object.keys(priceMap[symbol] || {}).sort();
}

// Get price N trading days after a given date
function priceAfterNDays(priceMap, symbol, fromDate, n) {
  const dates = getSortedDates(priceMap, symbol);
  const idx   = dates.indexOf(fromDate);
  if (idx < 0) return null;
  const targetIdx = idx + n;
  if (targetIdx >= dates.length) return null;
  return priceMap[symbol][dates[targetIdx]];
}

// Detect dip reason based on price context + VIX
function detectDipReason(priceMap, symbol, date, dipPct, vixMap) {
  const vix = vixMap[date];
  const reasons = [];

  // Market-wide crash (VIX spike)
  if (vix != null && vix > 30) reasons.push(`market fear (VIX ${vix.toFixed(0)})`);

  // Deep dip
  if (dipPct <= -0.10) reasons.push('severe selloff >10%');
  else if (dipPct <= -0.06) reasons.push('significant drop >6%');

  // Check if SPY also dropped (market-wide vs stock-specific)
  const spyDrop = priceAfterNDays(priceMap, 'SPY', date, 5);
  const spyBase = priceMap['SPY']?.[date];
  if (spyBase && spyDrop) {
    const spyChange = (spyDrop - spyBase) / spyBase;
    if (spyChange < -0.03) reasons.push('broad market selloff');
    else reasons.push('stock-specific dip');
  }

  return reasons.length ? reasons.join(', ') : 'minor pullback';
}

async function run() {
  console.log('\n📊  Building price maps...');
  const priceMap = await buildPriceMap();

  // VIX map for market fear detection
  const vixMap = priceMap['^VIX'] || {};

  // Load all scores
  const { rows: scores } = await pool.query(
    `SELECT symbol, score_date, score, grade FROM backtest_scores ORDER BY symbol, score_date`
  );
  console.log(`    ${scores.length} scores to process\n`);

  let done = 0, inserted = 0;
  const BATCH = 5000;

  for (let i = 0; i < scores.length; i += BATCH) {
    const batch  = scores.slice(i, i + BATCH);
    const values = [];

    for (const s of batch) {
      const sym    = s.symbol;
      const date   = s.score_date.toISOString().split('T')[0];
      const grade  = s.grade;
      const score  = parseFloat(s.score);
      const base   = priceMap[sym]?.[date];
      if (!base) continue;

      const p1d = priceAfterNDays(priceMap, sym, date, 1);
      const p1w = priceAfterNDays(priceMap, sym, date, 5);
      const p1m = priceAfterNDays(priceMap, sym, date, 21);
      const p3m = priceAfterNDays(priceMap, sym, date, 63);

      const ret1d = p1d ? (p1d - base) / base : null;
      const ret1w = p1w ? (p1w - base) / base : null;
      const ret1m = p1m ? (p1m - base) / base : null;
      const ret3m = p3m ? (p3m - base) / base : null;

      // SPY benchmark returns
      const spyBase = priceMap['SPY']?.[date];
      const spy1d   = priceAfterNDays(priceMap, 'SPY', date, 1);
      const spy1w   = priceAfterNDays(priceMap, 'SPY', date, 5);
      const spy1m   = priceAfterNDays(priceMap, 'SPY', date, 21);
      const spy3m   = priceAfterNDays(priceMap, 'SPY', date, 63);

      // Dip detection: >4% drop in next 5 days
      let dipPct = null, dipReason = null;
      if (p1w != null && (p1w - base) / base <= -0.04) {
        dipPct    = (p1w - base) / base;
        dipReason = detectDipReason(priceMap, sym, date, dipPct, vixMap);
      }

      values.push([
        sym, date, grade, score,
        ret1d, ret1w, ret1m, ret3m,
        spyBase && spy1d ? (spy1d - spyBase) / spyBase : null,
        spyBase && spy1w ? (spy1w - spyBase) / spyBase : null,
        spyBase && spy1m ? (spy1m - spyBase) / spyBase : null,
        spyBase && spy3m ? (spy3m - spyBase) / spyBase : null,
        dipPct, dipReason,
      ]);
    }

    // Bulk upsert
    for (const v of values) {
      await pool.query(
        `INSERT INTO backtest_returns
           (symbol, score_date, grade, score, ret_1d, ret_1w, ret_1m, ret_3m,
            spy_1d, spy_1w, spy_1m, spy_3m, dip_pct, dip_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (symbol, score_date) DO UPDATE SET
           grade=EXCLUDED.grade, score=EXCLUDED.score,
           ret_1d=EXCLUDED.ret_1d, ret_1w=EXCLUDED.ret_1w,
           ret_1m=EXCLUDED.ret_1m, ret_3m=EXCLUDED.ret_3m,
           spy_1d=EXCLUDED.spy_1d, spy_1w=EXCLUDED.spy_1w,
           spy_1m=EXCLUDED.spy_1m, spy_3m=EXCLUDED.spy_3m,
           dip_pct=EXCLUDED.dip_pct, dip_reason=EXCLUDED.dip_reason`,
        v
      );
      inserted++;
    }

    done += batch.length;
    console.log(`  ${done.toLocaleString()} / ${scores.length.toLocaleString()} processed...`);
  }

  // Print summary stats
  console.log('\n\n══════════════════════════════════════════');
  console.log('  BACKTEST RESULTS SUMMARY');
  console.log('══════════════════════════════════════════\n');

  const { rows: summary } = await pool.query(`
    SELECT
      grade,
      COUNT(*)                                    as picks,
      ROUND(AVG(ret_1w)  * 100, 2)               as avg_ret_1w,
      ROUND(AVG(ret_1m)  * 100, 2)               as avg_ret_1m,
      ROUND(AVG(ret_3m)  * 100, 2)               as avg_ret_3m,
      ROUND(AVG(spy_1m)  * 100, 2)               as spy_avg_1m,
      ROUND(AVG(ret_1m - spy_1m) * 100, 2)       as alpha_1m,
      ROUND(100.0 * SUM(CASE WHEN ret_1w > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate_1w,
      ROUND(100.0 * SUM(CASE WHEN ret_1m > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate_1m
    FROM backtest_returns
    WHERE ret_1w IS NOT NULL AND ret_1m IS NOT NULL
    GROUP BY grade ORDER BY grade
  `);

  console.log('Grade | Picks   | Avg 1W%  | Avg 1M%  | Avg 3M%  | SPY 1M%  | Alpha 1M | Win% 1W | Win% 1M');
  console.log('------|---------|----------|----------|----------|----------|----------|---------|--------');
  for (const r of summary) {
    console.log(
      `  ${r.grade}   | ${String(r.picks).padStart(7)} | ${String(r.avg_ret_1w).padStart(8)} | ` +
      `${String(r.avg_ret_1m).padStart(8)} | ${String(r.avg_ret_3m).padStart(8)} | ` +
      `${String(r.spy_avg_1m).padStart(8)} | ${String(r.alpha_1m).padStart(8)} | ` +
      `${String(r.win_rate_1w).padStart(7)} | ${String(r.win_rate_1m).padStart(7)}`
    );
  }

  console.log(`\n✅  Done. ${inserted.toLocaleString()} return records written.\n`);
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
