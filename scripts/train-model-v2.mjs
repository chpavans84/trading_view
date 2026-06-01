#!/usr/bin/env node
/**
 * scripts/train-model-v2.mjs
 *
 * Phase B5 forward-prediction model.
 *
 * Trains a logistic regression classifier on v_ml_training_set (~480K rows
 * with forward-return labels) to predict whether a stock will move ≥+2% in
 * the next 5 trading days.
 *
 * Features (21):
 *   Intraday momentum  : full_day_chg, pre_change, intraday_chg, post_change,
 *                        intraday_range, or_range, rvol_30d, first_30min_pct_vol,
 *                        above_vwap, above_or_high, below_or_low
 *   Sector regime      : sector_rank, sector_chg, sector_mom, sector_rel_vs_spy
 *   Earnings           : days_to_earnings, last_surprise_pct
 *   Smart-money flow   : uw_flow_24h_premium, uw_flow_24h_count, uw_flow_bullish_pct,
 *                        insider_net_30d, insider_cluster_30d
 *
 * Compared to v1 (AUC=0.536, ~11 features mostly RSI/EMA/VIX):
 *   - Adds full-universe intraday momentum
 *   - Adds sector rotation context
 *   - Adds earnings-window proximity
 *   - Adds UW smart-money flow density
 *
 * Train/test split: by DATE (newest 20% = test). No symbol leakage either way.
 *
 * Output: writes weights to `model_results` (next id) for live use in scoring.js.
 *
 * Usage:
 *   node scripts/train-model-v2.mjs
 *   node scripts/train-model-v2.mjs --epochs 1000 --lr 0.05
 *   node scripts/train-model-v2.mjs --label 10d   # predict ret_10d_pct > 5% instead
 *   node scripts/train-model-v2.mjs --dry-run     # don't write to model_results
 */

import '../src/core/env-loader.js';
import { initDb, query } from '../src/core/db.js';

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg  = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const hasFlag = (n) => args.includes(`--${n}`);

const EPOCHS    = parseInt(getArg('epochs', '300'), 10);
const LR        = parseFloat(getArg('lr', '0.05'));
const L2        = parseFloat(getArg('l2', '0.01'));
const LABEL     = getArg('label', '5d');          // '5d' (up_2pct_5d) | '10d' (up_5pct_10d)
const TEST_FRAC = parseFloat(getArg('test-frac', '0.20'));
const DRY_RUN   = hasFlag('dry-run');

const LABEL_COL = LABEL === '10d' ? 'label_up_5pct_10d' : 'label_up_2pct_5d';
const RET_COL   = LABEL === '10d' ? 'ret_10d_pct'        : 'ret_5d_pct';

// ─── Feature definitions ──────────────────────────────────────────────────────
// Each feature: name + normaliser (raw value → roughly [-1, 1] range)
// NULL handling: returns the "neutral" value (typically 0)
const FEATURES = [
  // Intraday momentum
  { col: 'full_day_chg_pct',    norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 10)) },
  { col: 'pre_change_pct',      norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 5))  },
  { col: 'intraday_chg_pct',    norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 5))  },
  { col: 'post_change_pct',     norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 5))  },
  { col: 'intraday_range_pct',  norm: v => v == null ? 0 : Math.min(3, v / 5) },              // volatility
  { col: 'or_range_pct',        norm: v => v == null ? 0 : Math.min(3, v / 3) },
  { col: 'rvol_30d',            norm: v => v == null ? 0 : Math.min(5, Math.max(0, v - 1)) }, // 1× = neutral
  { col: 'first_30min_pct_vol', norm: v => v == null ? 0 : Math.min(2, v / 10) },             // % of day's vol in opening 30m
  { col: 'above_vwap',          norm: v => v == null ? 0 : v },
  { col: 'above_or_high',       norm: v => v == null ? 0 : v },
  { col: 'below_or_low',        norm: v => v == null ? 0 : v },

  // Sector regime
  { col: 'sector_rank',         norm: v => v == null ? 0 : (6 - v) / 5 },        // rank 1=+1, rank 11=-1
  { col: 'sector_chg',          norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 2)) },
  { col: 'sector_mom',          norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 3)) },
  { col: 'sector_rel_vs_spy',   norm: v => v == null ? 0 : Math.max(-2, Math.min(2, v / 2)) },

  // Earnings proximity
  { col: 'days_to_earnings',    norm: v => v == null ? 0 : v <= 0 ? -1 : v <= 7 ? 1 : v <= 30 ? 0.3 : 0 },
  { col: 'last_surprise_pct',   norm: v => v == null ? 0 : Math.max(-1, Math.min(1, v / 20)) },

  // Smart money
  { col: 'uw_flow_24h_premium', norm: v => v == null ? 0 : Math.min(3, Math.log10(Math.max(1, Number(v))) - 5) },  // log-scale, $100K=0, $1M≈1, $100M≈3
  { col: 'uw_flow_24h_count',   norm: v => v == null ? 0 : Math.min(2, Math.log10(Math.max(1, Number(v) + 1))) },
  { col: 'uw_flow_bullish_pct', norm: v => v == null ? 0 : (Number(v) - 50) / 50 },                                  // -1 (all bearish) to +1 (all bullish)
  { col: 'insider_net_30d',     norm: v => {
      if (v == null) return 0;
      const n = Number(v);
      const log = Math.log10(Math.abs(n) + 1);
      return Math.sign(n) * Math.min(2, log - 4);   // $10K threshold floor, log signed
    }},
  { col: 'insider_cluster_30d', norm: v => v == null ? 0 : Math.min(3, Number(v)) },
];

