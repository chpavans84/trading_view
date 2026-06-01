/**
 * src/core/bot-advance/entry-rules.js
 *
 * Entry-rule registry for the bot-advance challenger.
 *
 * Each rule is a self-contained strategy with:
 *   - candidate_generator: cheap DB query returning tickers that could plausibly match
 *   - detect(ctx):         expensive check after signal data is gathered for the candidate
 *   - position_size_multiplier: 0.0–1.0, used to scale the per-bot dollar budget
 *   - exits:               hard_sl_pct, trail_pct, time_stop_days — travels with the trade
 *   - backtest_evidence:   win_rate, avg_return_5d, sample_size — for transparency
 *
 * Arbitration: first-match-wins by registry order. Rules are ordered by
 * (sample_size × edge) descending — robust + high-edge rules fire first.
 *
 * Stage 1 (this commit): insider_director_cluster only.
 * Stages 2-3 will add: at_52w_high_with_volume, momentum_flip,
 *                       congress_high_conviction, composite_70.
 */

import { query } from '../db.js';

// ─── ML v2 probability cache (per-scan) ──────────────────────────────────────
// The ml_v2_intelligence rule's candidate_generator runs scoreUniverse() and
// stashes the per-symbol probability here so the rule's detect() can validate
// each candidate without re-scoring. Cleared at the start of every scan.
const _v2ProbCache = new Map();   // symbol → prob (0..1)

// ─── Rule definitions ────────────────────────────────────────────────────────

