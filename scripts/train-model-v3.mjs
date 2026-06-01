#!/usr/bin/env node
/**
 * scripts/train-model-v3.mjs — Phase B5 Iteration 1
 *
 * Adds the features that the v2→backtest deep research identified as gaps:
 *   • VIX level + vix_above_20 regime gate
 *   • SPY 5-day momentum (market regime)
 *   • Day-of-week dummies (Wed/Thu were +6-8pp better)
 *   • Market cap band ordinal + is_mid_cap flag
 *   • Sector one-hot dummies (11 sectors — captures per-sector intercepts)
 *   • Quadratic UW bullish % (mixed flow 40-60% outperforms extremes)
 *
 * Target: AUC 0.582 → 0.62+, win rate 51% → 65%+
 *
 * Writes to model_results with scoring_adjustments.version = 'v3-phaseB5-iter1'.
 */

import '../src/core/env-loader.js';
import { initDb, query } from '../src/core/db.js';

const args = process.argv.slice(2);
const getArg  = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const hasFlag = (n) => args.includes(`--${n}`);

const EPOCHS    = parseInt(getArg('epochs', '400'), 10);
const LR        = parseFloat(getArg('lr', '0.05'));
const L2        = parseFloat(getArg('l2', '0.01'));
const LABEL     = getArg('label', '5d');
const TEST_FRAC = parseFloat(getArg('test-frac', '0.20'));
const DRY_RUN   = hasFlag('dry-run');

const LABEL_COL = LABEL === '10d' ? 'label_up_5pct_10d' : 'label_up_2pct_5d';
const RET_COL   = LABEL === '10d' ? 'ret_10d_pct'        : 'ret_5d_pct';

// ─── Feature set v3: 22 original + 16 new = 38 features ───────────────────────
const FEATURES = [
  // — Intraday momentum (v2 carryover) —
  { col: 'full_day_chg_pct',    norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 10)) },
  { col: 'pre_change_pct',      norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 5))  },
  { col: 'intraday_chg_pct',    norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 5))  },
  { col: 'post_change_pct',     norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 5))  },
  { col: 'intraday_range_pct',  norm: v => v == null ? 0 : Math.min(3, v / 5) },
  { col: 'or_range_pct',        norm: v => v == null ? 0 : Math.min(3, v / 3) },
  { col: 'rvol_30d',            norm: v => v == null ? 0 : Math.min(5, Math.max(0, v - 1)) },
  { col: 'first_30min_pct_vol', norm: v => v == null ? 0 : Math.min(2, v / 10) },
  { col: 'above_vwap',          norm: v => v == null ? 0 : Number(v) },
  { col: 'above_or_high',       norm: v => v == null ? 0 : Number(v) },
  { col: 'below_or_low',        norm: v => v == null ? 0 : Number(v) },

  // — Sector regime (v2 carryover) —
  { col: 'sector_rank',         norm: v => v == null ? 0 : (6 - v) / 5 },
  { col: 'sector_chg',          norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 2)) },
  { col: 'sector_mom',          norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 3)) },
  { col: 'sector_rel_vs_spy',   norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 2)) },

  // — Earnings (v2 carryover) —
  { col: 'days_to_earnings',    norm: v => v == null ? 0 : v <= 0 ? -1 : v <= 7 ? 1 : v <= 30 ? 0.3 : 0 },
  { col: 'last_surprise_pct',   norm: v => v == null ? 0 : Math.max(-1, Math.min(1, v / 20)) },

  // — Smart money (v2 carryover) —
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

  // ─── NEW v3 features ─────────────────────────────────────────────────────────
  // Market regime gates
  { col: 'vix_close',           norm: v => v == null ? 0 : (Number(v) - 18) / 8 },                  // 18 ≈ historic mean, scaled by ~1 SD
  { col: 'vix_above_20',        norm: v => v == null ? 0 : Number(v) },                              // binary
  { col: 'spy_5d_chg',          norm: v => v == null ? 0 : Math.max(-2, Math.min(2, Number(v)/2)) }, // SPY momentum scaled

  // Day-of-week (Wed/Thu best)
  { col: 'is_wed',              norm: v => v == null ? 0 : Number(v) },
  { col: 'is_thu',              norm: v => v == null ? 0 : Number(v) },
  { col: 'is_mon_fri',          norm: v => v == null ? 0 : Number(v) },

  // Market cap (mid-cap = sweet spot)
  { col: 'is_mid_cap',          norm: v => v == null ? 0 : Number(v) },
  { col: 'market_cap_band',     norm: v => v == null ? 0 : Math.max(-1, Math.min(1, (3 - Number(v)) / 2)) }, // mid (3) = 0, mega (1) = +1, micro (5) = -1

  // Sector dummies (11 — let model learn per-sector intercepts)
  { col: 'sect_tech',           norm: v => v == null ? 0 : Number(v) },
  { col: 'sect_fin',            norm: v => v == null ? 0 : Number(v) },
  { col: 'sect_health',         norm: v => v == null ? 0 : Number(v) },
  { col: 'sect_cycl',           norm: v => v == null ? 0 : Number(v) },
  { col: 'sect_def',            norm: v => v == null ? 0 : Number(v) },
  { col: 'sect_energy',         norm: v => v == null ? 0 : Number(v) },
  { col: 'sect_util',           norm: v => v == null ? 0 : Number(v) },
  { col: 'sect_mat',            norm: v => v == null ? 0 : Number(v) },
  { col: 'sect_indust',         norm: v => v == null ? 0 : Number(v) },
  { col: 'sect_comm',           norm: v => v == null ? 0 : Number(v) },
  { col: 'sect_re',             norm: v => v == null ? 0 : Number(v) },

  // Quadratic UW bullish (peaks at 50% = mixed flow)
  // Centered at 50: 0 when bull%=50, ±1 at 0 or 100
  { col: 'uw_bull_centered',    norm: v => v == null ? 0 : Math.max(-1, Math.min(1, Number(v) / 50)) },
  // Quadratic: penalty for extreme flow (close to 0 or 100). Normalized to ~0-1.
  { col: 'uw_bull_sq',          norm: v => v == null ? 0 : Math.min(1, Number(v) / 2500) },
];

