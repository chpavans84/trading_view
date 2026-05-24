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
 * Phase 5 (execution):
 *   if EXECUTION.live_trading_enabled (REGIME_BOT_LIVE=1 in env):
 *     - exit_long decisions → closePosition on Alpaca (fires regardless of gate — soft gate)
 *     - top-N enter_long decisions → placeOrder on Alpaca (buy $10K notional each)
 *     - all trades logged to regime_bot_trades
 *
 * Soft gate policy:
 *   exit_long always fires regardless of gate (individual SMA death cross manages exits)
 *   enter_long only fires when gate_passed=true (Markov gate blocks new entries in bear)
 *   This avoids the hard-flatten-on-regime-change that hurt the v1 backtest (-Sharpe).
 */

import { TICKER_BASKET, EXECUTION, GATE } from './config.js';
import { primarySignalForTicker } from './primary-signal.js';
import { getRegime, closePool as closeGatePool } from './markov-gate.js';
import { logDecisionsBatch, closePool as closeLogPool } from './decision-log.js';
import { placeOrder, closePosition, getPositions } from './alpaca.js';
import { openTrade, closeTrade, getOpenTrades, closePool as closeTradePool } from './trade-log.js';

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

  // Decide action — SOFT GATE policy:
  //   exit_long fires regardless of gate (individual SMA death cross manages its own exit)
  //   enter_long requires gate_passed=true (Markov gate blocks new entries only)
  //   This avoids the hard-flatten that hurt v1 backtest performance.
  let action;
  if (primary.signal === -1) {
    action = 'exit_long';      // always exit on death cross — gate does NOT block exits
  } else if (!gate.gate_passed) {
    action = 'blocked';        // gate blocks new entries only
  } else if (primary.signal === 1) {
    action = 'enter_long';     // gate passed + golden cross → enter
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

  // Propagate gate_rank back to the original `decisions` array entries
  // (candidates above are spread copies — mutating them alone won't reach the
  // objects we log). decision-log.js reads gate_rank from the originals.
  const rankByTicker = new Map(candidates.map(c => [c.ticker, c.gate_rank]));
  for (const d of decisions) {
    if (rankByTicker.has(d.ticker)) d.gate_rank = rankByTicker.get(d.ticker);
  }

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

  // Persist all decisions; capture IDs for FK link in trade records
  const decisionIds = await logDecisionsBatch(allDecisions);
  // Build ticker→decisionId map for use in trade logging
  const decisionIdMap = new Map(allDecisions.map((d, i) => [d.ticker, decisionIds[i]]));

  // Action histogram
  const histogram = {};
  for (const d of allDecisions) {
    histogram[d.action_taken] = (histogram[d.action_taken] ?? 0) + 1;
  }

  // ─── Phase 5: execute trades ──────────────────────────────────────────────
  const execSummary = { entered: 0, exited: 0, skipped: 0, errors: 0 };
  if (EXECUTION.live_trading_enabled) {
    try {
      await _executeTrades({ allDecisions, topN, decisionIdMap, execSummary });
    } catch (e) {
      console.error('[engine] execution block error:', e.message);
    }
  } else {
    console.log('[engine] live_trading_enabled=false — decisions logged only (set REGIME_BOT_LIVE=1 to enable trades)');
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
    execution:       EXECUTION.live_trading_enabled ? execSummary : null,
    duration_ms,
  };

  console.log(`[engine] done in ${(duration_ms / 1000).toFixed(1)}s — ${summary.total} decisions, ${summary.gate_passed} gate-passed, ${topN.length} top-N entries`);
  console.log(`[engine] actions:`, histogram);
  if (EXECUTION.live_trading_enabled) {
    console.log(`[engine] trades — entered:${execSummary.entered} exited:${execSummary.exited} skipped:${execSummary.skipped} errors:${execSummary.errors}`);
  }
  if (topN.length) {
    console.log(`[engine] top-${topN.length} entries today:`);
    for (const t of topN) {
      console.log(`         ${String(t.rank).padStart(2)}. ${t.ticker.padEnd(6)} regime=${t.current_regime} signal=${(t.markov_signal ?? 0).toFixed(4)} persistence=${(t.persistence_diag ?? 0).toFixed(3)}`);
    }
  }

  return summary;
}

// ─── Trade execution ─────────────────────────────────────────────────────────

/**
 * Execute entries and exits against Alpaca paper.
 * Called only when EXECUTION.live_trading_enabled = true.
 *
 * Soft gate rules:
 *   - exit_long: close Alpaca position + mark DB trade closed (fires regardless of gate)
 *   - enter_long (top-N only): open Alpaca position + insert DB trade
 */
async function _executeTrades({ allDecisions, topN, decisionIdMap, execSummary }) {
  // Build a set of tickers we currently hold in DB (open trades)
  const openTrades  = await getOpenTrades();
  const openByTicker = new Map(openTrades.map(t => [t.ticker, t]));

  // ── Exits first (soft gate: exit regardless of gate decision) ─────────────
  const exitDecisions = allDecisions.filter(d => d.action_taken === 'exit_long');
  for (const d of exitDecisions) {
    const dbTrade = openByTicker.get(d.ticker);
    if (!dbTrade) {
      execSummary.skipped++;
      continue;  // no open position in DB — nothing to close
    }
    try {
      const result = await closePosition(d.ticker);
      if (result.skipped) {
        // No Alpaca position — just close the DB record
        await closeTrade({ id: dbTrade.id, close_reason: 'primary_flip_no_alpaca_pos' });
      } else {
        await closeTrade({ id: dbTrade.id, close_reason: 'primary_flip', exit_price: null });
      }
      execSummary.exited++;
      console.log(`[engine] ✗ exit  ${d.ticker} — order_id=${result.order_id ?? 'skipped'}`);
    } catch (e) {
      execSummary.errors++;
      console.error(`[engine] exit failed for ${d.ticker}: ${e.message}`);
    }
  }

  // ── Entries (top-N gate-passing only) ────────────────────────────────────
  for (const d of topN) {
    if (openByTicker.has(d.ticker)) {
      execSummary.skipped++;
      continue;  // already holding — don't double-enter
    }
    try {
      const order = await placeOrder({
        symbol:       d.ticker,
        side:         'buy',
        notional_usd: EXECUTION.position_size_usd,
      });
      const tradeId = await openTrade({
        ticker:          d.ticker,
        side:            'buy',
        qty:             0,                         // filled in by Alpaca; unknown at order time
        alpaca_order_id: order.alpaca_order_id,
        decision_id:     decisionIdMap.get(d.ticker) ?? null,
        position_rank:   d.gate_rank,
        notes:           `rank=${d.gate_rank} regime=${d.current_regime} signal=${(d.markov_signal ?? 0).toFixed(4)}`,
      });
      execSummary.entered++;
      console.log(`[engine] ✓ enter ${d.ticker} $${EXECUTION.position_size_usd} — alpaca=${order.alpaca_order_id} trade_id=${tradeId}`);
    } catch (e) {
      execSummary.errors++;
      console.error(`[engine] entry failed for ${d.ticker}: ${e.message}`);
    }
  }
}

export async function closeAllPools() {
  await closeGatePool();
  await closeLogPool();
  await closeTradePool();
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
