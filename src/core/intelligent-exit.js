/**
 * src/core/intelligent-exit.js
 *
 * Replaces mechanical hard_sl / trail_pct / time_stop with thesis-based exits.
 *
 * Backtest (176 trades, 20 entry-days, 2026-04 → 2026-05):
 *   - Mechanical (hard_sl 6% / trail 30% / time 5d): +3.59% avg/trade, 55.1% win
 *   - Intelligent (thesis × 0.70 + catastrophic -15%): +8.77%, 58.5% win
 *   - Edge: +5.18% per trade. Backtest results table: backtest_intelligent_exit (run_id=full_v2)
 *
 * Design:
 *   - Re-score the holding using the SAME signal that bought it on every exit tick.
 *   - HOLD if thesis still intact (current_score >= entry_score × thesis_factor)
 *   - EXIT if thesis broken (current_score < entry_score × thesis_factor)
 *   - EXIT if catastrophic floor hit (currentPnl <= -dollars * catastrophic_floor_pct)
 *   - EXIT on event triggers (earnings within 1d, UW flip bearish, negative news spike)
 *
 * Two consumers:
 *   - bot-advance executor (ML v2 rule, others)
 *   - legacy bot-engine executor (composite score)
 *
 * Default parameters (backtest-validated):
 *   thesis_factor = 0.70                ← hold while score >= entry × 0.7
 *   catastrophic_floor_pct = 0.15       ← exit at -15% drawdown
 *
 * Opt-in flag per bot:
 *   bot.rules.intelligent_exit_enabled (boolean, default false for safety)
 *   bot.rules.intelligent_exit.thesis_factor (default 0.70)
 *   bot.rules.intelligent_exit.catastrophic_floor_pct (default 0.15)
 *
 * Returns { exit, reason } where:
 *   exit  = boolean
 *   reason= 'thesis_broken' | 'catastrophic_floor' | 'event_earnings' | 'event_uw_bearish' | 'event_news_negative' | null
 */

import { query } from './db.js';

const DEFAULT_THESIS_FACTOR = 0.70;
const DEFAULT_FLOOR_PCT     = 0.15;

/**
 * Decide whether to exit, given:
 *   - bot.rules.intelligent_exit_enabled (must be true)
 *   - entry_score (model probability at entry, 0..1) — stored at entry time
 *   - current_score (re-computed model probability now)
 *   - currentPnl  (current $ P&L)
 *   - dollarsInvested
 *   - eventFlags  { earnings_in_1d, uw_flip_bearish, news_negative_spike }
 *
 * Returns { exit: bool, reason: string | null }
 */
export function decideIntelligentExit({
  bot, entryScore, currentScore, currentPnl, dollarsInvested, eventFlags = {},
}) {
  const cfg     = bot?.rules?.intelligent_exit || {};
  const thesisF = Number(cfg.thesis_factor)            || DEFAULT_THESIS_FACTOR;
  const floorP  = Number(cfg.catastrophic_floor_pct)   || DEFAULT_FLOOR_PCT;

  // 1. Catastrophic floor — always wins, no exception
  if (dollarsInvested > 0 && currentPnl <= -dollarsInvested * floorP) {
    return { exit: true, reason: 'catastrophic_floor' };
  }

  // 2. Event triggers (binary)
  if (eventFlags.earnings_in_1d)     return { exit: true, reason: 'event_earnings' };
  if (eventFlags.uw_flip_bearish)    return { exit: true, reason: 'event_uw_bearish' };
  if (eventFlags.news_negative_spike) return { exit: true, reason: 'event_news_negative' };

  // 3. Thesis check — model said X% at entry, what does it say now?
  //    Skip if we lack one of the scores (defensive — fall back to caller's
  //    mechanical exit logic by returning exit:false here).
  if (entryScore != null && currentScore != null) {
    if (currentScore < entryScore * thesisF) {
      return { exit: true, reason: 'thesis_broken' };
    }
  }

  return { exit: false, reason: null };
}

/**
 * Re-score a symbol using the same engine that bought it.
 *
 * Currently supports:
 *   - entry_rule='ml_v2_intelligence' → re-score via model-v2-scorer
 *   - any other rule → use composite_score from conviction_scores (fallback)
 *
 * Returns null if we can't determine a score (caller falls back to mechanical).
 */
export async function rescoreForExit({ symbol, entryRule }) {
  try {
    if (entryRule === 'ml_v2_intelligence') {
      const { scoreUniverse } = await import('./model-v2-scorer.js');
      // Lightweight — score the full universe (cached internally), pick our symbol
      const r = await scoreUniverse({
        limit: 5000, minPrice: 1, minVolume: 1, excludeSectors: null,
      });
      const row = r.results?.find(p => p.symbol === symbol.toUpperCase());
      return row?.prob != null ? Number(row.prob) : null;
    }
    // Fallback: latest composite score from conviction_scores
    const { rows } = await query(`
      SELECT score FROM conviction_scores
       WHERE symbol = $1 AND scored_at > NOW() - INTERVAL '24 hours'
       ORDER BY scored_at DESC LIMIT 1
    `, [symbol.toUpperCase()]);
    if (rows[0]?.score != null) {
      // Normalize 0..100 composite → 0..1 prob-like scale so caller compares
      // against entry_score consistently.
      return Number(rows[0].score) / 100;
    }
  } catch (e) {
    console.warn(`[intel-exit] rescoreForExit(${symbol}, ${entryRule}):`, e.message);
  }
  return null;
}

/**
 * Lightweight event-flag fetcher.
 * Caller can pass these in directly if it already has them; this is a convenience.
 */
export async function getExitEventFlags(symbol) {
  const flags = { earnings_in_1d: false, uw_flip_bearish: false, news_negative_spike: false };
  try {
    const { getEarningsProximity } = await import('./bot-indicators.js');
    const eb = await getEarningsProximity(symbol);
    if (eb?.days_until != null && eb.days_until >= 0 && eb.days_until <= 1) {
      flags.earnings_in_1d = true;
    }
  } catch { /* graceful */ }
  // UW + news flags: rely on the existing bot-executor checks; this function
  // is the cheap convenience path. Full event detection is done in the
  // mechanical exit layer above this gate.
  return flags;
}

/**
 * Public helper: returns whether bot has intelligent_exit_enabled.
 */
export function isIntelligentExitEnabled(bot) {
  return bot?.rules?.intelligent_exit_enabled === true;
}