const N_FEATURES = FEATURES.length + 1;

// ─── Logistic regression (same as v2 — minor: epochs default 400) ────────────
function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z)))); }

function trainLogReg(X, y, opts) {
  const { epochs, lr, l2 } = opts;
  const n = X.length, d = X[0].length;
  const w = new Float64Array(d);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Float64Array(d);
    let loss = 0;
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const p = sigmoid(z);
      const err = p - y[i];
      for (let j = 0; j < d; j++) grad[j] += err * X[i][j];
      const pSafe = Math.max(1e-7, Math.min(1 - 1e-7, p));
      loss += -y[i] * Math.log(pSafe) - (1 - y[i]) * Math.log(1 - pSafe);
    }
    for (let j = 1; j < d; j++) {
      grad[j] += l2 * w[j];
      w[j] -= lr * grad[j] / n;
    }
    w[0] -= lr * grad[0] / n;
    if (epoch % 50 === 0 || epoch === epochs - 1) {
      console.log(`  epoch ${String(epoch).padStart(4)}  loss=${(loss / n).toFixed(4)}`);
    }
  }
  return w;
}

function predict(w, x) { let z = 0; for (let j = 0; j < x.length; j++) z += w[j] * x[j]; return sigmoid(z); }

function rocAuc(yTrue, yProb) {
  const pairs = yTrue.map((y, i) => [y, yProb[i]]).sort((a, b) => b[1] - a[1]);
  const P = pairs.filter(p => p[0] === 1).length;
  const N = pairs.length - P;
  if (P === 0 || N === 0) return NaN;
  let tp = 0, fp = 0, prevTp = 0, prevFp = 0, auc = 0;
  for (const [y] of pairs) {
    if (y === 1) tp++; else fp++;
    auc += (fp - prevFp) * (tp + prevTp) / 2;
    prevTp = tp; prevFp = fp;
  }
  return auc / (P * N);
}