const N_FEATURES = FEATURES.length + 1;  // +1 for bias term

// ─── Logistic regression ──────────────────────────────────────────────────────
function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z)))); }

function trainLogReg(X, y, opts) {
  const { epochs, lr, l2 } = opts;
  const n = X.length;
  const d = X[0].length;
  const w = new Float64Array(d);  // initialized to 0

  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Float64Array(d);
    let loss = 0;
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const p = sigmoid(z);
      const err = p - y[i];
      for (let j = 0; j < d; j++) grad[j] += err * X[i][j];
      // log loss for monitoring (clamp to avoid log(0))
      const pSafe = Math.max(1e-7, Math.min(1 - 1e-7, p));
      loss += -y[i] * Math.log(pSafe) - (1 - y[i]) * Math.log(1 - pSafe);
    }
    // L2 regularization (don't regularize bias = w[0])
    for (let j = 1; j < d; j++) {
      grad[j] += l2 * w[j];
      w[j] -= lr * grad[j] / n;
    }
    w[0] -= lr * grad[0] / n;   // bias

    if (epoch % 50 === 0 || epoch === epochs - 1) {
      console.log(`  epoch ${String(epoch).padStart(4)}  loss=${(loss / n).toFixed(4)}`);
    }
  }
  return w;
}

function predict(w, x) {
  let z = 0;
  for (let j = 0; j < x.length; j++) z += w[j] * x[j];
  return sigmoid(z);
}