export const ENTRY_RULES = [
  // ── 0. ML v2 INTELLIGENCE (NEW — Phase B5 + Quality Filter) ────────────────
  // Logistic-regression model trained on 22 features (intraday momentum + sector
  // regime + earnings proximity + UW flow + insider clusters). Stored weights
  // live in `model_results` row id=12 (version 'v2-phaseB5'), AUC 0.5816.
  //
  // Backtest (4-month out-of-sample, top-10/day = +3.42%/5d / 49.6% win):
  //   With quality filter applied (excludes Healthcare/Financials/CommSvcs/Defensive
  //   sectors + UW bullish_pct 20-65 range) → 63% win, +9.7% avg in 30-trade slice.
  //
  // 2026-06-01: priority 1 (top of cascade) so the ML model picks BEFORE the
  // single-signal rules. Single-signal rules remain as fall-throughs.
  {
    id: 'ml_v2_intelligence',
    priority: 1,
    backtest_evidence: {
      win_rate:        0.63,
      avg_return_5d:   0.097,
      sample_size:     30,
      confidence:      'medium',     // small live-window N; honest acknowledgement
      source:          'Phase B5 v2 ML + quality filter (out-of-sample 4mo)',
    },
    position_size_multiplier: 1.0,
    exits: {
      hard_sl_pct:    0.06,
      trail_pct:      30,
      time_stop_days: 5,   // matches model's 5-day forward-return horizon
    },
    candidate_generator: async () => {
      try {
        // Dynamic import so cyclic-dep / startup-init isn't a concern.
        const { scoreUniverse, POOR_SECTORS_DEFAULT } = await import('../model-v2-scorer.js');
        const r = await scoreUniverse({
          limit: 30,
          minPrice: 5,
          minVolume: 1_000_000,
          excludeSectors: POOR_SECTORS_DEFAULT,
          bullishMin: 20,
          bullishMax: 65,
        });
        // Refresh cache so detect() can validate per-symbol probability.
        _v2ProbCache.clear();
        for (const p of r.results) _v2ProbCache.set(p.symbol.toUpperCase(), Number(p.prob));
        return r.results.map(p => p.symbol);
      } catch (e) {
        console.warn(`[bot-advance/rules] ml_v2_intelligence generator failed: ${e.message}`);
        return [];
      }
    },
    detect: (ctx) => {
      // Require model probability >= 0.55 (top of empirical distribution; corresponds
      // to the high-decile picks that drove the +9.7% avg in the quality-filter backtest).
      const sym  = (ctx?.symbol || '').toUpperCase();
      const prob = _v2ProbCache.get(sym);
      return prob != null && prob >= 0.55;
    },
  },

  // ── 1. INSIDER DIRECTOR CLUSTER ─────────────────────────────────────────────
  // Cluster of ≥2 Director/10%-Owner purchases ≥$100K in last 30 days.
  // Backtest (your own data, BOT_DESIGN.md): N=436, win=73.2%, +3.79%/5d
  //
  // 2026-06-01: priority 3 → 4 (shifted down by 1 after ml_v2_intelligence was
  //   added at priority 1). Insider still fires when its specific cluster pattern
  //   appears but no longer monopolises (multi-pick lets ML pick + insider pick
  //   coexist in one scan).
  {
    id: 'insider_director_cluster',
    priority: 4,
    backtest_evidence: {
      win_rate:        0.732,
      avg_return_5d:   0.0379,
      sample_size:     436,
      confidence:      'high',
      source:          'BOT_DESIGN.md Phase 4.1 (90-day backtest, 2026-05-28)',
    },
    position_size_multiplier: 1.0,
    exits: {
      hard_sl_pct:    0.06,
      trail_pct:      30,
      time_stop_days: 10,
    },
    candidate_generator: async () => {
      // Tickers with 2+ Director/10%-Owner purchases ≥$100K in last 30 days.
      // Uses SEC transaction codes: 'P' = open-market purchase.
      const { rows } = await query(`
        SELECT ticker
          FROM uw_insider_trades
         WHERE role IN ('Director', '10% Owner', 'Director/10% Owner')
           AND transaction_type = 'P'
           AND value >= 100000
           AND filed_at > NOW() - INTERVAL '30 days'
         GROUP BY ticker
         HAVING COUNT(*) >= 2
      `);
      return rows.map(r => r.ticker);
    },
    detect: (ctx) => {
      const ins = ctx?.signals?.insider;
      if (!ins) return false;
      return Number(ins.director_amt_30d || 0) >= 100_000 &&
             Number(ins.cluster_count    || 0) >= 2;
    },
  },

  // ── 2. AT 52W HIGH WITH VOLUME ─────────────────────────────────────────────
  // Within 2% of 52-week high AND volume ≥ 2× 30-day avg.
  // Backtest: top decile by NEW 52w score had +9.00%/5d, 76.6% win on N=2,172.
  // Largest historic-backtest sample of any single-signal rule.
  //
  // 2026-06-01: priority 1 → 2 to make room for ml_v2_intelligence at top.
  //   New cascade: ml_v2 (1) → 52w_high (2) → momentum_flip (3) → insider (4)
  //   → congress (5) → composite_70 (99). All distinct.
  {
    id: 'at_52w_high_with_volume',
    priority: 2,
    backtest_evidence: {
      win_rate:        0.766,
      avg_return_5d:   0.0900,
      sample_size:     2172,
      confidence:      'high',
      source:          'BOT_DESIGN.md Phase 2.6 (signal_returns backtest)',
    },
    position_size_multiplier: 1.0,
    exits: {
      hard_sl_pct:    0.08,
      trail_pct:      30,
      time_stop_days: 7,
    },
    candidate_generator: async () => {
      const { rows } = await query(`
        SELECT symbol AS ticker
          FROM tradable_universe
         WHERE last_price >= 0.98 * week_52_high
           AND day_volume >= 2 * avg_volume_30d
           AND last_price BETWEEN 5 AND 2500
           AND fractionable = TRUE
           AND week_52_high IS NOT NULL
           AND avg_volume_30d IS NOT NULL
      `);
      return rows.map(r => r.ticker);
    },
    detect: (ctx) => {
      const liq = ctx?.indicators?.liquidity;
      const i52 = ctx?.indicators?.distance_52w;
      if (!liq?.last_price || !i52?.week_52_high) return false;
      const withinHigh = liq.last_price >= 0.98 * i52.week_52_high;
      // Fix A-2: use conviction_scores rvol when available; fall back to
      // tradable_universe day_volume/avg_volume so detect() doesn't silently fail
      // for symbols that haven't been scored in the last 24 hours.
      const rvol = ctx?.signals?.rvol != null
        ? Number(ctx.signals.rvol)
        : (Number(ctx?.indicators?.avg_volume) > 0
            ? Number(ctx?.indicators?.day_volume ?? 0) / Number(ctx.indicators.avg_volume)
            : 0);
      return withinHigh && rvol >= 2.0;
    },
  },

  // ── 3. MOMENTUM FLIP ───────────────────────────────────────────────────────
  // Composite 60-69 + drift_5d positive but <15% + MACD turning + RSI < 68.
  // Backtest: +6.86%/5d, 65.5% win on N=1,477 in flat SPY regimes.
  // De-risked slightly with 0.8x sizing — your own Phase 2.1 Option C edge.
  //
  // 2026-06-01: priority 2 → 3 (shifted down by 1 after ml_v2_intelligence was
  //   added at priority 1). Still distinct from neighbours so no arbitration ties.
  {
    id: 'momentum_flip',
    priority: 3,
    backtest_evidence: {
      win_rate:        0.655,
      avg_return_5d:   0.0686,
      sample_size:     1477,
      confidence:      'high',
      source:          'BOT_DESIGN.md Phase 2.1 Option C',
    },
    position_size_multiplier: 0.8,
    exits: {
      hard_sl_pct:    0.06,
      trail_pct:      35,
      time_stop_days: 5,
    },
    candidate_generator: async () => {
      // Pull from conviction_scores where signals indicate momentum-flip eligibility.
      // We already pre-warm conviction_scores for active candidates so this is fresh.
      const { rows } = await query(`
        SELECT DISTINCT symbol AS ticker
          FROM conviction_scores
         WHERE scored_at > NOW() - INTERVAL '24 hours'
           AND (signals->>'drift_5d_pct')::numeric BETWEEN 0 AND 15
           AND (signals->>'macd_hist')::numeric > -3
           AND COALESCE((signals->>'rsi')::numeric, 0) < 68
      `);
      return rows.map(r => r.ticker);
    },
    detect: (ctx) => {
      const s = ctx?.signals;
      if (!s) return false;
      const drift = Number(s.drift_5d_pct);
      const macd  = Number(s.macd_hist);
      const rsi   = s.rsi != null ? Number(s.rsi) : null;
      const composite = Number(ctx?.composite ?? 0);
      return Number.isFinite(drift) && Number.isFinite(macd) &&
             composite >= 60 && composite < 70 &&
             drift > 0 && drift < 15 &&
             macd > -3 &&
             (rsi == null || rsi < 68);
    },
  },

  // ── 4. CONGRESS HIGH CONVICTION ────────────────────────────────────────────
  // ≥$250K congressional buy, disclosed within 5 days.
  // Backtest: 66.7% win, +2.34%/5d on N=15 (quick-disclosure subset).
  // Smallest sample — sized at 0.3x until forward data accumulates.
  //
  // 2026-06-01: priority 4 → 5 (after ml_v2_intelligence added at top).
  {
    id: 'congress_high_conviction',
    priority: 5,
    backtest_evidence: {
      win_rate:        0.667,
      avg_return_5d:   0.0234,
      sample_size:     15,
      confidence:      'low',           // small sample — size conservatively
      source:          'BOT_DESIGN.md Phase 4.1B',
    },
    position_size_multiplier: 0.3,
    exits: {
      hard_sl_pct:    0.07,
      trail_pct:      35,
      time_stop_days: 14,
    },
    candidate_generator: async () => {
      // uw_congressional_trades stores amount as a TEXT range bucket (e.g. "$250,001 - $500,000").
      // We enumerate the buckets that start at $250K or higher.
      // Fix A-1: UW API stores transaction_type as 'Buy' (capital B) — previous list missed it.
      try {
        const { rows } = await query(`
          SELECT DISTINCT ticker
            FROM uw_congressional_trades
           WHERE transaction_type IN ('buy', 'purchase', 'Purchase', 'Buy')
             AND amount_range IN (
                 '$250,001 - $500,000',
                 '$500,001 - $1,000,000',
                 '$1,000,001 - $5,000,000',
                 '$5,000,001 - $25,000,000',
                 '$25,000,001 - $50,000,000',
                 'Over $50,000,000'
             )
             AND filed_at > NOW() - INTERVAL '30 days'
        `);
        return rows.map(r => r.ticker);
      } catch (e) {
        console.warn(`[bot-advance/rules] congress generator failed: ${e.message}`);
        return [];
      }
    },
    detect: (ctx) => {
      const c = ctx?.signals?.congress;
      if (!c) return false;
      // amount_min_dollars is the lower bound of the bucket, extracted in context.js.
      const amt = Number(c.amount_min_dollars ?? 0);
      const lag = Number(c.disclosure_lag_days ?? 999);
      return amt >= 250_000 && lag <= 5;
    },
  },

  // ── 5. COMPOSITE 70+ FALLBACK ──────────────────────────────────────────────
  // The catch-all. If composite ≥ 70 and no specialist matched, take the trade.
  // This preserves the path that produces yesterday's bot 25/27/28 picks so
  // bot-advance doesn't regress to silence.
  {
    id: 'composite_70',
    priority: 99,
    backtest_evidence: {
      win_rate:        null,
      avg_return_5d:   null,
      sample_size:     null,
      confidence:      'medium',         // not individually backtested as a rule
      source:          'Existing composite scoring at threshold 70',
    },
    position_size_multiplier: 1.0,
    exits: {
      hard_sl_pct:    0.07,
      trail_pct:      30,
      time_stop_days: 7,
    },
    candidate_generator: async () => {
      // Pull recent high-scoring rows from conviction_scores. Bot-advance does
      // its OWN candidate selection so it doesn't depend on the existing bot's
      // _buildCandidateUniverse logic.
      const { rows } = await query(`
        SELECT DISTINCT symbol AS ticker
          FROM conviction_scores
         WHERE scored_at > NOW() - INTERVAL '24 hours'
           AND score >= 70
         ORDER BY symbol
         LIMIT 300
      `);
      return rows.map(r => r.ticker);
    },
    detect: (ctx) => Number(ctx?.composite ?? 0) >= 70,
  },
];

