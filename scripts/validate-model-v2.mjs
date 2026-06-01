#!/usr/bin/env node
/**
 * scripts/validate-model-v2.mjs
 *
 * Phase B5 validation: does the v2 model's AUC=0.5822 translate to real $ edge?
 *
 * Loads the latest v2 weights from `model_results`, scores every row in
 * `v_ml_training_set` for the TEST window (post-2026-01-24), buckets by
 * predicted-probability decile, and reports actual forward returns.
 *
 * Key questions:
 *   1. Top decile avg return vs all-rows mean — is the lift positive?
 *   2. Top decile win rate vs base rate — is it materially higher?
 *   3. Bottom decile — does the model also avoid losers?
 *   4. Liquid-only top picks (the actual trading subset) — is the lift larger?
 *
 * Output: console report + writes summary to a temp markdown for sharing.
 */

import '../src/core/env-loader.js';
import { initDb, query } from '../src/core/db.js';

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const SPLIT_DATE = getArg('split', '2026-01-24');   // matches train-model-v2.mjs default split
const MIN_PRICE  = parseFloat(getArg('min-price', '5'));
const MIN_VOL    = parseFloat(getArg('min-volume', '500000'));   // 500K shares/day min

// Same feature definitions as train-model-v2.mjs (must match!)
const FEATURES = [
  { col: 'full_day_chg_pct',    norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 10)) },
  { col: 'pre_change_pct',      norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 5))  },
  { col: 'intraday_chg_pct',    norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 5))  },
  { col: 'post_change_pct',     norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 5))  },
  { col: 'intraday_range_pct',  norm: v => v == null ? 0 : Math.min(3, v / 5) },
  { col: 'or_range_pct',        norm: v => v == null ? 0 : Math.min(3, v / 3) },
  { col: 'rvol_30d',            norm: v => v == null ? 0 : Math.min(5, Math.max(0, v - 1)) },
  { col: 'first_30min_pct_vol', norm: v => v == null ? 0 : Math.min(2, v / 10) },
  { col: 'above_vwap',          norm: v => v == null ? 0 : v },
  { col: 'above_or_high',       norm: v => v == null ? 0 : v },
  { col: 'below_or_low',        norm: v => v == null ? 0 : v },
  { col: 'sector_rank',         norm: v => v == null ? 0 : (6 - v) / 5 },
  { col: 'sector_chg',          norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 2)) },
  { col: 'sector_mom',          norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 3)) },
  { col: 'sector_rel_vs_spy',   norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 2)) },
  { col: 'days_to_earnings',    norm: v => v == null ? 0 : v <= 0 ? -1 : v <= 7 ? 1 : v <= 30 ? 0.3 : 0 },
  { col: 'last_surprise_pct',   norm: v => v == null ? 0 : Math.max(-1, Math.min(1, v / 20)) },
  { col: 'uw_flow_24h_premium', norm: v => v == null ? 0 : Math.min(3, Math.log10(Math.max(1, Number(v))) - 5) },
  { col: 'uw_flow_24h_count',   norm: v => v == null ? 0 : Math.min(2, Math.log10(Math.max(1, Number(v) + 1))) },
  { col: 'uw_flow_bullish_pct', norm: v => v == null ? 0 : (Number(v) - 50) / 50 },
  { col: 'insider_net_30d',     norm: v => {
      if (v == null) return 0;
      const n = Number(v);
      const log = Math.log10(Math.abs(n) + 1);
      return Math.sign(n) * Math.min(2, log - 4);
    }},
  { col: 'insider_cluster_30d', norm: v => v == null ? 0 : Math.min(3, Number(v)) },
];

function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z)))); }

