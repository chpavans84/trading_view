/**
 * regime-bot/engine.js
 *
 * Orchestrator. One pass = one scan tick across the full basket:
 *   for each ticker:
 *     primary signal from price-loader  (SMA cross)
 *     regime from markov-gate           (cached or fresh)
 *     decide action  (enter / exit / hold / skip / blocked)
 *   rank gate-passing entries by markov_signal × persistence_diag
 *   tag top-N with gate_rank
 *   write all rows to regime_bot_decisions
 *
 * No trade execution here — that comes in Phase 5 (alpaca.js + trades table).
 * For Option B (current phase), the bot logs intent only.
 */

import { TICKER_BASKET, EXECUTION, GATE } from './config.js';
import { primarySignalForTicker } from './primary-signal.js';
import { getRegime, closePool as closeGatePool } from './markov-gate.js';
import { logDecisionsBatch, closePool as closeLogPool } from './decision-log.js';

// ─── Per-ticker processing ──────────────────────────────────────────────────
async function processOne(ticker) {
  let primary, gate;

  try {
    primary = await primarySignalForTicker(ticker);
  } catch (e) {
    primary = { signal: 0, fast_sma: null, slow_sma: null, price: null, ratio: null, notes: `primary_err: ${e.message}` };
  }

  try {
    gate = await getRegime(ticker);
  } catch (e) {
    // Should never throw — getRegime returns a blocked shape on internal failure.
    // Defensive fallback in case markov-gate ever does throw.
    gate = {
      current_regime: 'unknown', bull_prob: null, bear_prob: null, sideways_prob: null,
      markov_signal: null, persistence_diag: null,
      gate_passed: false, blocked_reason: `gate_threw: ${e.message}`, cached: false,
    };
  }

  // Decide action
  let action;
  if (!gate.gate_passed) {
    action = 'blocked';
  } else if (primary.signal === 1) {
    action = 'enter_long';     // gate-passing + primary says enter
  } else if (primary.signal === -1) {
    action = 'exit_long';      // primary says exit; let executor reconcile open positions
  } else {
    action = 'hold';
  }

  return {
    ticker,
    primary_signal:   primary.signal,
    primary_basis:    {
      sma_fast: primary.fast_sma,
      sma_slow: primary.slow_sma,
      price:    primary.price,
      ratio:    primary.ratio,
      notes:    primary.notes,
    },
    current_regime:   gate.current_regime,
    bull_prob:        gate.bull_prob,
    bear_prob:        gate.bear_prob,
    sideways_prob:    gate.sideways_prob,
    markov_signal:    gate.markov_signal,
    persistence_diag: gate.persistence_diag,
    gate_passed:      gate.gate_passed,
    blocked_reason:   gate.blocked_reason,
    action_taken:     action,
    cost_assumed_bps: EXECUTION.cost_per_trade_bps,
    cached:           gate.cached,
  };
}

// ─── Ranking ────────────────────────────────────────────────────────────────
function rankCandidates(decisions) {
  // Candidates = gate-passing entries (action_taken='enter_long')
  const candidates = decisions
    .filter(d => d.action_taken === 'enter_long' && d.markov_signal != null && d.persistence_diag != null)
    .map(d => ({
      ...d,
      _strength: Math.abs(d.markov_signal) * d.persistence_diag,
    }))
    .sort((a, b) => b._strength - a._strength);

  // Tag top-N with gate_rank (1-based)
  candidates.forEach((d, idx) => {
    d.gate_rank = idx + 1;
  });
  return candidates;
}

// ─── Public: full scan tick ─────────────────────────────────────────────────
/**
 * Runs one scan tick across all tickers. Logs every decision.
 * @param {object} [opts]
 * @param {number} [opts.parallelism=5]   subprocess concurrency
 * @param {Array<string>} [opts.tickers]  override basket (mainly for tests)
 * @returns {Promise<{
 *   total: number,
 *   gate_passed: number,
 *   entries_top_n: Array<object>,
 *   actions_summary: Object<string, number>,
 *   duration_ms: number
 * }>}
 */
export async function runScanTick(opts = {}) {
  const parallelism = opts.parallelism ?? 5;
  const tickers     = opts.tickers ?? TICKER_BASKET;
  const t0          = Date.now();

  console.log(`[engine] scan tick start — ${tickers.length} tickers, parallelism=${parallelism}`);

  // Process in parallel batches
  const allDecisions = [];
  for (let i = 0; i < tickers.length; i += parallelism) {
    const batch   = tickers.slice(i, i + parallelism);
    const results = await Promise.all(batch.map(processOne));
    allDecisions.push(...results);

    // Progress dots every batch
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  // Rank candidates
  const ranked = rankCandidates(allDecisions);

  // Apply max_concurrent cap — only top N retain gate_rank; others stay enter_long but unranked
  // (still logged so we measure the gate's preference ordering even for trades we wouldn't actually take)
  // For the decision log: gate_rank stays on top N, NULL on the rest.
  const topN = ranked.slice(0, EXECUTION.max_concurrent);

  // Persist all decisions
  await logDecisionsBatch(allDecisions);

  // Action histogram
  const histogram = {};
  for (const d of allDecisions) {
    histogram[d.action_taken] = (histogram[d.action_taken] ?? 0) + 1;
  }

  const duration_ms = Date.now() - t0;
  const summary = {
    total:           allDecisions.length,
    gate_passed:     allDecisions.filter(d => d.gate_passed).length,
    entries_top_n:   topN.map(d => ({
      ticker:           d.ticker,
      rank:             d.gate_rank,
      current_regime:   d.current_regime,
      markov_signal:    d.markov_signal,
      persistence_diag: d.persistence_diag,
      primary_ratio:    d.primary_basis?.ratio,
    })),
    actions_summary: histogram,
    duration_ms,
  };

  console.log(`[engine] done in ${(duration_ms / 1000).toFixed(1)}s — ${summary.total} decisions, ${summary.gate_passed} gate-passed, ${topN.length} top-N entries`);
  console.log(`[engine] actions:`, histogram);
  if (topN.length) {
    console.log(`[engine] top-${topN.length} entries today:`);
    for (const t of topN) {
      console.log(`         ${String(t.rank).padStart(2)}. ${t.ticker.padEnd(6)} regime=${t.current_regime} signal=${(t.markov_signal ?? 0).toFixed(4)} persistence=${(t.persistence_diag ?? 0).toFixed(3)}`);
    }
  }

  return summary;
}

export async function closeAllPools() {
  await closeGatePool();
  await closeLogPool();
}

// ─── Self-test (small basket subset) ────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    // CLI arg `--full` runs the full basket; otherwise just a 5-ticker probe
    const isFull = process.argv.includes('--full');
    const opts = isFull
      ? {}
      : { tickers: ['SPY', 'QQQ', 'AAPL', 'NVDA', 'XLE'], parallelism: 5 };
    try {
      const summary = await runScanTick(opts);
      console.log('\n--- summary ---');
      console.log(JSON.stringify(summary, null, 2));
    } catch (e) {
      console.error('[fatal]', e);
      process.exit(1);
    } finally {
      await closeAllPools();
    }
  })();
}
