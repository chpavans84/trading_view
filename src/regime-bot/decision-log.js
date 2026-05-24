/**
 * regime-bot/decision-log.js
 *
 * Thin wrapper around the regime_bot_decisions table. Append-only — every
 * scan tick produces one row per ticker, including blocked entries. Never
 * UPDATE or DELETE; the log is the audit trail.
 *
 * Schema reference: src/regime-bot/migrations/001_init.sql
 */

// Shared pool — one connection pool per regime-bot process.
import { getPool, closePool as _closePool } from './db-pool.js';

/**
 * Persists a single decision. All fields nullable except ticker, gate_passed,
 * and action_taken (NOT NULL in schema).
 *
 * @param {object} decision
 * @param {string} decision.ticker
 * @param {-1|0|1|null} [decision.primary_signal]
 * @param {object} [decision.primary_basis]      free-form JSONB — typically { sma50, sma200, price, ratio }
 * @param {string} [decision.current_regime]
 * @param {number} [decision.bull_prob]
 * @param {number} [decision.bear_prob]
 * @param {number} [decision.sideways_prob]
 * @param {number} [decision.markov_signal]
 * @param {number} [decision.persistence_diag]
 * @param {boolean} decision.gate_passed
 * @param {string} [decision.blocked_reason]
 * @param {string} decision.action_taken         'enter_long' / 'exit_long' / 'hold' / 'skip' / 'blocked'
 * @param {number} [decision.gate_rank]          1-based ranking among gate-passing names
 * @param {number} [decision.cost_assumed_bps]
 * @param {string} [decision.notes]
 * @returns {Promise<number>}  inserted row id
 */
export async function logDecision(decision) {
  if (!decision || typeof decision !== 'object') {
    throw new Error('logDecision: object required');
  }
  if (!decision.ticker)            throw new Error('logDecision: ticker required');
  if (typeof decision.gate_passed !== 'boolean') {
    throw new Error('logDecision: gate_passed must be boolean');
  }
  if (!decision.action_taken)      throw new Error('logDecision: action_taken required');

  const { rows } = await getPool().query(
    `INSERT INTO regime_bot_decisions (
       ticker, primary_signal, primary_basis,
       current_regime, bull_prob, bear_prob, sideways_prob,
       markov_signal, persistence_diag,
       gate_passed, blocked_reason,
       action_taken, gate_rank,
       cost_assumed_bps, notes
     ) VALUES (
       $1, $2, $3,
       $4, $5, $6, $7,
       $8, $9,
       $10, $11,
       $12, $13,
       $14, $15
     )
     RETURNING id`,
    [
      decision.ticker.toUpperCase(),
      decision.primary_signal   ?? null,
      decision.primary_basis    ? JSON.stringify(decision.primary_basis) : null,
      decision.current_regime   ?? null,
      decision.bull_prob        ?? null,
      decision.bear_prob        ?? null,
      decision.sideways_prob    ?? null,
      decision.markov_signal    ?? null,
      decision.persistence_diag ?? null,
      decision.gate_passed,
      decision.blocked_reason   ?? null,
      decision.action_taken,
      decision.gate_rank        ?? null,
      decision.cost_assumed_bps ?? null,
      decision.notes            ?? null,
    ]
  );
  return rows[0].id;
}

/**
 * Batch insert for efficiency on the daily 116-ticker scan tick.
 * Returns Map<ticker, id> — keyed by ticker so callers never rely on
 * positional index alignment.  If any single insert fails the whole
 * batch rolls back — the audit log must stay consistent.
 *
 * @param {Array<object>} decisions
 * @returns {Promise<Map<string, number>>}  ticker (upper-case) → inserted row id
 */
export async function logDecisionsBatch(decisions) {
  if (!Array.isArray(decisions) || decisions.length === 0) return new Map();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const idMap = new Map();
    for (const d of decisions) {
      const result = await client.query(
        `INSERT INTO regime_bot_decisions (
           ticker, primary_signal, primary_basis,
           current_regime, bull_prob, bear_prob, sideways_prob,
           markov_signal, persistence_diag,
           gate_passed, blocked_reason,
           action_taken, gate_rank,
           cost_assumed_bps, notes
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
         )
         RETURNING id`,
        [
          d.ticker.toUpperCase(),
          d.primary_signal   ?? null,
          d.primary_basis    ? JSON.stringify(d.primary_basis) : null,
          d.current_regime   ?? null,
          d.bull_prob        ?? null,
          d.bear_prob        ?? null,
          d.sideways_prob    ?? null,
          d.markov_signal    ?? null,
          d.persistence_diag ?? null,
          !!d.gate_passed,
          d.blocked_reason   ?? null,
          d.action_taken,
          d.gate_rank        ?? null,
          d.cost_assumed_bps ?? null,
          d.notes            ?? null,
        ]
      );
      idMap.set(d.ticker.toUpperCase(), result.rows[0].id);
    }
    await client.query('COMMIT');
    return idMap;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Read recent decisions for a ticker — useful for the engine's "previous
 * state" lookup (to detect signal flips for exit logic) and for ad-hoc
 * audit queries.
 *
 * @param {string} ticker
 * @param {number} [limit=10]
 * @returns {Promise<Array<object>>}
 */
export async function recentDecisions(ticker, limit = 10) {
  const { rows } = await getPool().query(
    `SELECT * FROM regime_bot_decisions
     WHERE ticker = $1
     ORDER BY decided_at DESC
     LIMIT $2`,
    [ticker.toUpperCase(), limit]
  );
  return rows;
}

/**
 * Aggregated counts grouped by action_taken for a date window — useful
 * for the daily "what happened today" cron log.
 *
 * @param {string} fromIso  ISO timestamp inclusive lower bound
 * @returns {Promise<Object<string, number>>}
 */
export async function decisionCountsSince(fromIso) {
  const { rows } = await getPool().query(
    `SELECT action_taken, COUNT(*)::int AS n
     FROM regime_bot_decisions
     WHERE decided_at >= $1
     GROUP BY action_taken
     ORDER BY n DESC`,
    [fromIso]
  );
  return Object.fromEntries(rows.map(r => [r.action_taken, r.n]));
}

export async function closePool() {
  await _closePool();
}