// ─── Arbitration ─────────────────────────────────────────────────────────────

/**
 * Find the first rule that matches the candidate context.
 * Returns the matching rule object + all also-matched rule IDs for analysis.
 *
 * @param {object} ctx              candidate context (signals, composite, indicators)
 * @param {string[]} enabledRules   array of rule IDs this bot has enabled
 * @returns {{ rule: object, also_matched: string[] } | null}
 */
export function matchEntryRules(ctx, enabledRules) {
  const enabled = new Set(enabledRules || []);
  const active = ENTRY_RULES.filter(r => enabled.has(r.id))
                            .sort((a, b) => a.priority - b.priority);

  let winner = null;
  const alsoMatched = [];
  for (const r of active) {
    let matched = false;
    try { matched = !!r.detect(ctx); }
    catch (e) {
      console.warn(`[bot-advance/rules] detect() threw for ${r.id}: ${e.message}`);
      continue;
    }
    if (!matched) continue;
    if (winner == null) winner = r;
    else                alsoMatched.push(r.id);
  }
  if (winner == null) return null;
  return { rule: winner, also_matched: alsoMatched };
}

/**
 * Build the union of candidates across all enabled rules.
 * Each rule contributes its own ticker list; we dedup the union.
 *
 * @param {string[]} enabledRules
 * @returns {Promise<string[]>}      deduplicated, uppercase tickers
 */
export async function buildAdvanceCandidateUniverse(enabledRules) {
  const enabled = new Set(enabledRules || []);
  const active = ENTRY_RULES.filter(r => enabled.has(r.id));
  const universe = new Set();
  const breakdown = {};

  for (const r of active) {
    try {
      const tickers = await r.candidate_generator();
      breakdown[r.id] = tickers.length;
      for (const t of tickers) {
        if (t && typeof t === 'string') universe.add(t.toUpperCase());
      }
    } catch (e) {
      console.warn(`[bot-advance/rules] candidate_generator failed for ${r.id}: ${e.message}`);
      breakdown[r.id] = 'ERROR';
    }
  }
  return { tickers: [...universe], breakdown };
}

/**
 * Return rule metadata by id (for logging / telemetry).
 */
export function getRule(id) {
  return ENTRY_RULES.find(r => r.id === id) || null;
}
