-- src/regime-bot/migrations/001_init.sql
-- Initial schema for the regime-bot — Markov-gated SMA crossover strategy.
--
-- Fully isolated from the existing B-3.7 stock bot:
--   - regime_cache             daily Markov output per ticker (one row per ticker per day)
--   - regime_bot_decisions     every scan-tick decision (all 115 instruments, including blocked)
--   - regime_bot_trades        actual paper orders placed on Alpaca
--
-- Apply once:
--   psql "$DATABASE_URL" -f src/regime-bot/migrations/001_init.sql
--
-- Idempotent — safe to re-run. No data migration; tables are fresh.

BEGIN;

-- ─── regime_cache ────────────────────────────────────────────────────────────
-- Caches the JSON output from markov_regime.py so we make at most one
-- subprocess call per ticker per day. PK on (ticker, as_of_date) enforces this.
CREATE TABLE IF NOT EXISTS regime_cache (
  ticker             VARCHAR(20)  NOT NULL,
  as_of_date         DATE         NOT NULL,
  current_regime     VARCHAR(20),                       -- 'Bull' / 'Bear' / 'Sideways' / 'unknown'
  bull_prob          NUMERIC(5,4),                      -- next_state_probabilities.bull
  bear_prob          NUMERIC(5,4),
  sideways_prob      NUMERIC(5,4),
  signal             NUMERIC(8,5),                      -- raw signal from script
  persistence_diag   NUMERIC(8,5),                      -- avg of diagonal entries in transition matrix
  wf_sharpe          NUMERIC(8,4),                      -- walk_forward.sharpe (no costs — informational only)
  wf_max_drawdown    NUMERIC(8,4),                      -- walk_forward.max_drawdown
  raw_json           JSONB,                             -- full script output for audit / future fields
  computed_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticker, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_regime_cache_date_ticker
  ON regime_cache (as_of_date DESC, ticker);

COMMENT ON TABLE regime_cache IS
  'Daily Markov regime output per ticker, cached to limit Python subprocess calls. One row per ticker per trading day.';
COMMENT ON COLUMN regime_cache.current_regime IS
  'Latest classified regime: Bull, Bear, Sideways. Value "unknown" when subprocess failed (fail-closed → gate blocks).';

-- ─── regime_bot_decisions ────────────────────────────────────────────────────
-- One row per (ticker, scan-tick). Logged for ALL 115 instruments every day,
-- including those where the gate blocked the trade. This is how we measure
-- gate selectivity + counterfactual P&L of blocked entries later.
CREATE TABLE IF NOT EXISTS regime_bot_decisions (
  id                BIGSERIAL    PRIMARY KEY,
  ticker            VARCHAR(20)  NOT NULL,
  decided_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Primary signal inputs
  primary_signal    SMALLINT,                           -- -1 (sell/exit), 0 (hold), +1 (enter long)
  primary_basis     JSONB,                              -- { sma50, sma200, price, prev_signal }

  -- Markov gate inputs (snapshot from regime_cache at decision time)
  current_regime    VARCHAR(20),
  bull_prob         NUMERIC(5,4),
  bear_prob         NUMERIC(5,4),
  sideways_prob     NUMERIC(5,4),
  markov_signal     NUMERIC(8,5),
  persistence_diag  NUMERIC(8,5),

  -- Gate verdict
  gate_passed       BOOLEAN      NOT NULL,
  blocked_reason    TEXT,                               -- 'regime_bear', 'regime_unknown', NULL if passed

  -- Final action + ranking
  action_taken      VARCHAR(20)  NOT NULL,              -- 'enter_long' / 'exit_long' / 'hold' / 'skip' / 'blocked'
  gate_rank         SMALLINT,                           -- 1 = strongest passing signal of the day, NULL if blocked

  -- Audit
  cost_assumed_bps  NUMERIC(6,2),                       -- transaction cost factored in (for backtest reproducibility)
  notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_regime_bot_decisions_ticker_time
  ON regime_bot_decisions (ticker, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_regime_bot_decisions_gate
  ON regime_bot_decisions (gate_passed, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_regime_bot_decisions_action
  ON regime_bot_decisions (action_taken, decided_at DESC);

COMMENT ON TABLE regime_bot_decisions IS
  'Append-only decision log. Every scan-tick produces one row per ticker, including blocked entries.';
COMMENT ON COLUMN regime_bot_decisions.gate_rank IS
  'Among signals that passed the gate on this scan-tick, this is the rank by markov_signal × persistence_diag. NULL if gate blocked. Top N (default 10) get traded.';

-- ─── regime_bot_trades ───────────────────────────────────────────────────────
-- Paper orders actually placed on Alpaca. Distinct from B-3.7's `trades` table —
-- never write to or read from `trades`. FK back to the decision that triggered.
CREATE TABLE IF NOT EXISTS regime_bot_trades (
  id                  BIGSERIAL     PRIMARY KEY,
  ticker              VARCHAR(20)   NOT NULL,
  side                VARCHAR(10)   NOT NULL,             -- 'buy' / 'sell'
  qty                 NUMERIC(12,4) NOT NULL,
  alpaca_order_id     TEXT,                               -- Alpaca's UUID
  entry_price         NUMERIC(12,4),
  exit_price          NUMERIC(12,4),
  status              VARCHAR(20)   NOT NULL DEFAULT 'pending',  -- 'pending' / 'open' / 'closed' / 'rejected' / 'failed'
  decision_id         BIGINT        REFERENCES regime_bot_decisions(id) ON DELETE SET NULL,
  position_rank_at_entry SMALLINT,                        -- copy of gate_rank at entry — for top-N analysis
  opened_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  closed_at           TIMESTAMPTZ,
  close_reason        VARCHAR(40),                        -- 'primary_flip' / 'regime_bear' / 'manual' / 'rejected'
  pnl_usd             NUMERIC(12,2),
  pnl_pct             NUMERIC(8,4),
  notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_regime_bot_trades_ticker_status
  ON regime_bot_trades (ticker, status);

CREATE INDEX IF NOT EXISTS idx_regime_bot_trades_opened
  ON regime_bot_trades (opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_regime_bot_trades_alpaca_order
  ON regime_bot_trades (alpaca_order_id)
  WHERE alpaca_order_id IS NOT NULL;

COMMENT ON TABLE regime_bot_trades IS
  'Paper orders placed by the regime bot on Alpaca. Isolated from B-3.7 — never touch the trades table.';

COMMIT;

-- ─── Verify ──────────────────────────────────────────────────────────────────
-- These will print the row counts (zero on first run, real counts on re-run):
SELECT 'regime_cache'         AS table, COUNT(*) AS rows FROM regime_cache
UNION ALL
SELECT 'regime_bot_decisions' AS table, COUNT(*) AS rows FROM regime_bot_decisions
UNION ALL
SELECT 'regime_bot_trades'    AS table, COUNT(*) AS rows FROM regime_bot_trades;
