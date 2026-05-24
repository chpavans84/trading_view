/**
 * src/repositories/bots-repo.js
 *
 * Repository layer for the `bots` table. Thin DAO functions — input args
 * → SQL → result object. No business logic, no decisions, no calls to
 * external services. Just data access.
 *
 * Why this exists:
 *   Before, bot-engine.js, bot-executor.js, and server.js all wrote inline
 *   SQL against the `bots` table — 10+ queries spread across 3 files.
 *   A schema change (rename a column, change a status enum) required
 *   grep-and-pray. This module is the single point of contact.
 *
 *   db.js still owns the lower-level `query()` and `getClient()`; this
 *   module sits on top of that.
 */

import { query } from '../core/db.js';

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * All bots in a runnable status (scanner-eligible).
 * Used by bot-engine to know which bots to scan each tick.
 */
export async function getScannableBots() {
  const { rows } = await query(
    `SELECT * FROM bots
     WHERE status IN ('active','paused_today')
       AND deleted_at IS NULL
     ORDER BY id ASC`
  );
  return rows;
}

/**
 * Active bots that are eligible for the executor to pick decisions for.
 * Excludes paused_today (those still manage their existing trades but
 * don't open new ones — the executor handles that distinction itself).
 */
export async function getActiveBots() {
  const { rows } = await query(
    `SELECT * FROM bots WHERE status = 'active' AND deleted_at IS NULL`
  );
  return rows;
}

/**
 * Symbols held in OPEN trades by OTHER bots belonging to the same user.
 * Used to deduplicate candidates across a single user's bots so two bots
 * don't both buy NVDA simultaneously.
 */
export async function getOtherBotsHeldSymbols(userId, excludeBotId) {
  const { rows } = await query(
    `SELECT t.symbol
     FROM bots b
     JOIN trades t ON t.id = b.current_trade_id
     WHERE b.user_id = $1
       AND b.id <> $2
       AND b.current_trade_id IS NOT NULL`,
    [userId, excludeBotId]
  );
  return rows.map(r => r.symbol);
}

// ─── Status transitions ─────────────────────────────────────────────────────

/**
 * Trip the circuit breaker — move bot to 'stopped' status with a message.
 * Called by both bot-engine and bot-executor when cumulative loss exceeds
 * max_loss_usd. Idempotent (already-stopped bots are unaffected).
 */
export async function tripCircuitBreaker(botId, message) {
  await query(
    `UPDATE bots
     SET status='stopped',
         status_message=$1,
         status_changed_at=NOW(),
         updated_at=NOW()
     WHERE id=$2`,
    [message, botId]
  );
}

/**
 * Link a freshly-opened trade to its bot — sets bot.current_trade_id.
 * Called by bot-executor right after _placeBuyForBot succeeds.
 */
export async function linkTrade(botId, tradeId) {
  await query(
    `UPDATE bots SET current_trade_id=$1, updated_at=NOW() WHERE id=$2`,
    [tradeId, botId]
  );
}

/**
 * Clear bot.current_trade_id (e.g. when the linked trade row no longer
 * exists — defensive cleanup against stale FK pointers).
 */
export async function unlinkTrade(botId) {
  await query(
    `UPDATE bots SET current_trade_id=NULL, updated_at=NOW() WHERE id=$1`,
    [botId]
  );
}

/**
 * Close-of-trade book-keeping: increment counters, add to lifetime P&L,
 * clear current_trade_id. `isWin` is 0/1.
 */
export async function recordTradeClose(botId, { pnlUsd, isWin }) {
  await query(
    `UPDATE bots SET
       current_trade_id    = NULL,
       total_trades        = COALESCE(total_trades, 0) + 1,
       winning_trades      = COALESCE(winning_trades, 0) + $1,
       cumulative_pnl_usd  = COALESCE(cumulative_pnl_usd, 0) + $2,
       updated_at          = NOW()
     WHERE id = $3`,
    [isWin ? 1 : 0, pnlUsd, botId]
  );
}
