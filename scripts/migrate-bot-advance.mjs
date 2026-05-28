#!/usr/bin/env node
/**
 * scripts/migrate-bot-advance.mjs — create isolated tables for the bot-advance challenger.
 *
 *   npm run bot-advance:migrate
 *
 * Idempotent. Safe to re-run. Creates:
 *   - bots_advance              (one row per advance-bot config)
 *   - bot_advance_decisions     (per-scan decision log, with entry_rule tag)
 *   - bot_advance_trades        (positions held by advance bots)
 *
 * Bot-advance does NOT touch the existing bots/bot_decisions/trades tables.
 * Existing bots (19/25/27/28) are completely unaffected by this migration.
 */

import { initDb, query } from '../src/core/db.js';

await initDb();

console.log('Creating bot-advance tables (idempotent)…\n');

await query(`
  CREATE TABLE IF NOT EXISTS bots_advance (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(120) NOT NULL UNIQUE,
    user_id             INTEGER,
    broker              VARCHAR(30) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'active',  -- active|paused|stopped
    shadow_mode         BOOLEAN NOT NULL DEFAULT TRUE,           -- TRUE = log only, no orders
    capital_usd         NUMERIC(14,2) NOT NULL DEFAULT 10000,
    cumulative_pnl_usd  NUMERIC(14,2) NOT NULL DEFAULT 0,
    current_trade_id    INTEGER,
    rules               JSONB NOT NULL DEFAULT '{}',
    enabled_rules       JSONB NOT NULL DEFAULT '["insider_director_cluster","at_52w_high_with_volume","momentum_flip","congress_high_conviction","composite_70"]',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ
  );
`);
console.log('  ✓ bots_advance');

await query(`
  CREATE TABLE IF NOT EXISTS bot_advance_decisions (
    id              BIGSERIAL PRIMARY KEY,
    bot_id          INTEGER NOT NULL REFERENCES bots_advance(id),
    scanned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action          TEXT NOT NULL,           -- would_buy | skip_no_match | skip_*  | hold
    symbol          VARCHAR(20),
    entry_rule      VARCHAR(60),             -- which rule matched (if action=would_buy)
    composite_score NUMERIC(6,2),            -- if composite_70 rule fired
    rule_metadata   JSONB,                   -- { backtest_win_rate, position_size_mult, ... }
    also_matched    JSONB,                   -- array of other rules that ALSO matched (for analysis)
    signals         JSONB,                   -- snapshot of signal data at decision time
    notes           TEXT,
    shadow_mode     BOOLEAN NOT NULL DEFAULT TRUE
  );
  CREATE INDEX IF NOT EXISTS idx_bot_advance_decisions_bot_time
    ON bot_advance_decisions(bot_id, scanned_at DESC);
  CREATE INDEX IF NOT EXISTS idx_bot_advance_decisions_rule_time
    ON bot_advance_decisions(entry_rule, scanned_at DESC)
    WHERE entry_rule IS NOT NULL;
`);
console.log('  ✓ bot_advance_decisions + 2 indexes');

await query(`
  CREATE TABLE IF NOT EXISTS bot_advance_trades (
    id                 BIGSERIAL PRIMARY KEY,
    bot_id             INTEGER NOT NULL REFERENCES bots_advance(id),
    decision_id        BIGINT REFERENCES bot_advance_decisions(id),
    order_id           VARCHAR(120),          -- NULL for shadow-mode trades
    symbol             VARCHAR(20) NOT NULL,
    side               VARCHAR(10) NOT NULL,
    qty                NUMERIC(14,4) NOT NULL,
    entry_price        NUMERIC(12,4) NOT NULL,
    dollars_invested   NUMERIC(14,2) NOT NULL,
    entry_rule         VARCHAR(60),           -- which rule opened this trade
    hard_sl_pct        NUMERIC(6,4),          -- 0.06 = 6%
    trail_pct          NUMERIC(6,2),
    time_stop_days     INTEGER,
    stop_loss_price    NUMERIC(12,4),
    status             VARCHAR(12) NOT NULL DEFAULT 'open',
    exit_price         NUMERIC(12,4),
    exit_reason        VARCHAR(30),
    pnl_usd            NUMERIC(14,2),
    pnl_pct            NUMERIC(8,3),
    peak_pnl_usd       NUMERIC(14,2),
    shadow_mode        BOOLEAN NOT NULL DEFAULT TRUE,
    account_source     VARCHAR(30),           -- alpaca_paper | tiger_demo (for live mode)
    opened_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at          TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_bot_advance_trades_bot_status
    ON bot_advance_trades(bot_id, status);
  CREATE INDEX IF NOT EXISTS idx_bot_advance_trades_rule
    ON bot_advance_trades(entry_rule)
    WHERE entry_rule IS NOT NULL;
`);
console.log('  ✓ bot_advance_trades + 2 indexes');

// Seed one bot
const { rowCount } = await query(`SELECT 1 FROM bots_advance WHERE name='BOT_ADVANCE_V1'`);
if (!rowCount) {
  const userRow = await query(`SELECT id FROM users WHERE username='pavan' LIMIT 1`).catch(() => ({ rows: [] }));
  const userId  = userRow.rows[0]?.id ?? null;
  await query(`
    INSERT INTO bots_advance (name, user_id, broker, status, shadow_mode, capital_usd, rules)
    VALUES ('BOT_ADVANCE_V1', $1, 'alpaca', 'active', TRUE, 10000, $2::jsonb)
  `, [userId, JSON.stringify({
    sizing: { position_size_pct: 95, max_position_usd: 1000 },
    execution: { order_type: 'auto', allow_outside_rth: false },
    entry_filters: {
      price_min: 5,
      price_max: 2500,
      avoid_earnings_within_days: 3,
      block_late_session: true,
    },
  })]);
  console.log('  ✓ Seeded BOT_ADVANCE_V1 (shadow_mode=TRUE, alpaca, $10K capital)');
} else {
  console.log('  ○ BOT_ADVANCE_V1 already exists, leaving alone');
}

const { rows: bots } = await query(`SELECT id, name, status, shadow_mode, capital_usd FROM bots_advance ORDER BY id`);
console.log('\nCurrent bots_advance:');
bots.forEach(b => console.log(`  bot ${b.id} ${b.name} status=${b.status} shadow=${b.shadow_mode} capital=$${b.capital_usd}`));

console.log('\nMigration complete.\n');
process.exit(0);
