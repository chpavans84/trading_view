/**
 * src/repositories/bot-decisions-repo.js
 *
 * Repository for the `bot_decisions` table — the audit log of every
 * scanner-tick outcome (one row per bot per tick: buy/hold/skip/etc).
 *
 * Schema is read by bot-engine (writes) and bot-executor (reads to find
 * fresh 'buy' decisions to execute).
 */

import { query } from '../core/db.js';

/**
 * Insert one decision row. Called by bot-engine after each scan.
 *
 * @param {object} d
 * @param {number} d.botId
 * @param {string} d.action            'buy' | 'hold' | 'skip_no_candidate' | 'skip_filtered' | ...
 * @param {string} [d.symbol]
 * @param {number} [d.composite]
 * @param {object} [d.factorBreakdown] JSONB: signals, weights, indicators, setup classification
 * @param {string} [d.notes]
 * @param {string} [d.setupType]
 * @param {string} [d.thesis]
 */
export async function recordDecision({ botId, action, symbol, composite, factorBreakdown, notes, setupType, thesis }) {
  // thesis is JSONB in the schema — accept either an object (typical, from
  // classifySetup) or a pre-serialized string. Null passes through.
  const thesisJson = thesis == null
    ? null
    : (typeof thesis === 'string' ? thesis : JSON.stringify(thesis));

  await query(
    `INSERT INTO bot_decisions
       (bot_id, action, symbol, composite_score, factor_breakdown, notes, setup_type, thesis)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb)`,
    [
      botId,
      action,
      symbol ?? null,
      composite ?? null,
      factorBreakdown ? JSON.stringify(factorBreakdown) : null,
      notes ?? null,
      setupType ?? null,
      thesisJson,
    ]
  );
}

/**
 * Fetch the freshest 'buy' decision for a bot, if any, within the
 * configured staleness window. Used by bot-executor every minute to
 * decide whether to place an order.
 *
 * Returns the decision row or null.
 *
 * @param {number} botId
 * @param {number} freshnessMin   max age in minutes
 */
export async function getFreshestBuyDecision(botId, freshnessMin) {
  const { rows } = await query(
    `SELECT * FROM bot_decisions
     WHERE bot_id = $1
       AND action = 'buy'
       AND symbol IS NOT NULL
       AND scanned_at > NOW() - ($2::int * INTERVAL '1 minute')
     ORDER BY composite_score DESC
     LIMIT 1`,
    [botId, freshnessMin]
  );
  return rows[0] ?? null;
}
