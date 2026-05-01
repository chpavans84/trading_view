/**
 * Logistic regression classifier trained from backtest data.
 * Predicts: will ret_1w > 0.5%? (label=1 vs label=0)
 *
 * No external ML libraries — pure JS math from scratch.
 *
 * Run: node --env-file=.env src/research/train-model.js
 */

import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Hyper-parameters ──────────────────────────────────────────────────────────
const LEARNING_RATE    = 0.1;
const EPOCHS           = 500;
const TEST_FRAC        = 0.20;   // newest 20% → test
const TARGET_THRESHOLD = 0.005;  // ret_1w > 0.5% → label 1

const FEATURE_NAMES = [
  'rsi_norm', 'macd_sign', 'ema_above', 'bb_pos',
  'vol_ratio', 'score_norm', 'vix_norm', 'dow',
];

// ── Feature engineering ───────────────────────────────────────────────────────

function toFeatures(row) {
  const date = new Date(row.score_date);
  return [
    ((row.rsi         ?? 50)  - 50) / 50,               // rsi_norm
    Math.sign(row.macd_hist   ?? 0),                     // macd_sign  −1|0|+1
    row.ema_trend === 'above'  ? 1 : 0,                  // ema_above
    row.bb_position            ?? 0.5,                   // bb_pos      0..1
    Math.min((row.volume_ratio ?? 1) / 3, 2) - 1,       // vol_ratio  normalized
    ((row.score       ?? 50)  - 50) / 50,               // score_norm
    row.vix != null ? (row.vix - 20) / 15 : 0,          // vix_norm
    date.getDay() / 4,                                   // dow  Mon=0.25 … Fri=1.25
  ];
}

function buildRow(row) {
  const feats = toFeatures(row);
  // Coerce any NaN to 0 (handles NULL columns returned as null by pg)
  return [1, ...feats.map(v => (Number.isFinite(v) ? v : 0))]; // bias prepended
}

function toLabel(row) {
  return row.ret_1w > TARGET_THRESHOLD ? 1 : 0;
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadData() {
  // Probe whether backtest_scores has a vix column
  let hasVix = false;
  try {
    await pool.query('SELECT vix FROM backtest_scores LIMIT 1');
    hasVix = true;
  } catch { /* column absent — use 0 */ }

  const vixExpr = hasVix ? 's.vix' : 'NULL::float AS vix';

  const { rows } = await pool.query(`
    SELECT
      s.symbol, s.score_date, s.score, s.grade,
      s.rsi, s.macd_hist, s.ema_trend, s.bb_position,
      s.volume_ratio, s.regime,
      ${vixExpr},
      r.ret_1w, r.ret_1m
    FROM backtest_scores s
    JOIN backtest_returns r
      ON  r.symbol     = s.symbol
      AND r.score_date = s.score_date
    WHERE r.ret_1w IS NOT NULL
      AND r.ret_1m IS NOT NULL
    ORDER BY s.score_date ASC
  `);

  return rows;
}

// ── Math primitives ───────────────────────────────────────────────────────────

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ── Logistic regression (gradient descent) ────────────────────────────────────

function trainLR(X, y) {
  const N = X.length;
  const D = X[0].length; // 9: bias + 8 features
  const W = new Float64Array(D); // initialise to 0

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    let loss = 0;
    const grad = new Float64Array(D);
    const EPS  = 1e-15;

    for (let i = 0; i < N; i++) {
      const p   = sigmoid(dot(X[i], W));
      const err = p - y[i];
      loss += -(y[i] * Math.log(p + EPS) + (1 - y[i]) * Math.log(1 - p + EPS));
      for (let j = 0; j < D; j++) grad[j] += err * X[i][j];
    }

    loss /= N;
    for (let j = 0; j < D; j++) W[j] -= LEARNING_RATE * (grad[j] / N);

    if ((epoch + 1) % 100 === 0) {
      process.stdout.write(`  epoch ${String(epoch + 1).padStart(3)}/${EPOCHS}  loss=${loss.toFixed(5)}\n`);
    }
  }

  return W;
}

// ── Evaluation ────────────────────────────────────────────────────────────────

function evaluateMetrics(probs, labels) {
  const N  = probs.length;
  let tp = 0, fp = 0, tn = 0, fn = 0;

  for (let i = 0; i < N; i++) {
    const pred = probs[i] >= 0.5 ? 1 : 0;
    if      (pred && labels[i])  tp++;
    else if (pred && !labels[i]) fp++;
    else if (!pred && !labels[i])tn++;
    else                         fn++;
  }

  const accuracy  = (tp + tn) / N;
  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
  const recall    = (tp + fn) > 0 ? tp / (tp + fn) : 0;
  const f1        = (precision + recall) > 0
    ? 2 * precision * recall / (precision + recall) : 0;

  // AUC-ROC via trapezoidal rule
  const totalPos = labels.reduce((s, v) => s + v, 0);
  const totalNeg = N - totalPos;
  const order    = Array.from({ length: N }, (_, i) => i)
    .sort((a, b) => probs[b] - probs[a]);

  let auc = 0, cumTP = 0, cumFP = 0, prevTPR = 0, prevFPR = 0;
  for (const i of order) {
    if (labels[i] === 1) cumTP++;
    else                 cumFP++;
    const tpr = totalPos > 0 ? cumTP / totalPos : 0;
    const fpr = totalNeg > 0 ? cumFP / totalNeg : 0;
    auc    += (fpr - prevFPR) * (tpr + prevTPR) / 2; // trapezoid
    prevTPR = tpr;
    prevFPR = fpr;
  }

  return { accuracy, precision, recall, f1, auc, tp, fp, tn, fn };
}

