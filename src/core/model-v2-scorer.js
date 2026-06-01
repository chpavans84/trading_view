/**
 * src/core/model-v2-scorer.js
 *
 * Live scorer for the Phase B5 v2 prediction model.
 *
 * Loads logistic-regression weights from `model_results` (latest v2-phaseB5 row),
 * caches them in-process (24h), and applies them to v_ml_training_set rows to
 * produce per-(symbol, date) "BUY probability" scores.
 *
 * Used by:
 *   - GET /api/predictions/top  — the "🎯 Top Picks" dashboard tab
 *   - Eventually: bot-engine scoring (replaces v1 grade adjustments)
 */

import { query } from './db.js';

// ─── Feature definitions (MUST match scripts/train-model-v2.mjs) ──────────────
export const V2_FEATURES = [
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

// ─── Weight cache (24h TTL — model retrains weekly at most) ───────────────────
let _weightCache = null;
let _weightCacheTs = 0;
const WEIGHT_TTL = 24 * 60 * 60 * 1000;

export async function getV2Weights() {
  if (_weightCache && Date.now() - _weightCacheTs < WEIGHT_TTL) return _weightCache;
  const { rows } = await query(`
    SELECT id, feature_weights, auc_roc, trained_at
      FROM model_results
     WHERE scoring_adjustments->>'version' = 'v2-phaseB5'
     ORDER BY id DESC LIMIT 1
  `);
  if (!rows.length) throw new Error('No v2-phaseB5 model found in model_results');
  const fw = rows[0].feature_weights;
  const w  = new Float64Array(V2_FEATURES.length + 1);
  w[0] = Number(fw.bias) || 0;
  V2_FEATURES.forEach((f, i) => { w[i + 1] = Number(fw[f.col]) || 0; });
  _weightCache = {
    weights: w,
    modelId: rows[0].id,
    auc:     Number(rows[0].auc_roc),
    trainedAt: rows[0].trained_at,
  };
  _weightCacheTs = Date.now();
  return _weightCache;
}

// Force a reload (call after retraining)
export function clearV2WeightCache() { _weightCache = null; _weightCacheTs = 0; }

// ─── Scoring helpers ──────────────────────────────────────────────────────────
function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z)))); }

/** Score one row (object whose keys match V2_FEATURES col names). */
export function scoreRow(weights, row) {
  let z = weights[0];   // bias
  for (let j = 0; j < V2_FEATURES.length; j++) {
    z += weights[j + 1] * V2_FEATURES[j].norm(row[V2_FEATURES[j].col]);
  }
  return sigmoid(z);
}

/**
 * Return the top-K features pushing the score up (positive contribution),
 * used for explaining picks in the UI.
 */
export function explainRow(weights, row, k = 5) {
  const contributions = V2_FEATURES.map((f, i) => ({
    feature: f.col,
    raw:     row[f.col],
    normed:  f.norm(row[f.col]),
    weight:  weights[i + 1],
    contrib: weights[i + 1] * f.norm(row[f.col]),
  }));
  contributions.sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));
  return contributions.slice(0, k);
}

// Sectors that the deep-research backtest showed model UNDERPERFORMS on
// (Healthcare 31%, Financials 21%, Comm Services 17%, Defensive 5% win rate)
export const POOR_SECTORS_DEFAULT = [
  'Healthcare', 'Financial Services', 'Communication Services', 'Consumer Defensive',
];

/**
 * Score all symbols for a given date.
 * Pulls from v_ml_training_set, applies liquidity filters, returns sorted-by-prob.
 *
 * @param {object} opts
 * @param {string} opts.date              YYYY-MM-DD; default = latest with data
 * @param {number} opts.minPrice          default 5
 * @param {number} opts.minVolume         default 500000 shares
 * @param {number} opts.limit             max rows to return (default 100)
 * @param {boolean} opts.explain          include top features per row (default false)
 * @param {number} opts.maxPerSector      cap picks per sector (default null = unlimited)
 * @param {string[]} opts.excludeSectors  filter OUT these sectors (default null = include all).
 *                                        Pass POOR_SECTORS_DEFAULT to apply backtest-derived sector filter.
 * @param {string} opts.capBand           'mid' | 'large+' | null. 'mid' = $2-10B only (76.9% win in backtest)
 * @param {boolean} opts.dowFilter        if true, only return picks on Wed/Thu (highest-win days)
 * @param {number} opts.bullishMin        filter to UW bullish % >= this (default null = no filter)
 * @param {number} opts.bullishMax        filter to UW bullish % <= this (default null). Use 20-65 for "mixed flow" sweet spot.
 */
