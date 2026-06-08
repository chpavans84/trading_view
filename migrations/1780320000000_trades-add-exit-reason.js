/**
 * Migration: add `exit_reason` to legacy `trades` table.
 *
 * Background: `_closeTrade()` in `src/core/bot-executor.js` computes a reason
 * ('stop_loss', 'trailing_stop', 'time_stop', 'pre_earnings', 'uw_flipped_bearish',
 * 'news_negative_spike', 'ma50_cross') and passes it to `closeTrade()` in db.js,
 * but the column doesn't exist in `trades` so it was being silently dropped.
 *
 * Result: every `thesis->>'exit_reason'` in `trades` was null, making it impossible
 * to know what fired the exit. `bot_advance_trades` already has this column.
 *
 * VARCHAR(40) matches bot_advance_trades.exit_reason (VARCHAR(30) + small headroom
 * for future legacy-only reasons like 'alpaca_reconcile_phantom').
 */
// ESM exports — package.json declares "type": "module", so this file must use
// `export const`, not CommonJS `exports.` (the latter throws at load time and
// crashes `npm run migrate:up` for ALL migrations). Bodies use idempotent raw
// SQL because on prod the column was applied via a manual ALTER TABLE before
// this migration was tracked; idempotency makes any re-run a safe no-op.
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_reason varchar(40)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS trades_exit_reason_index ON trades (exit_reason)`);
};

export const down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS trades_exit_reason_index`);
  pgm.sql(`ALTER TABLE trades DROP COLUMN IF EXISTS exit_reason`);
};
