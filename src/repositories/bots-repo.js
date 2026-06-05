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
 *
 * NOTE (2026-06-02): kept for backwards-compat with callers that don't
 * yet pass broker scope. New code should use `getSiblingBotsActivity()`
 * which (a) scopes by broker so a user's Alpaca and Tiger positions don't
 * cross-contaminate, (b) sees BOTH bot-engine and bot-advance trades, and
 * (c) also surfaces the recently-closed/failed cool-down list.
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

/**
 * Cross-bot situational awareness for an autonomous bot.
 *
 * Returns the union of:
 *   • `held`     — symbols currently OPEN/PENDING on any sibling bot
 *                  in the same broker account (both engines).
 *                  Blocks duplicate entries (the position already exists in
 *                  the broker so a 2nd buy would just stack risk).
 *   • `cooldown` — symbols any sibling bot CLOSED or FAILED within the
 *                  cool-down window. Blocks re-entry pingpong.
 *
 * Why both engines? `pavan_acct2` runs the legacy engine. `admin` runs both
 * legacy AND bot-advance against the same Alpaca paper account. If only one
 * table were checked, the two engines would step on each other.
 *
 * Why broker scope? A user can have alpaca + tiger accounts — those are
 * different real-world capital pools, so they shouldn't deconflict against
 * each other. (Two bots on alpaca paper SHOULD; one bot on alpaca + one
 * bot on tiger should NOT.)
 *
 * Returns:
 *   {
 *     held:     Map<SYMBOL, {bot_id, bot_name, opened_at, engine}>,
 *     cooldown: Map<SYMBOL, {bot_id, bot_name, closed_at, exit_reason, hours_left, engine}>,
 *   }
 *
 * Both keys are UPPERCASE symbols. Caller does set-style lookups.
 *
 * Cost: 4 cheap indexed queries. Cache hint: caller should fetch ONCE per
 * scan (not per candidate). The full scan loop is ~250 candidates, so even
 * cached as a closure variable this is essentially free.
 */
export async function getSiblingBotsActivity({
  userId, broker, excludeBotId, cooldownHours = 4,
}) {
  if (userId == null || !broker) {
    return { held: new Map(), cooldown: new Map() };
  }

  // 1. Legacy bot-engine OPEN trades by sibling bots (same user + same broker)
  const heldLegacyP = query(
    `SELECT t.symbol, b.id AS bot_id, b.name AS bot_name, t.opened_at
       FROM trades t
       JOIN bots b ON b.id = t.bot_id
      WHERE t.status = 'open'
        AND b.user_id = $1 AND b.broker = $2
        AND b.id <> $3
        AND t.symbol IS NOT NULL`,
    [userId, broker, excludeBotId ?? -1]
  );

  // 2. bot-advance OPEN/PENDING trades by sibling bots (same user + same broker)
  const heldAdvanceP = query(
    `SELECT bat.symbol, ba.id AS bot_id, ba.name AS bot_name, bat.opened_at
       FROM bot_advance_trades bat
       JOIN bots_advance ba ON ba.id = bat.bot_id
      WHERE bat.status IN ('open', 'pending')
        AND ba.user_id = $1 AND ba.broker = $2
        AND ba.id <> $3
        AND bat.symbol IS NOT NULL`,
    [userId, broker, excludeBotId ?? -1]
  );

  // 3. Recently-closed legacy trades (cool-down candidates).
  //    Includes own bot — a bot must respect its OWN cool-down too. The
  //    `excludeBotId` only excludes for held-set deconfliction, not cool-down.
  const cdLegacyP = query(
    `SELECT t.symbol, b.id AS bot_id, b.name AS bot_name, t.closed_at,
            t.exit_reason
       FROM trades t
       JOIN bots b ON b.id = t.bot_id
      WHERE t.status IN ('closed', 'failed')
        AND b.user_id = $1 AND b.broker = $2
        AND t.closed_at > NOW() - ($3::int * INTERVAL '1 hour')
        AND t.symbol IS NOT NULL`,
    [userId, broker, cooldownHours]
  );

  // 4. Recently-closed/failed bot-advance trades
  const cdAdvanceP = query(
    `SELECT bat.symbol, ba.id AS bot_id, ba.name AS bot_name,
            COALESCE(bat.closed_at, bat.opened_at) AS closed_at,
            bat.exit_reason
       FROM bot_advance_trades bat
       JOIN bots_advance ba ON ba.id = bat.bot_id
      WHERE bat.status IN ('closed', 'failed')
        AND ba.user_id = $1 AND ba.broker = $2
        AND COALESCE(bat.closed_at, bat.opened_at) > NOW() - ($3::int * INTERVAL '1 hour')
        AND bat.symbol IS NOT NULL`,
    [userId, broker, cooldownHours]
  );

  const [heldLegacy, heldAdvance, cdLegacy, cdAdvance] = await Promise.all([
    heldLegacyP.catch(() => ({ rows: [] })),
    heldAdvanceP.catch(() => ({ rows: [] })),
    cdLegacyP.catch(() => ({ rows: [] })),
    cdAdvanceP.catch(() => ({ rows: [] })),
  ]);

  const held = new Map();
  for (const r of heldLegacy.rows) {
    held.set(String(r.symbol).toUpperCase(),
      { bot_id: r.bot_id, bot_name: r.bot_name, opened_at: r.opened_at, engine: 'legacy' });
  }
  for (const r of heldAdvance.rows) {
    // bot-advance takes precedence if same symbol shows up twice — same broker account anyway
    held.set(String(r.symbol).toUpperCase(),
      { bot_id: r.bot_id, bot_name: r.bot_name, opened_at: r.opened_at, engine: 'advance' });
  }

  const cooldown = new Map();
  const cdMs = cooldownHours * 3_600_000;
  const now  = Date.now();
  const addCd = (rows, engine) => {
    for (const r of rows) {
      const sym = String(r.symbol).toUpperCase();
      const closedAt = r.closed_at ? new Date(r.closed_at).getTime() : now;
      const hoursLeft = Math.max(0, +(((closedAt + cdMs) - now) / 3_600_000).toFixed(1));
      // Keep the most-recent (longest remaining cool-down) on conflict
      const prev = cooldown.get(sym);
      if (prev && new Date(prev.closed_at).getTime() >= closedAt) continue;
      cooldown.set(sym, {
        bot_id:      r.bot_id,
        bot_name:    r.bot_name,
        closed_at:   r.closed_at,
        exit_reason: r.exit_reason || 'unknown',
        hours_left:  hoursLeft,
        engine,
      });
    }
  };
  addCd(cdLegacy.rows,  'legacy');
  addCd(cdAdvance.rows, 'advance');

  return { held, cooldown };
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