// ── Grade bonus adjustments ───────────────────────────────────────────────────
// For each grade, compute mean predicted probability on train set.
// Convert to an integer score bonus: (meanProb − 0.5) × 20, clamped ±10.

function computeGradeAdjustments(rows, W, trainCount) {
  const sums   = {};
  const counts = {};

  for (let i = 0; i < trainCount; i++) {
    const grade = rows[i].grade;
    if (!grade) continue;
    const p = sigmoid(dot(buildRow(rows[i]), W));
    sums[grade]   = (sums[grade]   ?? 0) + p;
    counts[grade] = (counts[grade] ?? 0) + 1;
  }

  const adj = {};
  for (const grade of Object.keys(sums)) {
    const mean = sums[grade] / counts[grade];
    adj[grade]  = Math.round(Math.max(-10, Math.min(10, (mean - 0.5) * 20)));
  }
  return adj;
}

// ── Persist results ───────────────────────────────────────────────────────────

async function saveResults({ trainRows, testRows, metrics, W, gradeAdj }) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_results (
      id                  SERIAL PRIMARY KEY,
      trained_at          TIMESTAMPTZ DEFAULT NOW(),
      train_rows          INT,
      test_rows           INT,
      accuracy            FLOAT,
      precision_1         FLOAT,
      recall_1            FLOAT,
      f1_1                FLOAT,
      auc_roc             FLOAT,
      feature_weights     JSONB,
      scoring_adjustments JSONB
    )
  `);

  const featureWeights = { bias: +W[0].toFixed(6) };
  for (let i = 0; i < FEATURE_NAMES.length; i++) {
    featureWeights[FEATURE_NAMES[i]] = +W[i + 1].toFixed(6);
  }

  const { rows } = await pool.query(`
    INSERT INTO model_results
      (train_rows, test_rows, accuracy, precision_1, recall_1, f1_1, auc_roc,
       feature_weights, scoring_adjustments)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING id, trained_at
  `, [
    trainRows,
    testRows,
    metrics.accuracy,
    metrics.precision,
    metrics.recall,
    metrics.f1,
    metrics.auc,
    JSON.stringify(featureWeights),
    JSON.stringify(gradeAdj),
  ]);

  return rows[0];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('══════════════════════════════════════════');
  console.log('  Logistic Regression Trainer');
  console.log('══════════════════════════════════════════\n');

  const rows = await loadData();
  console.log(`Loaded ${rows.length} labelled rows\n`);

  if (rows.length < 50) {
    console.error('Not enough rows (need ≥50 with non-null ret_1w and ret_1m).');
    process.exit(1);
  }

  // Build matrices
  const X = rows.map(buildRow);
  const y = rows.map(toLabel);

  // Chronological split: oldest 80% train, newest 20% test
  const splitIdx = Math.floor(rows.length * (1 - TEST_FRAC));
  const Xtrain   = X.slice(0, splitIdx);
  const ytrain   = y.slice(0, splitIdx);
  const Xtest    = X.slice(splitIdx);
  const ytest    = y.slice(splitIdx);

  const posRate = (ytrain.reduce((s, v) => s + v, 0) / ytrain.length * 100).toFixed(1);
  console.log(`Train: ${Xtrain.length} rows | Test: ${Xtest.length} rows`);
  console.log(`Train positive rate (ret_1w > 0.5%): ${posRate}%\n`);
  console.log('Training…');

  const W = trainLR(Xtrain, ytrain);

  // Evaluate
  const testProbs = Xtest.map(x => sigmoid(dot(x, W)));
  const metrics   = evaluateMetrics(testProbs, ytest);
  const gradeAdj  = computeGradeAdjustments(rows, W, splitIdx);

  // ── Print report ──
  console.log('\n── Test Set Results ───────────────────────────');
  console.log(`  Accuracy : ${(metrics.accuracy  * 100).toFixed(2)}%`);
  console.log(`  Precision: ${(metrics.precision * 100).toFixed(2)}%  (class=1)`);
  console.log(`  Recall   : ${(metrics.recall    * 100).toFixed(2)}%  (class=1)`);
  console.log(`  F1       : ${(metrics.f1        * 100).toFixed(2)}%`);
  console.log(`  AUC-ROC  : ${metrics.auc.toFixed(4)}`);
  console.log(`  Confusion : TP=${metrics.tp} FP=${metrics.fp} TN=${metrics.tn} FN=${metrics.fn}`);

  console.log('\n── Feature Weights ─────────────────────────────');
  console.log(`  ${'bias'.padEnd(14)}: ${W[0] >= 0 ? '+' : ''}${W[0].toFixed(4)}`);
  for (let i = 0; i < FEATURE_NAMES.length; i++) {
    const w = W[i + 1];
    console.log(`  ${FEATURE_NAMES[i].padEnd(14)}: ${w >= 0 ? '+' : ''}${w.toFixed(4)}`);
  }

  console.log('\n── Grade Score Adjustments (bonus points) ──────');
  const gradeOrder = ['A', 'B', 'C', 'D', 'F'];
  for (const g of gradeOrder) {
    if (gradeAdj[g] === undefined) continue;
    const v = gradeAdj[g];
    console.log(`  ${g}: ${v >= 0 ? '+' : ''}${v}`);
  }

  // Save to DB
  const saved = await saveResults({
    trainRows: Xtrain.length,
    testRows:  Xtest.length,
    metrics,
    W,
    gradeAdj,
  });

  console.log(`\n✓ Saved → model_results id=${saved.id}  trained_at=${saved.trained_at}`);
  await pool.end();
}

main().catch(err => {
  console.error(err);
  pool.end().catch(() => {});
  process.exit(1);
});
