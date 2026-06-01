#!/usr/bin/env node
/**
 * scripts/build-stock-correlations.mjs
 *
 * Compute pairwise daily-return correlations across liquid symbols using
 * Postgres's built-in corr() aggregate. Output → stock_correlations table.
 *
 * Strategy:
 *   1. Pick top-N symbols by avg daily volume (default N=500)
 *   2. Self-join daily_intraday_features (A × B WHERE A < B)
 *   3. GROUP BY pair, aggregate corr() over 30/90/252 day windows
 *   4. Keep only pairs with ABS(corr_90d) >= 0.30 (filters out noise)
 *
 * For N=500 → 124,750 unique pairs. For each pair, 252 rows joined → 31M JOIN rows.
 * Postgres processes this in ~5-15 min on the indexed daily_intraday_features.
 *
 * Usage:
 *   node scripts/build-stock-correlations.mjs            # default N=500, threshold 0.30
 *   node scripts/build-stock-correlations.mjs --n 1000 --threshold 0.40
 *   node scripts/build-stock-correlations.mjs --reset    # TRUNCATE first
 */

import '../src/core/env-loader.js';
import { initDb, query } from '../src/core/db.js';

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const N         = parseInt(getArg('n', '500'), 10);
const THRESHOLD = parseFloat(getArg('threshold', '0.30'));
const RESET     = args.includes('--reset');

async function main() {
  await initDb();

  if (RESET) {
    console.log('[corr] TRUNCATE stock_correlations');
    await query('TRUNCATE stock_correlations');
  }

  // 1. Pick top-N liquid symbols from features table (avg total_volume × close approximates dollar volume)
  console.log(`[corr] selecting top ${N} symbols by recent dollar volume`);
  const t0 = Date.now();
  const { rows: topSyms } = await query(`
    SELECT symbol
      FROM daily_intraday_features
     WHERE price_date >= CURRENT_DATE - INTERVAL '30 days'
       AND reg_close > 1
     GROUP BY symbol
    HAVING COUNT(*) >= 15        -- at least half the recent month traded
       AND AVG(total_volume * reg_close) > 0
     ORDER BY AVG(total_volume * reg_close) DESC
     LIMIT $1
  `, [N]);
  console.log(`[corr] picked ${topSyms.length} symbols in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`[corr] top 10: ${topSyms.slice(0, 10).map(r => r.symbol).join(', ')}`);

  if (topSyms.length < 50) {
    console.error('[corr] too few symbols — abort');
    process.exit(1);
  }

  const symList = topSyms.map(r => `'${r.symbol.replace(/'/g, "''")}'`).join(',');

  // 2. Compute correlations in one big SQL pass
  console.log(`[corr] computing pairwise correlations (this is the heavy step — ~5-15 min for N=${N})`);
  const tCorr = Date.now();

  const insertSql = `
    INSERT INTO stock_correlations
      (symbol_a, symbol_b, corr_30d, corr_90d, corr_252d, obs_30d, obs_90d, obs_252d, computed_at)
    SELECT
      a.symbol AS symbol_a,
      b.symbol AS symbol_b,
      ROUND(corr(a.full_day_chg_pct, b.full_day_chg_pct) FILTER (WHERE a.price_date >= CURRENT_DATE - INTERVAL '30 days')::numeric, 4)  AS corr_30d,
      ROUND(corr(a.full_day_chg_pct, b.full_day_chg_pct) FILTER (WHERE a.price_date >= CURRENT_DATE - INTERVAL '90 days')::numeric, 4)  AS corr_90d,
      ROUND(corr(a.full_day_chg_pct, b.full_day_chg_pct)::numeric, 4)                                                                    AS corr_252d,
      COUNT(*) FILTER (WHERE a.price_date >= CURRENT_DATE - INTERVAL '30 days'  AND a.full_day_chg_pct IS NOT NULL AND b.full_day_chg_pct IS NOT NULL)::int  AS obs_30d,
      COUNT(*) FILTER (WHERE a.price_date >= CURRENT_DATE - INTERVAL '90 days'  AND a.full_day_chg_pct IS NOT NULL AND b.full_day_chg_pct IS NOT NULL)::int  AS obs_90d,
      COUNT(*) FILTER (WHERE a.full_day_chg_pct IS NOT NULL AND b.full_day_chg_pct IS NOT NULL)::int                                                          AS obs_252d,
      NOW()
      FROM daily_intraday_features a
      JOIN daily_intraday_features b
        ON a.price_date = b.price_date
       AND a.symbol < b.symbol      -- enforce A < B so each pair stored once
     WHERE a.symbol IN (${symList})
       AND b.symbol IN (${symList})
       AND a.full_day_chg_pct IS NOT NULL
       AND b.full_day_chg_pct IS NOT NULL
     GROUP BY a.symbol, b.symbol
    HAVING
      COUNT(*) FILTER (WHERE a.price_date >= CURRENT_DATE - INTERVAL '90 days') >= 30   -- min 30 paired obs in 90d
      AND ABS(corr(a.full_day_chg_pct, b.full_day_chg_pct) FILTER (WHERE a.price_date >= CURRENT_DATE - INTERVAL '90 days')) >= $1
    ON CONFLICT (symbol_a, symbol_b) DO UPDATE SET
      corr_30d    = EXCLUDED.corr_30d,
      corr_90d    = EXCLUDED.corr_90d,
      corr_252d   = EXCLUDED.corr_252d,
      obs_30d     = EXCLUDED.obs_30d,
      obs_90d     = EXCLUDED.obs_90d,
      obs_252d    = EXCLUDED.obs_252d,
      computed_at = NOW()
  `;

  const { rowCount } = await query(insertSql, [THRESHOLD]);
  const corrMin = ((Date.now() - tCorr) / 60_000).toFixed(1);
  console.log(`[corr] inserted/updated ${rowCount.toLocaleString()} correlation rows in ${corrMin} min`);

  // 3. Summary
  const { rows: stats } = await query(`
    SELECT
      COUNT(*) AS pairs,
      COUNT(*) FILTER (WHERE corr_90d >= 0.7)  AS strong_pos,
      COUNT(*) FILTER (WHERE corr_90d >= 0.5 AND corr_90d < 0.7) AS mod_pos,
      COUNT(*) FILTER (WHERE corr_90d <= -0.3) AS negative,
      ROUND(AVG(corr_90d)::numeric, 3) AS avg_corr_90d,
      MAX(corr_90d) AS max_corr,
      MIN(corr_90d) AS min_corr
      FROM stock_correlations
  `);
  console.log('[corr] summary:', stats[0]);

  // 4. Top 10 most-correlated pairs
  const { rows: top } = await query(`
    SELECT symbol_a, symbol_b, corr_90d, corr_30d, obs_90d
      FROM stock_correlations
     ORDER BY corr_90d DESC LIMIT 10
  `);
  console.log('[corr] top 10 positive pairs:');
  top.forEach(r => console.log(`  ${r.symbol_a} ↔ ${r.symbol_b}  90d=${r.corr_90d}  30d=${r.corr_30d}  N=${r.obs_90d}`));

  console.log('\n[corr] DONE');
  process.exit(0);
}

main().catch(e => { console.error('[corr] FATAL:', e); process.exit(1); });
