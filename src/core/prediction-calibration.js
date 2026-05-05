/**
 * Prediction Calibration — learns from historical prediction errors and adjusts future forecasts.
 *
 * How it works:
 *   After each day's actuals are filled, trainCalibration() extracts error patterns and stores:
 *     - Per-symbol bias correction (e.g. "MU consistently under-predicts by 3%")
 *     - Per-symbol volatility scale (actual moves are N× larger than predicted)
 *     - Global R²-bucket penalties (high R² stocks have worse directional accuracy)
 *     - Global direction bias correction (model predicts UP too often)
 *
 *   applyCalibration(symbol, prediction) reads these factors and adjusts the raw prediction
 *   before it is shown in the Forecast Lab or returned by get_stock_prediction.
 *
 * DB dependency: uses the shared pool from db.js — no separate connection created here.
 */

import { query, isDbAvailable } from './db.js';

// ─── Train calibration from all available actuals ────────────────────────────

export async function trainCalibration() {
  if (!isDbAvailable()) return { skipped: true, reason: 'db_unavailable', n: 0 };

  const { rows } = await query(`
    SELECT symbol, r_squared, algorithm_signal,
           predicted_change_pct, actual_change_pct, error_pct,
           target_date
    FROM stock_predictions
    WHERE actual_price IS NOT NULL
      AND predicted_change_pct IS NOT NULL
      AND actual_change_pct IS NOT NULL
  `);

  if (rows.length < 5) {
    console.log('[calibration] Not enough data to train (need ≥5 actuals)');
    return { skipped: true, reason: 'insufficient_data', n: rows.length };
  }

  // ── 1. Per-symbol bias and scale ──────────────────────────────────────────
  const bySymbol = {};
  for (const r of rows) {
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = [];
    bySymbol[r.symbol].push(r);
  }

  for (const [symbol, data] of Object.entries(bySymbol)) {
    if (data.length < 2) continue;

    // Signed bias: mean(actual_change - predicted_change). Positive = model under-predicts.
    const signedErrors = data.map(d => +d.actual_change_pct - +d.predicted_change_pct);
    const bias = signedErrors.reduce((s, e) => s + e, 0) / signedErrors.length;

    // Volatility scale: mean(|actual_change| / max(|predicted_change|, 0.1))
    const scales = data.map(d => {
      const predAbs = Math.max(Math.abs(+d.predicted_change_pct), 0.1);
      return Math.abs(+d.actual_change_pct) / predAbs;
    });
    const volScale = scales.reduce((s, v) => s + v, 0) / scales.length;

    // Direction accuracy
    const dirHits = data.filter(d =>
      ((+d.predicted_change_pct > 0 && +d.actual_change_pct > 0) ||
       (+d.predicted_change_pct < 0 && +d.actual_change_pct < 0))
    ).length;
    const dirAccuracy = dirHits / data.length;

    await Promise.all([
      query(`INSERT INTO prediction_calibration (symbol, feature, value, sample_size, last_trained)
        VALUES ($1, 'bias', $2, $3, NOW())
        ON CONFLICT (symbol, feature) DO UPDATE SET value=$2, sample_size=$3, last_trained=NOW()`,
        [symbol, bias.toFixed(4), data.length]),
      query(`INSERT INTO prediction_calibration (symbol, feature, value, sample_size, last_trained)
        VALUES ($1, 'vol_scale', $2, $3, NOW())
        ON CONFLICT (symbol, feature) DO UPDATE SET value=$2, sample_size=$3, last_trained=NOW()`,
        [symbol, volScale.toFixed(4), data.length]),
      query(`INSERT INTO prediction_calibration (symbol, feature, value, sample_size, last_trained)
        VALUES ($1, 'dir_accuracy', $2, $3, NOW())
        ON CONFLICT (symbol, feature) DO UPDATE SET value=$2, sample_size=$3, last_trained=NOW()`,
        [symbol, dirAccuracy.toFixed(4), data.length]),
    ]);
  }

  // ── 2. Global R²-bucket penalties ────────────────────────────────────────
  // Key insight from data: high R² stocks have WORSE direction accuracy.
  const r2Buckets = [
    { key: 'r2_low',  min: 0,    max: 0.1  },
    { key: 'r2_poor', min: 0.1,  max: 0.3  },
    { key: 'r2_mid',  min: 0.3,  max: 0.6  },
    { key: 'r2_high', min: 0.6,  max: 1.01 },
  ];
  for (const b of r2Buckets) {
    const bRows = rows.filter(r => +r.r_squared >= b.min && +r.r_squared < b.max);
    if (bRows.length < 3) continue;
    const avgAbsErr = bRows.reduce((s, r) => s + Math.abs(+r.error_pct), 0) / bRows.length;
    const dirAcc = bRows.filter(r =>
      ((+r.predicted_change_pct > 0 && +r.actual_change_pct > 0) ||
       (+r.predicted_change_pct < 0 && +r.actual_change_pct < 0))
    ).length / bRows.length;
    await Promise.all([
      query(`INSERT INTO prediction_calibration_global (feature, value, sample_size, last_trained)
        VALUES ($1, $2, $3, NOW()) ON CONFLICT (feature) DO UPDATE SET value=$2, sample_size=$3, last_trained=NOW()`,
        [`${b.key}_avg_abs_error`, avgAbsErr.toFixed(4), bRows.length]),
      query(`INSERT INTO prediction_calibration_global (feature, value, sample_size, last_trained)
        VALUES ($1, $2, $3, NOW()) ON CONFLICT (feature) DO UPDATE SET value=$2, sample_size=$3, last_trained=NOW()`,
        [`${b.key}_dir_accuracy`, dirAcc.toFixed(4), bRows.length]),
    ]);
  }

  // ── 3. Global direction bias ─────────────────────────────────────────────
  const upPreds = rows.filter(r => +r.predicted_change_pct > 0).length;
  const globalBullishBias = upPreds / rows.length;
  const actualUpCount = rows.filter(r => +r.actual_change_pct > 0).length;
  const actualBullishRate = actualUpCount / rows.length;

  await Promise.all([
    query(`INSERT INTO prediction_calibration_global (feature, value, sample_size, last_trained)
      VALUES ('model_bullish_bias', $1, $2, NOW()) ON CONFLICT (feature) DO UPDATE SET value=$1, sample_size=$2, last_trained=NOW()`,
      [globalBullishBias.toFixed(4), rows.length]),
    query(`INSERT INTO prediction_calibration_global (feature, value, sample_size, last_trained)
      VALUES ('actual_bullish_rate', $1, $2, NOW()) ON CONFLICT (feature) DO UPDATE SET value=$1, sample_size=$2, last_trained=NOW()`,
      [actualBullishRate.toFixed(4), rows.length]),
  ]);

  // ── 4. Store individual errors for analysis ───────────────────────────────
  for (const r of rows) {
    const dirCorrect = (
      (+r.predicted_change_pct > 0 && +r.actual_change_pct > 0) ||
      (+r.predicted_change_pct < 0 && +r.actual_change_pct < 0)
    );
    await query(`
      INSERT INTO prediction_errors
        (symbol, target_date, r_squared, algorithm_signal, predicted_change_pct, actual_change_pct, error_pct, direction_correct)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT DO NOTHING`,
      [r.symbol, r.target_date, r.r_squared, r.algorithm_signal,
       r.predicted_change_pct, r.actual_change_pct, r.error_pct, dirCorrect]
    ).catch(() => {});
  }

  console.log(`[calibration] Trained on ${rows.length} actuals across ${Object.keys(bySymbol).length} symbols`);
  return {
    ok: true,
    samples: rows.length,
    symbols: Object.keys(bySymbol).length,
    global_bullish_bias: globalBullishBias.toFixed(2),
    actual_bullish_rate: actualBullishRate.toFixed(2),
  };
}