export async function scoreUniverse(opts = {}) {
  const {
    date, minPrice = 5, minVolume = 500_000, limit = 100, explain = false,
    maxPerSector = null,
    excludeSectors = null, capBand = null, dowFilter = false,
    bullishMin = null, bullishMax = null,
  } = opts;

  // Resolve date: latest available in features table if not given
  let resolvedDate = date;
  if (!resolvedDate) {
    const { rows: latest } = await query(`SELECT MAX(price_date)::text AS d FROM daily_intraday_features`);
    resolvedDate = latest[0]?.d;
    if (!resolvedDate) return { date: null, results: [], reason: 'no_data' };
  }

  const { weights, modelId, auc, trainedAt } = await getV2Weights();

  // Pull all liquid rows for that date
  const { rows } = await query(`
    SELECT
      v.symbol, v.price_date, v.sector, v.market_cap_usd, v.reg_close,
      ${V2_FEATURES.map(f => `v.${f.col}`).join(', ')},
      dif.total_volume
      FROM v_ml_training_set v
      JOIN daily_intraday_features dif ON dif.symbol = v.symbol AND dif.price_date = v.price_date
     WHERE v.price_date = $1::date
       AND v.reg_close  >= $2
       AND dif.total_volume >= $3
  `, [resolvedDate, minPrice, minVolume]);

  const scored = rows.map(r => {
    const prob = scoreRow(weights, r);
    const out = {
      symbol:        r.symbol,
      sector:        r.sector,
      market_cap:    r.market_cap_usd ? Number(r.market_cap_usd) : null,
      reg_close:     Number(r.reg_close),
      total_volume:  Number(r.total_volume),
      prob:          +prob.toFixed(4),
      // Headline signal context
      full_day_chg_pct:    r.full_day_chg_pct,
      pre_change_pct:      r.pre_change_pct,
      intraday_chg_pct:    r.intraday_chg_pct,
      rvol_30d:            r.rvol_30d,
      sector_rank:         r.sector_rank,
      sector_chg:          r.sector_chg,
      days_to_earnings:    r.days_to_earnings,
      uw_flow_24h_premium: r.uw_flow_24h_premium ? Number(r.uw_flow_24h_premium) : 0,
      uw_flow_bullish_pct: r.uw_flow_bullish_pct ? Number(r.uw_flow_bullish_pct) : null,
      insider_cluster_30d: Number(r.insider_cluster_30d || 0),
    };
    if (explain) out.top_drivers = explainRow(weights, r, 5);
    return out;
  });

  scored.sort((a, b) => b.prob - a.prob);

  // Apply quality filters BEFORE limiting (backtest-derived edge enhancers)
  let filtered = scored;
  const filterReasons = {};

  if (excludeSectors && excludeSectors.length) {
    const before = filtered.length;
    const excSet = new Set(excludeSectors);
    filtered = filtered.filter(p => !excSet.has(p.sector));
    filterReasons.excludeSectors = before - filtered.length;
  }
  if (capBand === 'mid') {
    const before = filtered.length;
    filtered = filtered.filter(p => p.market_cap && p.market_cap >= 2e9 && p.market_cap <= 10e9);
    filterReasons.midCapOnly = before - filtered.length;
  } else if (capBand === 'large+') {
    const before = filtered.length;
    filtered = filtered.filter(p => p.market_cap && p.market_cap >= 10e9);
    filterReasons.largeCapPlus = before - filtered.length;
  }
  if (dowFilter && resolvedDate) {
    // Only return picks on Wed/Thu — for "next 5d" forecast best days
    const dow = new Date(resolvedDate + 'T12:00:00Z').getUTCDay();
    if (dow !== 3 && dow !== 4) {
      // not Wed/Thu: empty result with note
      return {
        date: resolvedDate, model_id: modelId, model_auc: auc, trained_at: trainedAt,
        candidates: rows.length, results: [],
        filters: { dowFilter: true, reason: `today is DOW=${dow}, model best on Wed(3)/Thu(4)` },
      };
    }
  }
  if (bullishMin != null) {
    const before = filtered.length;
    filtered = filtered.filter(p => p.uw_flow_bullish_pct == null || p.uw_flow_bullish_pct >= bullishMin);
    filterReasons.bullishMin = before - filtered.length;
  }
  if (bullishMax != null) {
    const before = filtered.length;
    filtered = filtered.filter(p => p.uw_flow_bullish_pct == null || p.uw_flow_bullish_pct <= bullishMax);
    filterReasons.bullishMax = before - filtered.length;
  }

  let finalResults;
  if (maxPerSector && maxPerSector > 0) {
    const sectorCounts = new Map();
    const kept = [];
    for (const p of filtered) {
      const sec = p.sector || 'Unknown';
      const n = sectorCounts.get(sec) || 0;
      if (n >= maxPerSector) continue;
      sectorCounts.set(sec, n + 1);
      kept.push(p);
      if (kept.length >= limit) break;
    }
    finalResults = kept;
  } else {
    finalResults = filtered.slice(0, limit);
  }

  return {
    date:        resolvedDate,
    model_id:    modelId,
    model_auc:   auc,
    trained_at:  trainedAt,
    candidates:  rows.length,
    diversified: maxPerSector ? { max_per_sector: maxPerSector, sectors_in_result: new Set(finalResults.map(r => r.sector || 'Unknown')).size } : null,
    filters_applied: Object.keys(filterReasons).length ? filterReasons : null,
    results:     finalResults,
  };
}
