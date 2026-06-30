/**
 * Migration: bot_advance_trades.slippage_cents
 * BUGFIXES_ORDER_PATH.md BUG 3 — slippage was computed in trader.js but never persisted
 * for advance-bot trades. Stored per share in cents, signed (positive = paid more than
 * the live sizing quote on buys / received less on sells).
 */
export const up = (pgm) => {
  pgm.sql(`ALTER TABLE bot_advance_trades ADD COLUMN IF NOT EXISTS slippage_cents numeric(10,2)`);
};

export const down = (pgm) => {
  pgm.sql(`ALTER TABLE bot_advance_trades DROP COLUMN IF EXISTS slippage_cents`);
};
