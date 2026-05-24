/**
 * regime-bot/trade-log.js
 *
 * Writes to regime_bot_trades — the live order record for the regime-bot.
 * Completely isolated from B-3.7's `trades` table. Never read from or write
 * to `trades`. Uses its own pg.Pool (same pattern as decision-log.js).
 *
 * Schema: src/regime-bot/migrations/001_init.sql (regime_bot_trades table)
 *
 * Exports:
 *   openTrade(opts)               → id (bigint)
 *   closeTrade(opts)              → void
 *   getOpenTrades()               → Array<row>
 *   getOpenTradeForTicker(ticker) → row | null
 *   markTradeFailed(opts)         → void
 *   closePool()                   → void
 */

// Shared pool — one connection pool per regime-bot process (was 4 before consolidation).
import { getPool, closePool as _closePool } from './db-pool.js';

// ─── Writers ─────────────────────────────────────────────────────────────────

/**
 * Insert a new trade row when an order is placed.
 * status is set to 'open' immediately — we assume market fills.
 *
 * @param {object} opts
 * @param {string}  opts.ticker
 * @param {string}  opts.side              'buy' | 'sell'
 * @param {number}  [opts.qty]             shares (0 if notional-based — updated on fill)
 * @param {string}  [opts.alpaca_order_id]
 * @param {number}  [opts.entry_price]     null until filled; can be updated later
 * @param {number}  [opts.decision_id]     FK → regime_bot_decisions.id
 * @param {number}  [opts.position_rank]   gate_rank at entry
 * @param {string}  [opts.notes]
 * @returns {Promise<number>}  inserted trade id
 */
export async function openTrade({ ticker, side, qty, alpaca_order_id,
                                   entry_price, decision_id, position_rank, notes }) {
  const { rows } = await getPool().query(
    `INSERT INTO regime_bot_trades
       (ticker, side, qty, alpaca_order_id, entry_price, status,
        decision_id, position_rank_at_entry, notes)
     VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8)
     RETURNING id`,
    [
      ticker.toUpperCase(),
      side,
      qty             ?? 0,
      alpaca_order_id ?? null,
      entry_price     ?? null,
      decision_id     ?? null,
      position_rank   ?? null,
      notes           ?? null,
    ]
  );
  return Number(rows[0].id);
}

/**
 * Mark a trade as closed.
 *
 * @param {object} opts
 * @param {number}  opts.id
 * @param {number}  [opts.exit_price]
 * @param {number}  [opts.pnl_usd]
 * @param {number}  [opts.pnl_pct]        e.g. 0.05 for 5%
 * @param {string}  [opts.close_reason]   'primary_flip' | 'manual' | 'rejected'
 */
export async function closeTrade({ id, exit_price, pnl_usd, pnl_pct, close_reason }) {
  const { rowCount } = await getPool().query(
    `UPDATE regime_bot_trades
     SET status='closed', exit_price=$2, pnl_usd=$3, pnl_pct=$4,
         close_reason=$5, closed_at=NOW()
     WHERE id=$1 AND status='open'`,
    [id, exit_price ?? null, pnl_usd ?? null, pnl_pct ?? null, close_reason ?? null]
  );
  if (rowCount === 0) {
    // Trade was already closed or never existed — log a warning but don't throw
    console.warn(`[trade-log] closeTrade: no open row found for id=${id} (already closed or wrong id)`);
  }
}

/**
 * Mark a trade as failed (order rejected / API error).
 *
 * @param {object} opts
 * @param {number}  opts.id
 * @param {string}  [opts.reason]
 */
export async function markTradeFailed({ id, reason }) {
  await getPool().query(
    `UPDATE regime_bot_trades
     SET status='failed', close_reason=$2, closed_at=NOW()
     WHERE id=$1`,
    [id, reason ?? null]
  );
}

// ─── Readers ─────────────────────────────────────────────────────────────────

/**
 * Get all currently open trades.
 *
 * @returns {Promise<Array<object>>}
 */
export async function getOpenTrades() {
  const { rows } = await getPool().query(
    `SELECT * FROM regime_bot_trades
     WHERE status = 'open'
     ORDER BY opened_at DESC`
  );
  return rows;
}

/**
 * Get the most recent open trade for a ticker, or null.
 *
 * @param {string} ticker
 * @returns {Promise<object|null>}
 */
export async function getOpenTradeForTicker(ticker) {
  const { rows } = await getPool().query(
    `SELECT * FROM regime_bot_trades
     WHERE ticker = $1 AND status = 'open'
     ORDER BY opened_at DESC
     LIMIT 1`,
    [ticker.toUpperCase()]
  );
  return rows[0] ?? null;
}

/**
 * Recent closed trades — for end-of-day summary logging.
 *
 * @param {number} [limit=20]
 * @returns {Promise<Array<object>>}
 */
export async function recentTrades(limit = 20) {
  const { rows } = await getPool().query(
    `SELECT * FROM regime_bot_trades
     ORDER BY opened_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export async function closePool() {
  await _closePool();
}
