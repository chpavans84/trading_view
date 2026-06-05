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
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('trades', {
    exit_reason: { type: 'varchar(40)', notNull: false },
  });
  pgm.createIndex('trades', 'exit_reason');
};

exports.down = (pgm) => {
  pgm.dropIndex('trades', 'exit_reason');
  pgm.dropColumns('trades', ['exit_reason']);
};