// ─── Apply calibration to a raw prediction ───────────────────────────────────
//
// Returns the adjusted prediction plus internal factors so the caller can
// apply the same correction consistently across multiple days without additional
// DB lookups. The _factors object contains:
//   bias_correction  — additive offset (constant across all forecast days)
//   reversal_applied — whether the 50% R² reversal damper was applied
//   reversal_factor  — the scale factor used (0.5 if applied, else 1.0)
//
// This allows server.js to call applyCalibration() ONCE per symbol and then
// apply the same factors to each day's projection deterministically.

export async function applyCalibration(symbol, rawPredictedChangePct, rSquared) {
  if (!isDbAvailable()) {
    return _noCalibration(rawPredictedChangePct);
  }

  // Load per-symbol calibration
  const { rows: symRows } = await query(
    `SELECT feature, value, sample_size FROM prediction_calibration WHERE symbol=$1`,
    [symbol]
  );
  const symCal = Object.fromEntries(symRows.map(r => [r.feature, { v: +r.value, n: +r.sample_size }]));

  // Load global calibration
  const { rows: globRows } = await query(`SELECT feature, value FROM prediction_calibration_global`);
  const globCal = Object.fromEntries(globRows.map(r => [r.feature, +r.value]));

  let adjusted = rawPredictedChangePct;
  const notes = [];

  // Apply per-symbol bias (weighted by sample size — full weight at 10+ samples, partial below)
  let biasCorrection = 0;
  if (symCal.bias) {
    const weight = Math.min(1, symCal.bias.n / 10);
    biasCorrection = symCal.bias.v * weight;
    adjusted += biasCorrection;
    if (Math.abs(biasCorrection) > 0.2) notes.push(`bias ${biasCorrection > 0 ? '+' : ''}${biasCorrection.toFixed(2)}%`);
  }

  // R²-based confidence: derive expected error range for this bucket
  let r2Bucket = 'r2_low';
  if (rSquared >= 0.6) r2Bucket = 'r2_high';
  else if (rSquared >= 0.3) r2Bucket = 'r2_mid';
  else if (rSquared >= 0.1) r2Bucket = 'r2_poor';

  const expectedError = globCal[`${r2Bucket}_avg_abs_error`] ?? 2.0;
  const r2DirAccuracy = globCal[`${r2Bucket}_dir_accuracy`] ?? 0.5;

  // Dampen high-R² predictions (they reverse more than expected)
  let reversalFactor = 1.0;
  let reversalApplied = false;
  if (rSquared > 0.6 && r2DirAccuracy < 0.35) {
    reversalFactor = 0.5;
    reversalApplied = true;
    adjusted = adjusted * reversalFactor;
    notes.push('R² reversal penalty');
  }

  // Compute confidence score (0–100)
  const errorScore  = Math.max(0, 100 - expectedError * 10);
  const dirScore    = r2DirAccuracy * 100;
  const sampleBonus = symCal.bias ? Math.min(20, symCal.bias.n * 2) : 0;
  const confidence  = Math.round(errorScore * 0.5 + dirScore * 0.4 + sampleBonus * 0.1);

  return {
    adjusted_change_pct:  +adjusted.toFixed(4),
    raw_change_pct:        rawPredictedChangePct,
    confidence,            // 0–100 — how reliable this prediction is
    expected_error_pct:   +expectedError.toFixed(2),
    notes,
    // Internal factors — used by server.js to apply the same correction to all forecast days
    _bias_correction:      biasCorrection,
    _reversal_applied:     reversalApplied,
    _reversal_factor:      reversalFactor,
  };
}