async function main() {
  await initDb();

  // 1. Load latest v2 weights
  const { rows: model } = await query(`
    SELECT id, feature_weights, auc_roc, trained_at
      FROM model_results
     WHERE scoring_adjustments->>'version' = 'v2-phaseB5'
     ORDER BY id DESC LIMIT 1
  `);
  if (!model.length) { console.error('No v2-phaseB5 model found'); process.exit(1); }
  const fw = model[0].feature_weights;
  console.log(`[validate-v2] using model id=${model[0].id}, trained ${model[0].trained_at}`);
  console.log(`[validate-v2] training AUC: ${Number(model[0].auc_roc).toFixed(4)}`);

  // Build weight vector in feature order (bias = w[0])
  const w = new Float64Array(FEATURES.length + 1);
  w[0] = fw.bias || 0;
  FEATURES.forEach((f, i) => { w[i + 1] = fw[f.col] || 0; });

  // 2. Load test-window rows + liquidity info
  console.log(`[validate-v2] loading test window (post-${SPLIT_DATE})…`);
  const t0 = Date.now();
  const { rows } = await query(`
    SELECT
      v.symbol, v.price_date, v.reg_close, v.ret_5d_pct AS ret_pct, v.label_up_2pct_5d AS y,
      ${FEATURES.map(f => `v.${f.col}`).join(', ')}
      FROM v_ml_training_set v
      JOIN daily_intraday_features dif ON dif.symbol = v.symbol AND dif.price_date = v.price_date
     WHERE v.price_date >= $1::date
       AND v.ret_5d_pct IS NOT NULL
       AND v.reg_close >= $2
       AND dif.total_volume >= $3
     ORDER BY v.price_date, v.symbol
  `, [SPLIT_DATE, MIN_PRICE, MIN_VOL]);
  console.log(`[validate-v2] ${rows.length.toLocaleString()} liquid test rows loaded in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  // 3. Score every row
  const scored = rows.map(r => {
    let z = w[0];
    for (let j = 0; j < FEATURES.length; j++) z += w[j + 1] * FEATURES[j].norm(r[FEATURES[j].col]);
    return {
      symbol: r.symbol,
      date:   r.price_date,
      prob:   sigmoid(z),
      ret:    Number(r.ret_pct),
      y:      Number(r.y),
    };
  });

  scored.sort((a, b) => b.prob - a.prob);

  const baseMean = scored.reduce((s, r) => s + r.ret, 0) / scored.length;
  const baseWin  = scored.filter(r => r.y === 1).length / scored.length;
  console.log(`\n[validate-v2] baseline (all rows): avg_ret_5d=${baseMean.toFixed(3)}%, win_rate=${(baseWin*100).toFixed(1)}%`);

  // 4. Decile analysis
  console.log('\n[validate-v2] === DECILE LIFT ===');
  console.log('  Decile (model rank)  |   N   | avg_ret_5d% | win% | lift vs base');
  console.log('  ---------------------+-------+-------------+------+-------------');
  const N = scored.length;
  for (let d = 0; d < 10; d++) {
    const start = Math.floor(d * N / 10);
    const end   = Math.floor((d + 1) * N / 10);
    const slice = scored.slice(start, end);
    const mean = slice.reduce((s, r) => s + r.ret, 0) / slice.length;
    const win  = slice.filter(r => r.y === 1).length / slice.length;
    const lift = mean - baseMean;
    const liftStr = (lift >= 0 ? '+' : '') + lift.toFixed(2) + 'pp';
    const winStr  = ((win - baseWin) * 100 >= 0 ? '+' : '') + ((win - baseWin) * 100).toFixed(1) + 'pp';
    const label = d === 0 ? 'Top 10% (BUY)    ' : d === 9 ? 'Bottom 10% (AVOID)' : `Decile ${d + 1}        `;
    console.log(`  ${label}   | ${String(slice.length).padStart(5)} | ${mean.toFixed(2).padStart(11)}% | ${(win*100).toFixed(1).padStart(4)}% | ret=${liftStr.padEnd(7)} win=${winStr}`);
  }

  // 5. Top-N picks (what the bot would actually trade)
  console.log('\n[validate-v2] === TOP-N PICKS (per scan, hypothetical) ===');
  console.log('  If we picked top-N highest-probability stocks every day:');
  const byDate = new Map();
  for (const r of scored) {
    const k = r.date.toISOString?.()?.slice(0, 10) ?? String(r.date).slice(0, 10);
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(r);
  }
  for (const N_PICK of [5, 10, 20, 50]) {
    const allPicks = [];
    for (const day of byDate.values()) {
      day.sort((a, b) => b.prob - a.prob);
      allPicks.push(...day.slice(0, N_PICK));
    }
    if (!allPicks.length) continue;
    const mean = allPicks.reduce((s, r) => s + r.ret, 0) / allPicks.length;
    const win  = allPicks.filter(r => r.y === 1).length / allPicks.length;
    const lift = mean - baseMean;
    console.log(`    Top-${String(N_PICK).padStart(2)} per day  (${allPicks.length} picks total):  avg_ret_5d=${mean.toFixed(2)}%  win=${(win*100).toFixed(1)}%  lift=${(lift >= 0 ? '+' : '')}${lift.toFixed(2)}pp`);
  }

  // 6. Show actual top-20 picks of the most recent test day for sanity
  console.log('\n[validate-v2] === SAMPLE: top 10 picks for the most recent test day ===');
  const lastDay = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]))[0];
  if (lastDay) {
    const [date, picks] = lastDay;
    picks.sort((a, b) => b.prob - a.prob);
    console.log(`  Date: ${date}`);
    console.log('  Symbol   Prob    Actual_5d_ret  Hit?');
    for (const p of picks.slice(0, 10)) {
      const hit = p.y === 1 ? '✓' : '·';
      console.log(`  ${p.symbol.padEnd(8)} ${p.prob.toFixed(3)}  ${(p.ret >= 0 ? '+' : '')}${p.ret.toFixed(2).padStart(6)}%       ${hit}`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error('[validate-v2] FATAL:', e); process.exit(1); });