function rocAuc(yTrue, yProb) {
  // Pair (y, p), sort by p desc, then walk computing TPR/FPR
  const pairs = yTrue.map((y, i) => [y, yProb[i]]).sort((a, b) => b[1] - a[1]);
  const P = pairs.filter(p => p[0] === 1).length;
  const N = pairs.length - P;
  if (P === 0 || N === 0) return NaN;
  let tp = 0, fp = 0, prevTp = 0, prevFp = 0, auc = 0;
  for (const [y] of pairs) {
    if (y === 1) tp++;
    else         fp++;
    // every step: add trapezoid area between prev and current
    auc += (fp - prevFp) * (tp + prevTp) / 2;
    prevTp = tp; prevFp = fp;
  }
  return auc / (P * N);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  await initDb();

  console.log(`[train-v2] loading training set (label=${LABEL_COL})…`);
  const t0 = Date.now();
  const { rows } = await query(`
    SELECT
      ${FEATURES.map(f => f.col).join(', ')},
      ${LABEL_COL} AS y,
      price_date,
      symbol,
      ${RET_COL} AS ret_pct
      FROM v_ml_training_set
     WHERE ${LABEL_COL} IS NOT NULL
       AND ${RET_COL} IS NOT NULL
       AND reg_close > 1
     ORDER BY price_date ASC, symbol ASC
  `);
  console.log(`[train-v2] loaded ${rows.length.toLocaleString()} rows in ${((Date.now() - t0)/1000).toFixed(1)}s`);

  if (rows.length < 5000) { console.error('[train-v2] too few rows'); process.exit(1); }

  // Date-based split — newest TEST_FRAC = test, no symbol leakage either way
  const splitIdx = Math.floor(rows.length * (1 - TEST_FRAC));
  const splitDate = rows[splitIdx].price_date;
  console.log(`[train-v2] split at ${splitDate.toISOString?.()?.slice(0,10) ?? splitDate}: train=${splitIdx}, test=${rows.length - splitIdx}`);

  // Build feature matrices
  const buildXY = (slice) => {
    const X = new Array(slice.length);
    const y = new Float64Array(slice.length);
    const ret = new Float64Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      const r = slice[i];
      const x = new Float64Array(N_FEATURES);
      x[0] = 1;  // bias
      for (let j = 0; j < FEATURES.length; j++) {
        x[j + 1] = FEATURES[j].norm(r[FEATURES[j].col]);
      }
      X[i] = x;
      y[i] = Number(r.y);
      ret[i] = Number(r.ret_pct);
    }
    return { X, y, ret };
  };

  const train = buildXY(rows.slice(0, splitIdx));
  const test  = buildXY(rows.slice(splitIdx));

  // Class balance
  const trainPos = train.y.reduce((a, b) => a + b, 0);
  const testPos  = test.y.reduce((a, b) => a + b, 0);
  console.log(`[train-v2] class balance — train: ${(trainPos / train.y.length * 100).toFixed(1)}% positive, test: ${(testPos / test.y.length * 100).toFixed(1)}% positive`);

  // Train
  console.log(`[train-v2] training (epochs=${EPOCHS}, lr=${LR}, l2=${L2})…`);
  const tTrain = Date.now();
  const w = trainLogReg(train.X, train.y, { epochs: EPOCHS, lr: LR, l2: L2 });
  console.log(`[train-v2] trained in ${((Date.now() - tTrain)/1000).toFixed(1)}s`);

  // Evaluate on test
  const testProb = new Float64Array(test.X.length);
  for (let i = 0; i < test.X.length; i++) testProb[i] = predict(w, test.X[i]);

  const auc = rocAuc(Array.from(test.y), Array.from(testProb));
  // Threshold metrics at 0.5
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

  // Top-decile lift: of stocks the model rates HIGHEST, what's the actual avg return?
  const sorted = test.y.map((y, i) => ({ y, p: testProb[i], ret: test.ret[i] }))
                       .sort((a, b) => b.p - a.p);
  const top10pct = sorted.slice(0, Math.floor(sorted.length * 0.10));
  const top10Mean = top10pct.reduce((s, r) => s + r.ret, 0) / top10pct.length;
  const top10Win  = top10pct.filter(r => r.y === 1).length / top10pct.length;
  const allMean   = test.ret.reduce((a, b) => a + b, 0) / test.ret.length;

  console.log('\n[train-v2] === RESULTS ===');
  console.log(`  AUC          : ${auc.toFixed(4)}    (baseline v1 = 0.536, random = 0.5)`);
  console.log(`  Accuracy     : ${(accuracy * 100).toFixed(2)}%`);
  console.log(`  Precision    : ${(precision * 100).toFixed(2)}%   (when model says BUY, % that actually went up)`);
  console.log(`  Recall       : ${(recall * 100).toFixed(2)}%   (of actual winners, % the model caught)`);
  console.log(`  F1           : ${f1.toFixed(4)}`);
  console.log(`  Top-10% lift : avg ret = +${top10Mean.toFixed(2)}%  (vs all-rows mean +${allMean.toFixed(2)}%)`);
  console.log(`  Top-10% win% : ${(top10Win * 100).toFixed(1)}%   (vs base rate ${(testPos / test.y.length * 100).toFixed(1)}%)`);

  // Feature weights — sorted by abs magnitude (most influential first)
  console.log('\n[train-v2] === FEATURE WEIGHTS (sorted by influence) ===');
  console.log(`  bias                    : ${w[0].toFixed(4)}`);
  const wList = FEATURES.map((f, i) => ({ name: f.col, w: w[i + 1] }));
  wList.sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  for (const { name, w: ww } of wList) {
    const bar = '█'.repeat(Math.min(40, Math.round(Math.abs(ww) * 40)));
    console.log(`  ${name.padEnd(22)}: ${(ww >= 0 ? '+' : '')}${ww.toFixed(4).padStart(8)}  ${ww >= 0 ? '🟢' : '🔴'} ${bar}`);
  }

  if (DRY_RUN) {
    console.log('\n[train-v2] dry-run — NOT writing to model_results');
    process.exit(0);
  }

  // Store in model_results
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
    JSON.stringify({ A: 1, B: 0, C: 0, F: 0, label: LABEL_COL, version: 'v2-phaseB5' }),
  ]);
  console.log('\n[train-v2] ✅ stored in model_results');

  process.exit(0);
}

main().catch(e => { console.error('[train-v2] FATAL:', e); process.exit(1); });
