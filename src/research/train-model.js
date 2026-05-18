/**
 * Logistic regression classifier trained from backtest data.
 * Predicts: will ret_1w > 1.5%? (label=1 vs label=0)
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
const TARGET_THRESHOLD = 0.015;  // ret_1w > 1.5% → label 1 (cleaner signal)

const FEATURE_NAMES = [
  'rsi_norm',      // (RSI − 50) / 50
  'macd_sign',     // sign of MACD histogram: −1 | 0 | +1
  'ema_above',     // price above both EMA20 + EMA50
  'bb_pos',        // (close − bb_mid) / (bb_upper − bb_mid), clamped ±1.5
  'vol_ratio',     // (day_volume / avg_vol_20d) − 1, clamped [−1, 4]
  'score_norm',    // (conviction score − 50) / 50
  'vix_norm',      // (VIX − 20) / 15
  'vix_above_20',  // regime binary: 1 if VIX > 20
  'rs_vs_spy',     // 20-day return vs SPY (relative strength)
  'pct_from_52wh', // (close − 52w_high) / 52w_high ≤ 0
  'is_monday',     // Monday gap-down risk flag
];

// ── Feature engineering ───────────────────────────────────────────────────────

function toFeatures(row) {
  const date   = new Date(row.score_date);
  const vix    = parseFloat(row.vix_close) || 20;
  const close  = parseFloat(row.close)     || null;
  const bbU    = parseFloat(row.bb_upper)  || null;
  const bbM    = parseFloat(row.bb_mid)    || null;
  const h52    = parseFloat(row.high_52w)  || null;
  const dayVol = parseFloat(row.day_volume)  || null;
  const avgVol = parseFloat(row.avg_vol_20d) || null;

  // Bollinger position: where in the band is price?
  let bb_pos = 0;
  if (close && bbU && bbM && (bbU - bbM) > 0) {
    bb_pos = Math.max(-1.5, Math.min(1.5, (close - bbM) / (bbU - bbM)));
  }

  // Volume surge: today vs 20-day average, centred at 0
  const vol_ratio = (dayVol && avgVol && avgVol > 0)
    ? Math.max(-1, Math.min(4, dayVol / avgVol - 1))
    : 0;

  // Distance from 52-week high: always ≤ 0
  const pct_from_52wh = (close && h52 && h52 > 0)
    ? Math.max(-1, (close - h52) / h52)
    : 0;

  return [
    ((parseFloat(row.rsi)   ?? 50) - 50) / 50,                        // rsi_norm
    Math.sign(parseFloat(row.macd_hist) ?? 0),                         // macd_sign
    row.above_emas ? 1 : 0,                                            // ema_above
    bb_pos,                                                            // bb_pos
    vol_ratio,                                                         // vol_ratio
    ((parseFloat(row.score) ?? 50) - 50) / 50,                        // score_norm
    (vix - 20) / 15,                                                   // vix_norm
    vix > 20 ? 1 : 0,                                                  // vix_above_20
    Math.max(-0.5, Math.min(0.5, parseFloat(row.rs_vs_spy) ?? 0)),    // rs_vs_spy
    pct_from_52wh,                                                     // pct_from_52wh
    date.getDay() === 1 ? 1 : 0,                                       // is_monday
  ];
}

function buildRow(row) {
  const feats = toFeatures(row);
  return [1, ...feats.map(v => (Number.isFinite(v) ? v : 0))]; // bias prepended
}

function toLabel(row) {
  return row.ret_1w > TARGET_THRESHOLD ? 1 : 0;
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadData() {
  // CTE computes 52-week high and 20-day avg volume per (symbol, date) on the fly.
  // This avoids storing derived columns in backtest_prices.
  const { rows } = await pool.query(`
    WITH price_stats AS (
      SELECT
        symbol,
        price_date,
        close,
        volume,
        MAX(high)           OVER w252 AS high_52w,
        AVG(volume::float)  OVER w20  AS avg_vol_20d
      FROM backtest_prices
      WINDOW
        w252 AS (PARTITION BY symbol ORDER BY price_date ROWS BETWEEN 251 PRECEDING AND CURRENT ROW),
        w20  AS (PARTITION BY symbol ORDER BY price_date ROWS BETWEEN 19  PRECEDING AND CURRENT ROW)
    )
    SELECT
      s.symbol, s.score_date, s.score, s.grade,
      s.rsi, s.macd_hist, s.above_emas,
      s.bb_upper, s.bb_mid, s.rs_vs_spy,
      s.vix_close,
      p.close,
      p.high_52w,
      p.volume     AS day_volume,
      p.avg_vol_20d,
      r.ret_1w
    FROM backtest_scores s
    JOIN backtest_returns r
      ON  r.symbol     = s.symbol
      AND r.score_date = s.score_date
    LEFT JOIN price_stats p
      ON  p.symbol     = s.symbol
      AND p.price_date = s.score_date
    WHERE r.ret_1w IS NOT NULL
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

// ── Class weights (inverse frequency) ────────────────────────────────────────
// Prevents the model from always predicting the majority class.
// Each sample is weighted by N / (2 * class_count).

function computeClassWeights(y) {
  const N        = y.length;
  const posCount = y.reduce((s, v) => s + v, 0);
  const negCount = N - posCount;
  const wPos     = posCount > 0 ? N / (2 * posCount) : 1;
  const wNeg     = negCount > 0 ? N / (2 * negCount) : 1;
  return y.map(v => (v === 1 ? wPos : wNeg));
}

// ── Logistic regression (weighted gradient descent) ───────────────────────────

function trainLR(X, y) {
  const N       = X.length;
  const D       = X[0].length;
  const W       = new Float64Array(D);
  const weights = computeClassWeights(y);

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    let loss = 0;
    const grad = new Float64Array(D);
    const EPS  = 1e-15;

    for (let i = 0; i < N; i++) {
      const p   = sigmoid(dot(X[i], W));
      const err = p - y[i];
      const w   = weights[i];
      loss += -w * (y[i] * Math.log(p + EPS) + (1 - y[i]) * Math.log(1 - p + EPS));
      for (let j = 0; j < D; j++) grad[j] += w * err * X[i][j];
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
    auc    += (fpr - prevFPR) * (tpr + prevTPR) / 2;
    prevTPR = tpr;
    prevFPR = fpr;
  }

  return { accuracy, precision, recall, f1, auc, tp, fp, tn, fn };
}

// ── Feature importance ────────────────────────────────────────────────────────
// Ranks features by absolute weight — larger magnitude = stronger signal.

function printFeatureImportance(W) {
  const ranked = FEATURE_NAMES
    .map((name, i) => ({ name, weight: W[i + 1] }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

  const maxAbs = Math.abs(ranked[0].weight) || 1;

  console.log('\n── Feature Importance (ranked by |weight|) ─────');
  for (const { name, weight } of ranked) {
    const bar    = '█'.repeat(Math.round(Math.abs(weight) / maxAbs * 20));
    const dir    = weight >= 0 ? '+' : '−';
    const pct    = (Math.abs(weight) / maxAbs * 100).toFixed(0).padStart(3);
    console.log(`  ${name.padEnd(16)} ${dir} ${pct}%  ${bar}`);
  }
}

// ── Grade bonus adjustments ───────────────────────────────────────────────────

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
  console.log('  Logistic Regression Trainer  v2');
  console.log('══════════════════════════════════════════\n');
  console.log(`  Target  : ret_1w > ${(TARGET_THRESHOLD * 100).toFixed(1)}%`);
  console.log(`  Features: ${FEATURE_NAMES.length} (was 8)`);
  console.log(`  Balancing: class-weighted loss\n`);

  console.log('Loading data (computing 52w high + vol averages)…');
  const rows = await loadData();
  console.log(`Loaded ${rows.length} labelled rows\n`);

  if (rows.length < 50) {
    console.error('Not enough rows (need ≥50 with non-null ret_1w).');
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

  const posCount   = ytrain.reduce((s, v) => s + v, 0);
  const posRate    = (posCount / ytrain.length * 100).toFixed(1);
  const wPos       = (ytrain.length / (2 * posCount)).toFixed(3);
  const wNeg       = (ytrain.length / (2 * (ytrain.length - posCount))).toFixed(3);

  console.log(`Train: ${Xtrain.length} rows | Test: ${Xtest.length} rows`);
  console.log(`Train positive rate (ret_1w > ${(TARGET_THRESHOLD * 100).toFixed(1)}%): ${posRate}%`);
  console.log(`Class weights → positive: ×${wPos}  negative: ×${wNeg}\n`);
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

  printFeatureImportance(W);

  console.log('\n── All Feature Weights (raw) ───────────────────');
  console.log(`  ${'bias'.padEnd(16)}: ${W[0] >= 0 ? '+' : ''}${W[0].toFixed(4)}`);
  for (let i = 0; i < FEATURE_NAMES.length; i++) {
    const w = W[i + 1];
    console.log(`  ${FEATURE_NAMES[i].padEnd(16)}: ${w >= 0 ? '+' : ''}${w.toFixed(4)}`);
  }

  console.log('\n── Grade Score Adjustments (bonus points) ──────');
  for (const g of ['A', 'B', 'C', 'D', 'F']) {
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