async function main() {
  await initDb();
  console.log(`[train-v3] loading training set (label=${LABEL_COL})…`);
  const t0 = Date.now();
  const { rows } = await query(`
    SELECT ${FEATURES.map(f => f.col).join(', ')},
           ${LABEL_COL} AS y, price_date, symbol, ${RET_COL} AS ret_pct
      FROM v_ml_training_set
     WHERE ${LABEL_COL} IS NOT NULL AND ${RET_COL} IS NOT NULL AND reg_close > 1
     ORDER BY price_date ASC, symbol ASC
  `);
  console.log(`[train-v3] loaded ${rows.length.toLocaleString()} rows in ${((Date.now() - t0)/1000).toFixed(1)}s`);

  const splitIdx = Math.floor(rows.length * (1 - TEST_FRAC));
  const splitDate = rows[splitIdx].price_date;
  console.log(`[train-v3] split at ${splitDate.toISOString?.()?.slice(0,10) ?? splitDate}: train=${splitIdx}, test=${rows.length - splitIdx}`);

  const buildXY = (slice) => {
    const X = new Array(slice.length);
    const y = new Float64Array(slice.length);
    const ret = new Float64Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      const r = slice[i];
      const x = new Float64Array(N_FEATURES);
      x[0] = 1;
      for (let j = 0; j < FEATURES.length; j++) x[j + 1] = FEATURES[j].norm(r[FEATURES[j].col]);
      X[i] = x;
      y[i] = Number(r.y);
      ret[i] = Number(r.ret_pct);
    }
    return { X, y, ret };
  };

  const train = buildXY(rows.slice(0, splitIdx));
  const test  = buildXY(rows.slice(splitIdx));

  const trainPos = train.y.reduce((a, b) => a + b, 0);
  const testPos  = test.y.reduce((a, b) => a + b, 0);
  console.log(`[train-v3] class balance — train: ${(trainPos / train.y.length * 100).toFixed(1)}% positive, test: ${(testPos / test.y.length * 100).toFixed(1)}% positive`);
  console.log(`[train-v3] features: ${FEATURES.length} (v2 was 22)`);

  console.log(`[train-v3] training (epochs=${EPOCHS}, lr=${LR}, l2=${L2})…`);
  const tTrain = Date.now();
  const w = trainLogReg(train.X, train.y, { epochs: EPOCHS, lr: LR, l2: L2 });
  console.log(`[train-v3] trained in ${((Date.now() - tTrain)/1000).toFixed(1)}s`);

  const testProb = new Float64Array(test.X.length);
  for (let i = 0; i < test.X.length; i++) testProb[i] = predict(w, test.X[i]);
  const auc = rocAuc(Array.from(test.y), Array.from(testProb));

  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < test.y.length; i++) {
    const pred = testProb[i] >= 0.5 ? 1 : 0;
    if (test.y[i] === 1 && pred === 1) tp++;
    else if (test.y[i] === 0 && pred === 1) fp++;
    else if (test.y[i] === 1 && pred === 0) fn++;
    else tn++;
  }
  const accuracy  = (tp + tn) / test.y.length;
  const precision = tp / Math.max(1, tp + fp);
  const recall    = tp / Math.max(1, tp + fn);
  const f1        = 2 * precision * recall / Math.max(1e-9, precision + recall);

  const sorted = test.y.map((y, i) => ({ y, p: testProb[i], ret: test.ret[i] }))
                       .sort((a, b) => b.p - a.p);
  const top10pct = sorted.slice(0, Math.floor(sorted.length * 0.10));
  const top10Win  = top10pct.filter(r => r.y === 1).length / top10pct.length;
  const top10Mean = top10pct.reduce((s, r) => s + (Number.isFinite(r.ret) ? r.ret : 0), 0) / top10pct.length;

  console.log('\n[train-v3] === RESULTS ===');
  console.log(`  AUC          : ${auc.toFixed(4)}    (v2 = 0.5822, random = 0.5)`);
  console.log(`  Accuracy     : ${(accuracy * 100).toFixed(2)}%`);
  console.log(`  Precision    : ${(precision * 100).toFixed(2)}%`);
  console.log(`  Recall       : ${(recall * 100).toFixed(2)}%`);
  console.log(`  F1           : ${f1.toFixed(4)}`);
  console.log(`  Top-10% win% : ${(top10Win * 100).toFixed(1)}%   (base ${(testPos / test.y.length * 100).toFixed(1)}%)`);
  console.log(`  Top-10% lift : +${top10Mean.toFixed(2)}% avg 5d return`);

  console.log('\n[train-v3] === FEATURE WEIGHTS (sorted by influence) ===');
  console.log(`  bias                    : ${w[0].toFixed(4)}`);
  const wList = FEATURES.map((f, i) => ({ name: f.col, w: w[i + 1] }));
  wList.sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  for (const { name, w: ww } of wList) {
    const bar = '█'.repeat(Math.min(30, Math.round(Math.abs(ww) * 30)));
    console.log(`  ${name.padEnd(22)}: ${(ww >= 0 ? '+' : '')}${ww.toFixed(4).padStart(8)}  ${ww >= 0 ? '🟢' : '🔴'} ${bar}`);
  }

  if (DRY_RUN) {
    console.log('\n[train-v3] dry-run — NOT writing to model_results');
    process.exit(0);
  }

  const featureWeights = { bias: w[0] };
  FEATURES.forEach((f, i) => { featureWeights[f.col] = w[i + 1]; });
  await query(`
    INSERT INTO model_results
      (trained_at, train_rows, test_rows, accuracy, precision_1, recall_1, f1_1, auc_roc,
       feature_weights, scoring_adjustments)
    VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
  `, [
    train.y.length, test.y.length, accuracy, precision, recall, f1, auc,
    JSON.stringify(featureWeights),
    JSON.stringify({ A: 1, B: 0, C: 0, F: 0, label: LABEL_COL, version: 'v3-phaseB5-iter1' }),
  ]);
  console.log('\n[train-v3] ✅ stored in model_results');
  process.exit(0);
}

main().catch(e => { console.error('[train-v3] FATAL:', e); process.exit(1); });