// Apply the same calibration factors to a different day's projected change pct.
// Call this for days 2–5 after calling applyCalibration() for day 1.
export function applyCalibrationToDay(projectedChangePct, calFactors) {
  if (!calFactors) return null;
  let adj = projectedChangePct + calFactors._bias_correction;
  if (calFactors._reversal_applied) adj *= calFactors._reversal_factor;
  return +adj.toFixed(4);
}

function _noCalibration(raw) {
  return {
    adjusted_change_pct: raw,
    raw_change_pct:      raw,
    confidence:          null,
    expected_error_pct:  null,
    notes:               [],
    _bias_correction:    0,
    _reversal_applied:   false,
    _reversal_factor:    1.0,
  };
}

// ─── Failure analysis report ─────────────────────────────────────────────────

export async function getFailureAnalysis({ limit = 6 } = {}) {
  if (!isDbAvailable()) return { worst_symbols: [], r2_bucket_stats: [], direction_stats: [], global: {} };

  const limitN = Math.max(1, Math.min(50, parseInt(limit, 10) || 6));

  const [symErrors, r2Stats, dirStats, global, totalRow] = await Promise.all([
    // Per-symbol error ranking
    query(`
      SELECT symbol,
             COUNT(*) AS n,
             ROUND(AVG(ABS(error_pct))::numeric,2) AS avg_abs_error,
             ROUND(AVG(CASE WHEN direction_correct THEN 1.0 ELSE 0.0 END * 100)::numeric,1) AS dir_acc,
             ROUND(AVG(r_squared)::numeric,3) AS avg_r2,
             ROUND(AVG(algorithm_signal)::numeric,0) AS avg_signal
      FROM prediction_errors
      GROUP BY symbol HAVING COUNT(*) >= 2
      ORDER BY avg_abs_error DESC LIMIT $1`, [limitN * 2]),

    // R² bucket stats
    query(`
      SELECT CASE WHEN r_squared < 0.1 THEN 'weak (<0.1)'
                  WHEN r_squared < 0.3 THEN 'poor (0.1–0.3)'
                  WHEN r_squared < 0.6 THEN 'moderate (0.3–0.6)'
                  ELSE 'strong (>0.6)' END AS r2_bucket,
             COUNT(*) AS n,
             ROUND(AVG(ABS(error_pct))::numeric,2) AS avg_abs_error,
             ROUND(AVG(CASE WHEN direction_correct THEN 1.0 ELSE 0.0 END * 100)::numeric,1) AS dir_acc
      FROM prediction_errors GROUP BY 1 ORDER BY avg_abs_error DESC`),

    // Direction breakdown
    query(`
      SELECT CASE WHEN predicted_change_pct > 0 AND actual_change_pct < 0 THEN 'pred_up_actual_down'
                  WHEN predicted_change_pct < 0 AND actual_change_pct > 0 THEN 'pred_down_actual_up'
                  WHEN predicted_change_pct > 0 AND actual_change_pct > 0 THEN 'both_up'
                  ELSE 'both_down' END AS pattern,
             COUNT(*) AS n,
             ROUND(AVG(ABS(error_pct))::numeric,2) AS avg_abs_error
      FROM prediction_errors GROUP BY 1 ORDER BY n DESC`),

    // Global calibration summary
    query(`SELECT feature, value FROM prediction_calibration_global ORDER BY feature`),

    // Total sample count
    query('SELECT COUNT(*) AS n FROM prediction_errors'),
  ]);

  const globMap = Object.fromEntries(global.rows.map(r => [r.feature, +r.value]));

  return {
    worst_symbols:   symErrors.rows,
    r2_bucket_stats: r2Stats.rows,
    direction_stats: dirStats.rows,
    global: {
      model_bullish_bias:  globMap.model_bullish_bias,
      actual_bullish_rate: globMap.actual_bullish_rate,
      total_samples:       +totalRow.rows[0].n,
    },
  };
}
