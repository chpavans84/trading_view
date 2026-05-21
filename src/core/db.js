/**
 * PostgreSQL database layer.
 * Gracefully degrades — bot continues without DB if DATABASE_URL is unset.
 */

import pg from 'pg';
import { encryptCredential, decryptCredential } from './crypto.js';
const { Pool, types } = pg;
// Return DATE columns as 'YYYY-MM-DD' strings, not Date objects (avoids timezone-mangled keys)
types.setTypeParser(1082, v => v);

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_history (
  id          SERIAL PRIMARY KEY,
  chat_id     BIGINT NOT NULL,
  role        VARCHAR(20) NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conv_chat_id ON conversation_history(chat_id);

CREATE TABLE IF NOT EXISTS usage_stats (
  id                  SERIAL PRIMARY KEY,
  date                DATE NOT NULL UNIQUE,
  total_messages      INT DEFAULT 0,
  total_tool_calls    INT DEFAULT 0,
  input_tokens        BIGINT DEFAULT 0,
  output_tokens       BIGINT DEFAULT 0,
  estimated_cost_usd  NUMERIC(10,4) DEFAULT 0,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_calls (
  id                SERIAL PRIMARY KEY,
  called_at         TIMESTAMPTZ DEFAULT NOW(),
  source            VARCHAR(40) NOT NULL,
  input_tokens      INT NOT NULL DEFAULT 0,
  output_tokens     INT NOT NULL DEFAULT 0,
  tool_calls        INT NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(10,6) NOT NULL DEFAULT 0,
  duration_ms       INT,
  model             VARCHAR(60)
);
CREATE INDEX IF NOT EXISTS idx_api_calls_called_at ON api_calls(called_at);
CREATE INDEX IF NOT EXISTS idx_api_calls_source    ON api_calls(source);
-- Add new columns to existing tables created before this migration
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_calls') THEN NULL; END IF;
END $$;

CREATE TABLE IF NOT EXISTS trades (
  id                   SERIAL PRIMARY KEY,
  order_id             VARCHAR(100) UNIQUE,
  symbol               VARCHAR(20) NOT NULL,
  side                 VARCHAR(10) NOT NULL,
  qty                  NUMERIC(10,4),
  entry_price          NUMERIC(12,4),
  stop_loss            NUMERIC(12,4),
  take_profit          NUMERIC(12,4),
  dollars_invested     NUMERIC(12,2),
  stop_loss_pct        NUMERIC(6,2),
  take_profit_pct      NUMERIC(6,2),
  atr_pct              NUMERIC(6,2),
  conviction_score     NUMERIC(6,2),
  conviction_grade     VARCHAR(5),
  conviction_breakdown JSONB,
  status               VARCHAR(20) DEFAULT 'open',
  exit_price           NUMERIC(12,4),
  pnl_usd              NUMERIC(12,2),
  pnl_pct              NUMERIC(8,4),
  opened_at            TIMESTAMPTZ DEFAULT NOW(),
  closed_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trades_symbol    ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status    ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades(opened_at);

CREATE TABLE IF NOT EXISTS conviction_scores (
  id                SERIAL PRIMARY KEY,
  symbol            VARCHAR(20) NOT NULL,
  name              VARCHAR(100),
  score             INT NOT NULL,
  grade             VARCHAR(5),
  breakdown         JSONB,
  signals           JSONB,
  tv_available      BOOLEAN,
  technical_summary TEXT,
  scored_at         TIMESTAMPTZ DEFAULT NOW()
);
-- Add name column to existing tables created before this migration
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conviction_scores' AND column_name='name') THEN
    ALTER TABLE conviction_scores ADD COLUMN name VARCHAR(100);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_scores_symbol    ON conviction_scores(symbol);
CREATE INDEX IF NOT EXISTS idx_scores_scored_at ON conviction_scores(scored_at);

CREATE TABLE IF NOT EXISTS daily_pnl (
  id             SERIAL PRIMARY KEY,
  date           DATE NOT NULL UNIQUE,
  realized_pnl   NUMERIC(12,2) DEFAULT 0,
  unrealized_pnl NUMERIC(12,2) DEFAULT 0,
  total_trades   INT DEFAULT 0,
  winning_trades INT DEFAULT 0,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_daily_snapshots (
  date           DATE        NOT NULL,
  source         TEXT        NOT NULL,
  username       TEXT        NOT NULL,
  portfolio_value NUMERIC(14,2),
  realized_pl    NUMERIC(14,2),
  unrealized_pl  NUMERIC(14,2),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (date, source, username)
);

CREATE TABLE IF NOT EXISTS user_watchlist (
  username   TEXT        NOT NULL,
  symbol     TEXT        NOT NULL,
  added_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (username, symbol)
);
CREATE INDEX IF NOT EXISTS idx_user_watchlist_username ON user_watchlist(username);

CREATE TABLE IF NOT EXISTS doc_queries (
  id           SERIAL PRIMARY KEY,
  query        TEXT NOT NULL,
  found        BOOLEAN NOT NULL DEFAULT false,
  user_ip      VARCHAR(64),
  user_agent   TEXT,
  notified     BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_doc_queries_created ON doc_queries(created_at);
CREATE INDEX IF NOT EXISTS idx_doc_queries_found   ON doc_queries(found);

CREATE TABLE IF NOT EXISTS user_activity (
  id          SERIAL PRIMARY KEY,
  username    VARCHAR(64) NOT NULL,
  action      VARCHAR(80) NOT NULL,
  detail      TEXT,
  ip          VARCHAR(64),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_activity_username   ON user_activity(username);
CREATE INDEX IF NOT EXISTS idx_user_activity_created_at ON user_activity(created_at);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(64)  NOT NULL UNIQUE,
  email         VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'viewer',
  plan          VARCHAR(20)  NOT NULL DEFAULT 'free',
  credits       INT          NOT NULL DEFAULT 0,
  permissions   JSONB,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  last_login    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);

CREATE TABLE IF NOT EXISTS otp_tokens (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  code_hash  VARCHAR(64)  NOT NULL,
  expires_at TIMESTAMPTZ  NOT NULL,
  used       BOOLEAN      DEFAULT false,
  created_at TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_tokens(email);

-- Add username column to api_calls for per-user cost tracking
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_calls' AND column_name='username') THEN
    ALTER TABLE api_calls ADD COLUMN username VARCHAR(64);
  END IF;
END $$;
-- Add Alpaca credentials columns to users
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='alpaca_api_key') THEN
    ALTER TABLE users ADD COLUMN alpaca_api_key    VARCHAR(255);
    ALTER TABLE users ADD COLUMN alpaca_secret_key VARCHAR(255);
    ALTER TABLE users ADD COLUMN alpaca_base_url   VARCHAR(255);
  END IF;
END $$;
-- Add separate live Alpaca credential columns (paper and live stored independently)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='alpaca_live_api_key') THEN
    ALTER TABLE users ADD COLUMN alpaca_live_api_key    VARCHAR(255);
    ALTER TABLE users ADD COLUMN alpaca_live_secret_key VARCHAR(255);
  END IF;
END $$;
-- Add suspended flag for admin account control
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='suspended') THEN
    ALTER TABLE users ADD COLUMN suspended BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;
-- Add per-user bot configuration (JSONB — null means use system defaults)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='bot_config') THEN
    ALTER TABLE users ADD COLUMN bot_config JSONB DEFAULT NULL;
  END IF;
END $$;
-- Add per-user Moomoo account ID (acc_id from Futu OpenD)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='moomoo_acc_id') THEN
    ALTER TABLE users ADD COLUMN moomoo_acc_id VARCHAR(64);
  END IF;
END $$;
-- Add per-user Tiger Brokers credentials
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='tiger_id') THEN
    ALTER TABLE users ADD COLUMN tiger_id          VARCHAR(64);
    ALTER TABLE users ADD COLUMN tiger_account     VARCHAR(64);
    ALTER TABLE users ADD COLUMN tiger_private_key TEXT;
  END IF;
END $$;
-- Tiger ID and tiger_account were VARCHAR(64) but encrypted values exceed 64 chars — migrate to TEXT
DO $$ BEGIN
  ALTER TABLE users ALTER COLUMN tiger_id      TYPE TEXT;
  ALTER TABLE users ALTER COLUMN tiger_account TYPE TEXT;
EXCEPTION WHEN others THEN NULL; END $$;
-- Tiger multi-env: Live / Demo / Demo API (legacy columns — kept but no longer written)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='tiger_account_live') THEN
    ALTER TABLE users ADD COLUMN tiger_account_live     TEXT;
    ALTER TABLE users ADD COLUMN tiger_account_demo     TEXT;
    ALTER TABLE users ADD COLUMN tiger_account_demo_api TEXT;
    ALTER TABLE users ADD COLUMN tiger_active_env       VARCHAR(15) DEFAULT 'live';
  END IF;
END $$;
-- Tiger Demo credential set (mirrors Alpaca paper/live split)
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS tiger_demo_id          TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS tiger_demo_private_key TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS tiger_demo_account     TEXT;
EXCEPTION WHEN others THEN NULL; END $$;
-- Admin-controlled per-user broker source locks (JSONB array of disabled source strings)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='disabled_sources') THEN
    ALTER TABLE users ADD COLUMN disabled_sources JSONB DEFAULT '[]'::jsonb;
  END IF;
END $$;
-- Add username to trades for per-user trade history
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='trades' AND column_name='username') THEN
    ALTER TABLE trades ADD COLUMN username VARCHAR(64);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_trades_username ON trades(username);
-- Add username to daily_pnl for per-user P&L history
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='daily_pnl' AND column_name='username') THEN
    ALTER TABLE daily_pnl ADD COLUMN username TEXT NOT NULL DEFAULT 'admin';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_pnl_date_username_key') THEN
    BEGIN
      ALTER TABLE daily_pnl DROP CONSTRAINT IF EXISTS daily_pnl_date_key;
    EXCEPTION WHEN others THEN NULL; END;
    ALTER TABLE daily_pnl ADD CONSTRAINT daily_pnl_date_username_key UNIQUE (date, username);
  END IF;
  -- Add source column so Moomoo/Tiger P&L is stored separately from Alpaca paper
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='daily_pnl' AND column_name='source') THEN
    ALTER TABLE daily_pnl ADD COLUMN source TEXT NOT NULL DEFAULT 'alpaca';
    ALTER TABLE daily_pnl DROP CONSTRAINT IF EXISTS daily_pnl_date_username_key;
    ALTER TABLE daily_pnl ADD CONSTRAINT daily_pnl_date_username_source_key UNIQUE (date, username, source);
  END IF;
END $$;
-- Migrate conversation_history.chat_id from BIGINT to TEXT for username-keyed isolation
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name='conversation_history' AND column_name='chat_id') = 'bigint' THEN
    ALTER TABLE conversation_history ALTER COLUMN chat_id TYPE TEXT USING chat_id::TEXT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS bug_reports (
  id          SERIAL PRIMARY KEY,
  username    VARCHAR(64)  NOT NULL,
  title       VARCHAR(200) NOT NULL,
  description TEXT         NOT NULL,
  page        VARCHAR(100),
  status      VARCHAR(20)  NOT NULL DEFAULT 'open',
  admin_note  TEXT,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);
CREATE INDEX IF NOT EXISTS idx_bug_reports_user   ON bug_reports(username);

CREATE TABLE IF NOT EXISTS scanner_state (
  key        VARCHAR(50) PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_briefings (
  id         SERIAL PRIMARY KEY,
  date       DATE NOT NULL,
  type       VARCHAR(20) NOT NULL DEFAULT 'morning',
  content    TEXT NOT NULL,
  regime     VARCHAR(50),
  direction  VARCHAR(20),
  vix        NUMERIC(6,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (date, type)
);

-- Add type column + fix unique constraint for daily_briefings (supports morning + eod per day)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='daily_briefings' AND column_name='type') THEN
    ALTER TABLE daily_briefings ADD COLUMN type VARCHAR(20) DEFAULT 'morning';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='daily_briefings_date_key' AND table_name='daily_briefings') THEN
    ALTER TABLE daily_briefings DROP CONSTRAINT daily_briefings_date_key;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='daily_briefings_date_type_key' AND table_name='daily_briefings') THEN
    ALTER TABLE daily_briefings ADD CONSTRAINT daily_briefings_date_type_key UNIQUE (date, type);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS position_monitoring (
  symbol           VARCHAR(20) PRIMARY KEY,
  entry_price      NUMERIC(12,4),
  stop_price       NUMERIC(12,4),
  target_price     NUMERIC(12,4),
  stop_moved_to_be BOOLEAN DEFAULT FALSE,
  stop_trailed     BOOLEAN DEFAULT FALSE,
  last_checked_at  TIMESTAMPTZ,
  last_price       NUMERIC(12,4)
);

CREATE TABLE IF NOT EXISTS trade_rejections (
  id               SERIAL PRIMARY KEY,
  symbol           VARCHAR(20),
  reason           TEXT,
  conviction_score INT,
  rejected_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rejections_symbol      ON trade_rejections(symbol);
CREATE INDEX IF NOT EXISTS idx_rejections_rejected_at ON trade_rejections(rejected_at);

CREATE TABLE IF NOT EXISTS trade_lessons (
  id           SERIAL PRIMARY KEY,
  date         DATE NOT NULL,
  symbol       VARCHAR(20),
  outcome      VARCHAR(10),
  pnl_usd      NUMERIC(12,2),
  regime       VARCHAR(30),
  vix          NUMERIC(6,2),
  lesson_type  VARCHAR(30),
  lesson       TEXT NOT NULL,
  ai_source    VARCHAR(20),
  username     VARCHAR(64),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lessons_date ON trade_lessons(date);
-- Backfill columns added after initial release
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trade_lessons' AND column_name='ai_source') THEN
    ALTER TABLE trade_lessons ADD COLUMN ai_source VARCHAR(20);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trade_lessons' AND column_name='username') THEN
    ALTER TABLE trade_lessons ADD COLUMN username VARCHAR(64);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS performance_patterns (
  id           SERIAL PRIMARY KEY,
  regime       VARCHAR(30) NOT NULL,
  vix_bucket   VARCHAR(20) NOT NULL,
  username     VARCHAR(64) NOT NULL DEFAULT 'system',
  trades       INT DEFAULT 0,
  wins         INT DEFAULT 0,
  total_pnl    NUMERIC(12,2) DEFAULT 0,
  win_rate     NUMERIC(5,2) DEFAULT 0,
  avg_pnl      NUMERIC(10,2) DEFAULT 0,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='performance_patterns' AND column_name='username') THEN
    ALTER TABLE performance_patterns ADD COLUMN username VARCHAR(64) DEFAULT 'system';
    ALTER TABLE performance_patterns DROP CONSTRAINT IF EXISTS performance_patterns_regime_vix_bucket_key;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_perf_patterns_user
  ON performance_patterns(username, regime, vix_bucket);

-- Daily picks log: every strong-buy and intraday pick saved for future simulation
CREATE TABLE IF NOT EXISTS daily_picks (
  id            SERIAL PRIMARY KEY,
  date          DATE         NOT NULL,
  type          VARCHAR(20)  NOT NULL,  -- 'strong_buy' | 'intraday'
  symbol        VARCHAR(20)  NOT NULL,
  name          VARCHAR(100),
  score         NUMERIC(5,1),           -- conviction score (strong_buy)
  grade         VARCHAR(5),             -- A/B (strong_buy)
  horizon       VARCHAR(50),
  price         NUMERIC(12,4),          -- entry price at pick time
  rvol          NUMERIC(6,2),
  atr_pct       NUMERIC(6,2),
  stop_price    NUMERIC(12,4),
  target_price  NUMERIC(12,4),
  signals       JSONB,                  -- full signals for replay
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(date, type, symbol)
);
CREATE INDEX IF NOT EXISTS idx_daily_picks_date ON daily_picks(date);
CREATE INDEX IF NOT EXISTS idx_daily_picks_type ON daily_picks(type);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id           SERIAL PRIMARY KEY,
  topic        TEXT NOT NULL,
  category     TEXT NOT NULL,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  embedding    TEXT,
  source       TEXT DEFAULT 'built-in',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_category_idx ON knowledge_chunks(category);

CREATE TABLE IF NOT EXISTS fundamentals (
  id               SERIAL PRIMARY KEY,
  symbol           TEXT NOT NULL,
  period_end       DATE NOT NULL,
  period_type      TEXT NOT NULL DEFAULT 'quarterly',
  revenue          BIGINT,
  gross_profit     BIGINT,
  operating_income BIGINT,
  net_income       BIGINT,
  eps_diluted      FLOAT,
  eps_basic        FLOAT,
  shares_diluted   BIGINT,
  fetched_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, period_type, period_end)
);

CREATE INDEX IF NOT EXISTS fundamentals_symbol_idx ON fundamentals(symbol);
CREATE INDEX IF NOT EXISTS fundamentals_period_idx ON fundamentals(period_end DESC);

CREATE TABLE IF NOT EXISTS stock_predictions (
  id                  SERIAL PRIMARY KEY,
  symbol              VARCHAR(20) NOT NULL,
  week_start          DATE NOT NULL,          -- Monday of the prediction week
  target_date         DATE NOT NULL,          -- specific trading day being predicted
  predicted_price     NUMERIC(12,4),          -- model's projected close price
  predicted_change_pct NUMERIC(8,4),          -- % change from base price at prediction time
  base_price          NUMERIC(12,4),          -- last close when prediction was made
  actual_price        NUMERIC(12,4),          -- actual close (filled by EOD cron)
  actual_change_pct   NUMERIC(8,4),           -- actual % change vs base_price
  error_pct           NUMERIC(8,4),           -- (actual - predicted) / predicted * 100
  algorithm_signal    INTEGER,                -- 0-100 overall signal
  slope_per_day       NUMERIC(10,6),          -- linear regression slope used
  r_squared           NUMERIC(6,4),           -- regression quality
  has_earnings        BOOLEAN DEFAULT false,  -- earnings fall within this week
  earnings_date       DATE,                   -- next earnings date if within 30 days
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, week_start, target_date)
);

CREATE INDEX IF NOT EXISTS stock_predictions_symbol_idx  ON stock_predictions(symbol);
CREATE INDEX IF NOT EXISTS stock_predictions_week_idx    ON stock_predictions(week_start DESC);
CREATE INDEX IF NOT EXISTS stock_predictions_target_idx  ON stock_predictions(target_date DESC);

-- Calibration columns added after initial schema (safe to re-run)
ALTER TABLE stock_predictions ADD COLUMN IF NOT EXISTS adjusted_change_pct NUMERIC(8,4);
ALTER TABLE stock_predictions ADD COLUMN IF NOT EXISTS confidence          INTEGER;
-- UW conviction modifier columns (additive — does NOT drop or rename existing columns)
ALTER TABLE stock_predictions ADD COLUMN IF NOT EXISTS uw_modifier_delta   INTEGER;
ALTER TABLE stock_predictions ADD COLUMN IF NOT EXISTS uw_modifier_reason  VARCHAR(50);
ALTER TABLE stock_predictions ADD COLUMN IF NOT EXISTS uw_modifier_label   VARCHAR(30);
-- News sentiment modifier columns (parallel to UW modifier, independent)
ALTER TABLE stock_predictions ADD COLUMN IF NOT EXISTS news_modifier_delta  INTEGER;
ALTER TABLE stock_predictions ADD COLUMN IF NOT EXISTS news_modifier_reason TEXT;
ALTER TABLE stock_predictions ADD COLUMN IF NOT EXISTS news_modifier_label  TEXT;

CREATE TABLE IF NOT EXISTS prediction_calibration (
  symbol       VARCHAR(20) NOT NULL,
  feature      VARCHAR(50) NOT NULL,
  value        NUMERIC(10,6) NOT NULL,
  sample_size  INTEGER NOT NULL DEFAULT 0,
  last_trained TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (symbol, feature)
);

CREATE TABLE IF NOT EXISTS prediction_calibration_global (
  feature      VARCHAR(80) NOT NULL PRIMARY KEY,
  value        NUMERIC(10,6) NOT NULL,
  sample_size  INTEGER NOT NULL DEFAULT 0,
  last_trained TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prediction_errors (
  id                   SERIAL PRIMARY KEY,
  symbol               VARCHAR(20) NOT NULL,
  target_date          DATE NOT NULL,
  r_squared            NUMERIC(6,4),
  algorithm_signal     INTEGER,
  predicted_change_pct NUMERIC(8,4),
  actual_change_pct    NUMERIC(8,4),
  error_pct            NUMERIC(8,4),
  direction_correct    BOOLEAN,
  recorded_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, target_date)
);
-- Legal consent columns
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='terms_accepted_at') THEN
    ALTER TABLE users ADD COLUMN terms_accepted_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN terms_version VARCHAR(10);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='auto_trade_consent_at') THEN
    ALTER TABLE users ADD COLUMN auto_trade_consent_at TIMESTAMPTZ;
  END IF;
END $$;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS slippage_cents NUMERIC(8,2);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS account_source VARCHAR(20);
DO $$ BEGIN
  ALTER TABLE trades ADD COLUMN IF NOT EXISTS bot_id       BIGINT;
  ALTER TABLE trades ADD COLUMN IF NOT EXISTS peak_pnl_usd NUMERIC(12,2) DEFAULT 0;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_trades_bot_id ON trades(bot_id);

-- B-3.7: Setup classification columns
ALTER TABLE bot_decisions ADD COLUMN IF NOT EXISTS setup_type VARCHAR(30);
ALTER TABLE bot_decisions ADD COLUMN IF NOT EXISTS thesis JSONB;
CREATE INDEX IF NOT EXISTS idx_bot_decisions_setup ON bot_decisions(setup_type);

ALTER TABLE trades ADD COLUMN IF NOT EXISTS setup_type VARCHAR(30);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS thesis JSONB;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS expected_hold_days_min INT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS expected_hold_days_max INT;
CREATE INDEX IF NOT EXISTS idx_trades_setup ON trades(setup_type);
CREATE INDEX IF NOT EXISTS idx_trades_bot_id_status ON trades(bot_id, status);

CREATE TABLE IF NOT EXISTS catalyst_performance (
  id           SERIAL PRIMARY KEY,
  trade_date   DATE NOT NULL,
  symbol       VARCHAR(20) NOT NULL,
  company      TEXT,
  bucket       VARCHAR(5),
  call_time    VARCHAR(5),
  entry_price  NUMERIC(12,4),
  exit_price   NUMERIC(12,4),
  change_pct   NUMERIC(8,4),
  pnl_1000     NUMERIC(10,2),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(trade_date, symbol)
);
CREATE INDEX IF NOT EXISTS idx_catperf_date ON catalyst_performance(trade_date);

CREATE TABLE IF NOT EXISTS agent_error_log (
  id           SERIAL PRIMARY KEY,
  source       VARCHAR(20) NOT NULL DEFAULT 'server',
  level        VARCHAR(10) NOT NULL DEFAULT 'error',
  message      TEXT NOT NULL,
  stack        TEXT,
  url          TEXT,
  context      JSONB,
  auto_action  VARCHAR(100),
  resolved     BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_errlog_created ON agent_error_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errlog_source  ON agent_error_log(source);

CREATE TABLE IF NOT EXISTS user_notes (
  id         SERIAL PRIMARY KEY,
  username   VARCHAR(100) NOT NULL,
  symbol     VARCHAR(20),
  content    TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  title      VARCHAR(255) NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_notes_username ON user_notes(username, created_at DESC);

CREATE TABLE IF NOT EXISTS user_reminders (
  id          SERIAL PRIMARY KEY,
  username    VARCHAR(100) NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  remind_at   TIMESTAMPTZ NOT NULL,
  done        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  emailed_at  TIMESTAMPTZ,
  dismissed   BOOLEAN DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_user_reminders_username ON user_reminders(username, remind_at);

CREATE TABLE IF NOT EXISTS sentinel_runs (
  id             SERIAL PRIMARY KEY,
  mode           VARCHAR(20) NOT NULL,
  as_of          TIMESTAMPTZ NOT NULL,
  risks_json     JSONB,
  proposals_json JSONB,
  email_sent     BOOLEAN DEFAULT FALSE,
  error          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol           TEXT NOT NULL,
  broker           TEXT NOT NULL DEFAULT 'alpaca',
  side             TEXT NOT NULL,
  qty              NUMERIC(12,4) NOT NULL,
  limit_price      NUMERIC(12,4),
  stop_price       NUMERIC(12,4),
  reason           TEXT,
  severity         TEXT,
  signed_token     TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  executed_at      TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'pending',
  execution_result JSONB
);
CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_actions(status, expires_at);

CREATE TABLE IF NOT EXISTS uw_options_flow (
  id            SERIAL PRIMARY KEY,
  ticker        VARCHAR(20)  NOT NULL,
  side          VARCHAR(10),
  strike        NUMERIC(12,4),
  expiry        DATE,
  premium       NUMERIC(14,2),
  volume        INT,
  open_interest INT,
  sentiment     TEXT,
  raw           JSONB,
  ingested_at   TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(ticker, strike, expiry, ingested_at)
);
CREATE INDEX IF NOT EXISTS idx_uw_options_flow_ticker ON uw_options_flow(ticker);
CREATE INDEX IF NOT EXISTS idx_uw_options_flow_ingested ON uw_options_flow(ingested_at DESC);

CREATE TABLE IF NOT EXISTS uw_insider_trades (
  id               SERIAL PRIMARY KEY,
  ticker           VARCHAR(20)  NOT NULL,
  insider_name     TEXT,
  role             TEXT,
  transaction_type TEXT,
  shares           NUMERIC(14,4),
  price            NUMERIC(12,4),
  value            NUMERIC(16,2),
  filed_at         TIMESTAMPTZ,
  ingested_at      TIMESTAMPTZ  DEFAULT NOW()
);
-- Migration: replace nullable-column UNIQUE with expression index (NULL != NULL in plain UNIQUE)
DO $$ BEGIN
  ALTER TABLE uw_insider_trades DROP CONSTRAINT IF EXISTS "uw_insider_trades_ticker_insider_name_filed_at_transaction__key";
EXCEPTION WHEN others THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_uw_insider_unique ON uw_insider_trades(
  ticker,
  COALESCE(insider_name, ''),
  COALESCE(filed_at, '1900-01-01'::timestamptz),
  COALESCE(transaction_type, '')
);
CREATE INDEX IF NOT EXISTS idx_uw_insider_ticker ON uw_insider_trades(ticker);
CREATE INDEX IF NOT EXISTS idx_uw_insider_filed  ON uw_insider_trades(filed_at DESC);

CREATE TABLE IF NOT EXISTS uw_congressional_trades (
  id               SERIAL PRIMARY KEY,
  ticker           VARCHAR(20)  NOT NULL,
  member_name      TEXT,
  party            TEXT,
  chamber          TEXT,
  transaction_type TEXT,
  amount_range     TEXT,
  traded_at        DATE,
  filed_at         TIMESTAMPTZ,
  ingested_at      TIMESTAMPTZ  DEFAULT NOW()
);
-- Migration: replace nullable-column UNIQUE with expression index
DO $$ BEGIN
  ALTER TABLE uw_congressional_trades DROP CONSTRAINT IF EXISTS "uw_congressional_trades_ticker_member_name_traded_at_transa_key";
EXCEPTION WHEN others THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_uw_congress_unique ON uw_congressional_trades(
  ticker,
  COALESCE(member_name, ''),
  COALESCE(traded_at, '1900-01-01'::date),
  COALESCE(transaction_type, '')
);
CREATE INDEX IF NOT EXISTS idx_uw_congress_ticker ON uw_congressional_trades(ticker);
CREATE INDEX IF NOT EXISTS idx_uw_congress_traded ON uw_congressional_trades(traded_at DESC);

CREATE TABLE IF NOT EXISTS uw_top_movers (
  id            SERIAL PRIMARY KEY,
  ticker        VARCHAR(20)  NOT NULL,
  direction     VARCHAR(20)  NOT NULL,
  change_pct    NUMERIC(10,4),
  price         NUMERIC(12,4),
  volume        BIGINT,
  raw           JSONB,
  captured_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ingested_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (ticker, direction, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_uw_movers_captured ON uw_top_movers(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_uw_movers_ticker   ON uw_top_movers(ticker);

CREATE TABLE IF NOT EXISTS uw_flow_alerts (
  id              SERIAL PRIMARY KEY,
  ticker          VARCHAR(20) NOT NULL,
  alert_type      VARCHAR(40),
  side            VARCHAR(10),
  strike          NUMERIC(12,4),
  expiry          DATE,
  premium         NUMERIC(14,2),
  volume          BIGINT,
  open_interest   BIGINT,
  iv              NUMERIC(8,4),
  sentiment       VARCHAR(20),
  raw             JSONB,
  alerted_at      TIMESTAMPTZ NOT NULL,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Migration: replace nullable-column UNIQUE with expression index
DO $$ BEGIN
  ALTER TABLE uw_flow_alerts DROP CONSTRAINT IF EXISTS "uw_flow_alerts_ticker_strike_expiry_side_alerted_at_key";
EXCEPTION WHEN others THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_uw_flow_alerts_unique ON uw_flow_alerts(
  ticker,
  COALESCE(strike, -1),
  COALESCE(expiry, '1900-01-01'::date),
  COALESCE(side, ''),
  alerted_at
);
CREATE INDEX IF NOT EXISTS idx_uw_flow_alerted_at ON uw_flow_alerts(alerted_at DESC);
CREATE INDEX IF NOT EXISTS idx_uw_flow_ticker     ON uw_flow_alerts(ticker, alerted_at DESC);
CREATE INDEX IF NOT EXISTS idx_uw_flow_premium    ON uw_flow_alerts(premium DESC) WHERE premium > 100000;

CREATE TABLE IF NOT EXISTS uw_economic_calendar (
  id            SERIAL PRIMARY KEY,
  event_date    DATE NOT NULL,
  event_name    TEXT NOT NULL,
  country       VARCHAR(10) NOT NULL DEFAULT '',
  importance    VARCHAR(20),
  actual        NUMERIC,
  forecast      NUMERIC,
  previous      NUMERIC,
  raw           JSONB,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Expression index handles NULL country equivalence (NULL != NULL in plain UNIQUE)
CREATE UNIQUE INDEX IF NOT EXISTS idx_uw_econ_unique ON uw_economic_calendar(event_date, event_name, COALESCE(country, ''));
CREATE INDEX IF NOT EXISTS idx_uw_econ_date ON uw_economic_calendar(event_date);

CREATE TABLE IF NOT EXISTS uw_ipo_calendar (
  id            SERIAL PRIMARY KEY,
  ticker        VARCHAR(20),
  company_name  TEXT,
  ipo_date      DATE,
  price_low     NUMERIC(10,4),
  price_high    NUMERIC(10,4),
  shares        BIGINT,
  exchange      VARCHAR(20),
  status        VARCHAR(20),
  raw           JSONB,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ticker, ipo_date)
);
CREATE INDEX IF NOT EXISTS idx_uw_ipo_date ON uw_ipo_calendar(ipo_date);

-- Greek exposure: UW returns an array of daily snapshots, each with call/put gamma/delta/charm/vanna.
CREATE TABLE IF NOT EXISTS uw_greek_exposure (
  id          SERIAL PRIMARY KEY,
  ticker      VARCHAR(20) NOT NULL,
  as_of_date  DATE NOT NULL,
  call_gamma  NUMERIC(20,4),
  put_gamma   NUMERIC(20,4),
  call_delta  NUMERIC(20,4),
  put_delta   NUMERIC(20,4),
  call_charm  NUMERIC(20,4),
  put_charm   NUMERIC(20,4),
  call_vanna  NUMERIC(20,4),
  put_vanna   NUMERIC(20,4),
  raw         JSONB,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ticker, as_of_date)
);
CREATE INDEX IF NOT EXISTS idx_uw_gex_ticker_date ON uw_greek_exposure(ticker, as_of_date DESC);

CREATE TABLE IF NOT EXISTS uw_max_pain (
  id                SERIAL PRIMARY KEY,
  ticker            VARCHAR(20) NOT NULL,
  expiry            DATE NOT NULL,
  max_pain_strike   NUMERIC(12,4),
  spot_price        NUMERIC(12,4),
  open_price        NUMERIC(12,4),
  next_lower_strike NUMERIC(12,4),
  next_upper_strike NUMERIC(12,4),
  raw               JSONB,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ticker, expiry, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_uw_max_pain_ticker ON uw_max_pain(ticker, captured_at DESC);

CREATE TABLE IF NOT EXISTS uw_options_volume (
  id                SERIAL PRIMARY KEY,
  ticker            VARCHAR(20) NOT NULL,
  trade_date        DATE NOT NULL,
  call_volume       BIGINT,
  put_volume        BIGINT,
  call_open_interest BIGINT,
  put_open_interest  BIGINT,
  call_premium      NUMERIC(20,2),
  put_premium       NUMERIC(20,2),
  bullish_premium   NUMERIC(20,2),
  bearish_premium   NUMERIC(20,2),
  net_call_premium  NUMERIC(20,2),
  net_put_premium   NUMERIC(20,2),
  raw               JSONB,
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ticker, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_uw_options_volume_ticker ON uw_options_volume(ticker, trade_date DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_actions_unique_pending
  ON pending_actions(symbol, side, qty)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS system_alerts (
  id                SERIAL PRIMARY KEY,
  key               VARCHAR(120) NOT NULL,
  severity          VARCHAR(20)  NOT NULL,
  title             TEXT NOT NULL,
  detail            JSONB,
  email_sent        BOOLEAN NOT NULL DEFAULT FALSE,
  email_suppressed  BOOLEAN NOT NULL DEFAULT FALSE,
  email_error       TEXT,
  hostname          VARCHAR(120),
  pid               INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_system_alerts_key_time ON system_alerts(key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_alerts_severity ON system_alerts(severity, created_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          SERIAL PRIMARY KEY,
  username    TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (username, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_subs_username ON push_subscriptions(username);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id             SERIAL PRIMARY KEY,
  username       TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  credential_id  BYTEA UNIQUE NOT NULL,
  public_key     BYTEA NOT NULL,
  counter        BIGINT NOT NULL DEFAULT 0,
  device_name    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webauthn_username ON webauthn_credentials(username);

CREATE TABLE IF NOT EXISTS benzinga_news (
  id            BIGSERIAL PRIMARY KEY,
  article_id    TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  teaser        TEXT,
  url           TEXT,
  source        TEXT,
  author        TEXT,
  image_url     TEXT,
  channels      JSONB,
  tickers       JSONB,
  sentiment     TEXT,
  published_at  TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ,
  raw           JSONB,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bz_news_published ON benzinga_news(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_bz_news_tickers   ON benzinga_news USING GIN(tickers);
CREATE INDEX IF NOT EXISTS idx_bz_news_sentiment ON benzinga_news(sentiment) WHERE sentiment IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bz_news_source    ON benzinga_news(source);
CREATE INDEX IF NOT EXISTS idx_bz_news_search    ON benzinga_news USING GIN(
  to_tsvector('english', coalesce(title,'') || ' ' || coalesce(teaser,''))
);

CREATE TABLE IF NOT EXISTS news_saved (
  id          BIGSERIAL PRIMARY KEY,
  username    TEXT NOT NULL,
  article_id  TEXT NOT NULL,
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (username, article_id)
);
CREATE INDEX IF NOT EXISTS idx_news_saved_user ON news_saved(username, saved_at DESC);

-- ─── Bots ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bots (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'paused',
  account_type        TEXT NOT NULL DEFAULT 'paper',
  broker              TEXT NOT NULL DEFAULT 'alpaca',
  capital_usd         NUMERIC(12,2) NOT NULL,
  rules               JSONB NOT NULL,
  current_trade_id    BIGINT,
  cumulative_pnl_usd  NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_trades        INT NOT NULL DEFAULT 0,
  winning_trades      INT NOT NULL DEFAULT 0,
  status_message      TEXT,
  status_changed_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bots_user_status ON bots(user_id, status);

CREATE TABLE IF NOT EXISTS bot_decisions (
  id               BIGSERIAL PRIMARY KEY,
  bot_id           BIGINT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  scanned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action           TEXT NOT NULL,
  symbol           VARCHAR(20),
  composite_score  NUMERIC(6,2),
  factor_breakdown JSONB,
  notes            TEXT
);
CREATE INDEX IF NOT EXISTS idx_bot_decisions_bot_time ON bot_decisions(bot_id, scanned_at DESC);

CREATE TABLE IF NOT EXISTS trade_postmortems (
  id              BIGSERIAL PRIMARY KEY,
  bot_id          BIGINT NOT NULL REFERENCES bots(id),
  trade_id        BIGINT NOT NULL,
  pnl_usd         NUMERIC(12,2),
  entry_snapshot  JSONB,
  exit_snapshot   JSONB,
  diff_analysis   JSONB,
  prose_summary   TEXT,
  email_sent      BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_postmortems_bot_time ON trade_postmortems(bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bot_rules_versions (
  id          BIGSERIAL PRIMARY KEY,
  bot_id      BIGINT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  rules_json  JSONB NOT NULL,
  set_by      TEXT NOT NULL,
  nl_input    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_rules_bot_time ON bot_rules_versions(bot_id, created_at DESC);

ALTER TABLE bots ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_bots_deleted_at ON bots(deleted_at);

CREATE TABLE IF NOT EXISTS system_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Tradable Universe ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradable_universe (
  symbol          VARCHAR(20) PRIMARY KEY,
  exchange        VARCHAR(10),
  asset_class     VARCHAR(20),
  fractionable    BOOLEAN,
  marginable      BOOLEAN,
  shortable       BOOLEAN,
  easy_to_borrow  BOOLEAN,
  market_cap_usd  NUMERIC(20,2),
  avg_volume_30d  NUMERIC(20,2),
  adv_dollar_30d  NUMERIC(20,2),
  last_price      NUMERIC(12,4),
  sector          VARCHAR(60),
  last_synced_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tradable_universe_filters
  ON tradable_universe (market_cap_usd, adv_dollar_30d)
  WHERE market_cap_usd IS NOT NULL AND adv_dollar_30d IS NOT NULL;
`;

// ─── Pool ─────────────────────────────────────────────────────────────────────

let pool = null;
let dbAvailable = false;

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('⚠️  DATABASE_URL not set — running without database (JSON fallback active)');
    return;
  }

  pool = new Pool({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    console.error('DB pool error:', err.message);
  });

  const RETRYABLE = ['deadlock detected', 'could not serialize', 'canceling statement'];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const client = await pool.connect();
      await client.query(SCHEMA);
      // Idempotent column-type migrations (safe to re-run on every boot)
      try {
        await client.query(`ALTER TABLE trades ALTER COLUMN conviction_score TYPE NUMERIC(6,2) USING conviction_score::numeric`);
      } catch (e) {
        console.warn('[initDb] conviction_score migration skipped:', e.message);
      }
      client.release();
      dbAvailable = true;
      console.log('✅ Database connected and schema ready');
      return;
    } catch (err) {
      const isRetryable = RETRYABLE.some(s => err.message.includes(s));
      if (isRetryable && attempt < 3) {
        console.warn(`⚠️  DB schema attempt ${attempt} failed (${err.message}) — retrying in ${attempt * 2}s…`);
        await new Promise(r => setTimeout(r, attempt * 2000));
        continue;
      }
      console.warn(`⚠️  Database unavailable (${err.message}) — running without database`);
      await pool.end().catch(() => {});
      pool = null;
      return;
    }
  }
}

export function isDbAvailable() {
  return dbAvailable;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

export async function query(sql, params = []) {
  if (!pool) throw new Error('Database not available');
  const result = await pool.query(sql, params);
  return result;
}

export async function getClient() {
  if (!pool) throw new Error('Database not available');
  return pool.connect();
}

// ─── Conversation history ─────────────────────────────────────────────────────

export async function loadConversationHistory(chatId) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `SELECT role, content FROM conversation_history
       WHERE chat_id = $1 ORDER BY created_at ASC`,
      [chatId]
    );
    return rows.map(r => ({ role: r.role, content: r.content }));
  } catch (err) {
    console.error('loadConversationHistory error:', err.message);
    return null;
  }
}

export async function appendConversationMessage(chatId, message) {
  if (!dbAvailable) return;
  const { role, content } = message ?? {};
  if (!role) return;
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
  try {
    await query(
      `INSERT INTO conversation_history (chat_id, role, content) VALUES ($1, $2, $3)`,
      [chatId, role, contentStr]
    );
    // Keep only last 40 messages per chat
    await query(
      `DELETE FROM conversation_history
       WHERE chat_id = $1 AND id NOT IN (
         SELECT id FROM conversation_history
         WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 40
       )`,
      [chatId]
    );
  } catch (err) {
    console.error('appendConversationMessage error:', err.message);
  }
}

export async function clearConversationHistory(chatId) {
  if (!dbAvailable) return;
  try {
    await query(`DELETE FROM conversation_history WHERE chat_id = $1`, [chatId]);
  } catch (err) {
    console.error('clearConversationHistory error:', err.message);
  }
}

// ─── Usage stats ──────────────────────────────────────────────────────────────

export async function recordApiCall({ source, inputTokens, outputTokens, toolCalls, costUsd, durationMs, model, username }) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO api_calls (source, input_tokens, output_tokens, tool_calls, cost_usd, duration_ms, model, username)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [source, inputTokens ?? 0, outputTokens ?? 0, toolCalls ?? 0, costUsd ?? 0, durationMs ?? null, model ?? null, username ?? null]
    );
  } catch (err) {
    console.error('recordApiCall error:', err.message);
  }
}

export async function getApiCallStats({ days = 30, username } = {}) {
  if (!dbAvailable) return null;
  try {
    const userFilter = username ? ` AND username = '${username.replace(/'/g, "''")}'` : '';
    const { rows: daily } = await query(
      `SELECT
         TO_CHAR(called_at::date, 'YYYY-MM-DD')  AS date,
         source,
         MODE() WITHIN GROUP (ORDER BY model)    AS model,
         COUNT(*)                                 AS calls,
         SUM(input_tokens)                        AS input_tokens,
         SUM(output_tokens)                       AS output_tokens,
         SUM(tool_calls)                          AS tool_calls,
         SUM(cost_usd)                            AS cost_usd,
         ROUND(AVG(duration_ms))                  AS avg_duration_ms,
         ROUND(AVG(input_tokens))                 AS avg_input_tokens,
         ROUND(AVG(output_tokens))                AS avg_output_tokens
       FROM api_calls
       WHERE called_at >= NOW() - ($1 || ' days')::INTERVAL${userFilter}
       GROUP BY date, source
       ORDER BY date DESC, source`,
      [days]
    );
    const { rows: totals } = await query(
      `SELECT
         source,
         COUNT(*)          AS total_calls,
         SUM(input_tokens) AS total_input,
         SUM(output_tokens)AS total_output,
         SUM(tool_calls)   AS total_tools,
         SUM(cost_usd)     AS total_cost,
         MIN(called_at)    AS first_call,
         MAX(called_at)    AS last_call
       FROM api_calls
       WHERE called_at >= NOW() - ($1 || ' days')::INTERVAL${userFilter}
       GROUP BY source
       ORDER BY total_cost DESC`,
      [days]
    );
    const { rows: recent } = await query(
      `SELECT source, input_tokens, output_tokens, tool_calls, cost_usd, duration_ms, model, called_at
       FROM api_calls
       WHERE 1=1${userFilter}
       ORDER BY called_at DESC LIMIT 50`
    );
    return { daily, totals, recent };
  } catch (err) {
    console.error('getApiCallStats error:', err.message);
    return null;
  }
}

export async function upsertUsageStats({ inputTokens, outputTokens, toolCalls, costUsd }) {
  if (!dbAvailable) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    await query(
      `INSERT INTO usage_stats (date, total_messages, total_tool_calls, input_tokens, output_tokens, estimated_cost_usd, updated_at)
       VALUES ($1, 1, $2, $3, $4, $5, NOW())
       ON CONFLICT (date) DO UPDATE SET
         total_messages     = usage_stats.total_messages + 1,
         total_tool_calls   = usage_stats.total_tool_calls + $2,
         input_tokens       = usage_stats.input_tokens + $3,
         output_tokens      = usage_stats.output_tokens + $4,
         estimated_cost_usd = usage_stats.estimated_cost_usd + $5,
         updated_at         = NOW()`,
      [today, toolCalls ?? 0, inputTokens ?? 0, outputTokens ?? 0, costUsd ?? 0]
    );
  } catch (err) {
    console.error('upsertUsageStats error:', err.message);
  }
}

export async function getUsageStats({ days = 30 } = {}) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `SELECT * FROM usage_stats
       WHERE date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
       ORDER BY date DESC`,
      [days]
    );
    return rows;
  } catch (err) {
    console.error('getUsageStats error:', err.message);
    return null;
  }
}

export async function getTodaySpend() {
  if (!dbAvailable) return 0;
  try {
    const today = new Date().toISOString().split('T')[0];
    const { rows } = await query(
      `SELECT COALESCE(estimated_cost_usd, 0) AS spend FROM usage_stats WHERE date = $1`,
      [today]
    );
    return parseFloat(rows[0]?.spend ?? 0);
  } catch { return 0; }
}

// ─── Trade recording ──────────────────────────────────────────────────────────

export async function recordTrade({
  order_id, symbol, side, qty, entry_price,
  stop_loss, take_profit, dollars_invested,
  stop_loss_pct, take_profit_pct, atr_pct,
  conviction_score, conviction_grade, conviction_breakdown,
  username,
  status = 'open', exit_price = null, pnl_usd = null, pnl_pct = null,
  slippage_cents = null,
  account_source = null,
  setup_type = null, thesis = null,
  expected_hold_days_min = null, expected_hold_days_max = null,
}) {
  if (!dbAvailable) return null;
  try {
    const closedAt = status === 'closed' ? new Date().toISOString() : null;
    const { rows } = await query(
      `INSERT INTO trades
         (order_id, symbol, side, qty, entry_price, stop_loss, take_profit,
          dollars_invested, stop_loss_pct, take_profit_pct, atr_pct,
          conviction_score, conviction_grade, conviction_breakdown, username,
          status, exit_price, pnl_usd, pnl_pct, closed_at, slippage_cents, account_source,
          setup_type, thesis, expected_hold_days_min, expected_hold_days_max)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING id`,
      [order_id, symbol, side, qty, entry_price, stop_loss, take_profit,
       dollars_invested, stop_loss_pct, take_profit_pct, atr_pct,
       conviction_score, conviction_grade,
       conviction_breakdown ? JSON.stringify(conviction_breakdown) : null,
       username ?? null,
       status, exit_price ?? null, pnl_usd ?? null, pnl_pct ?? null, closedAt,
       slippage_cents ?? null, account_source ?? null,
       setup_type ?? null, thesis ? JSON.stringify(thesis) : null,
       expected_hold_days_min ?? null, expected_hold_days_max ?? null]
    );
    if (!rows.length) {
      console.warn(`[recordTrade] no row returned — likely ON CONFLICT collision on order_id=${order_id}`);
    }
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error('recordTrade error:', err.message);
    return null;
  }
}

export async function closeTrade({ order_id, symbol, exit_price, pnl_usd, pnl_pct }) {
  if (!dbAvailable) return;
  try {
    if (order_id) {
      await query(
        `UPDATE trades SET status='closed', exit_price=$2, pnl_usd=$3, pnl_pct=$4, closed_at=NOW()
         WHERE order_id=$1 AND status='open'`,
        [order_id, exit_price, pnl_usd, pnl_pct]
      );
    } else if (symbol) {
      await query(
        `UPDATE trades SET status='closed', exit_price=$2, pnl_usd=$3, pnl_pct=$4, closed_at=NOW()
         WHERE id = (SELECT id FROM trades WHERE symbol=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1)`,
        [symbol.toUpperCase(), exit_price, pnl_usd, pnl_pct]
      );
    }
  } catch (err) {
    console.error('closeTrade error:', err.message);
  }
}

export async function getOpenTrade(symbol, { account_source } = {}) {
  if (!dbAvailable) return null;
  try {
    const src = account_source ? ` AND (account_source = $2 OR account_source IS NULL)` : '';
    const params = [symbol.toUpperCase()];
    if (account_source) params.push(account_source);
    const { rows } = await query(
      `SELECT * FROM trades WHERE symbol = $1 AND status = 'open'${src} ORDER BY opened_at DESC LIMIT 1`,
      params
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error('getOpenTrade error:', err.message);
    return null;
  }
}

export async function getTrades({ status, username, account_source, limit = 50 } = {}) {
  if (!dbAvailable) return null;
  try {
    const where = [];
    const params = [];
    if (status)         { where.push(`status = $${params.length + 1}`);         params.push(status); }
    if (username)       { where.push(`username = $${params.length + 1}`);       params.push(username); }
    if (account_source) {
      if (account_source === 'alpaca_paper') {
        // Accept both canonical 'alpaca_paper' and legacy 'alpaca' tag from bot-executor
        where.push(`(account_source IN ('alpaca_paper', 'alpaca') OR account_source IS NULL)`);
      } else {
        where.push(`(account_source = $${params.length + 1} OR account_source IS NULL)`);
        params.push(account_source);
      }
    }
    params.push(limit);
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const { rows } = await query(
      `SELECT t.*, b.name AS bot_name
       FROM trades t
       LEFT JOIN bots b ON b.id = t.bot_id
       ${whereClause} ORDER BY t.opened_at DESC LIMIT $${params.length}`,
      params
    );
    return rows;
  } catch (err) {
    console.error('getTrades error:', err.message);
    return null;
  }
}

// ─── Trade rejections ─────────────────────────────────────────────────────────

export async function logRejection({ symbol, reason, conviction_score = null }) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO trade_rejections (symbol, reason, conviction_score) VALUES ($1, $2, $3)`,
      [symbol?.toUpperCase() ?? null, reason, conviction_score ?? null]
    );
  } catch (err) {
    console.error('logRejection error:', err.message);
  }
}

// ─── Daily Picks (strong-buy + intraday — stored for simulation) ─────────────

export async function saveDailyPick(pick) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO daily_picks
         (date, type, symbol, name, score, grade, horizon, price,
          rvol, atr_pct, stop_price, target_price, signals)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (date, type, symbol) DO UPDATE SET
         price        = EXCLUDED.price,
         rvol         = EXCLUDED.rvol,
         atr_pct      = EXCLUDED.atr_pct,
         stop_price   = EXCLUDED.stop_price,
         target_price = EXCLUDED.target_price,
         signals      = EXCLUDED.signals`,
      [
        pick.date, pick.type, pick.symbol, pick.name ?? null,
        pick.score ?? null, pick.grade ?? null, pick.horizon ?? null,
        pick.price ?? null, pick.rvol ?? null, pick.atr_pct ?? null,
        pick.stop_price ?? null, pick.target_price ?? null,
        pick.signals ? JSON.stringify(pick.signals) : null,
      ]
    );
  } catch (err) {
    console.error('saveDailyPick error:', err.message);
  }
}

export async function getDailyPicks({ date, type, days = 30, limit = 200 } = {}) {
  if (!dbAvailable) return [];
  try {
    const conditions = [];
    const params     = [];
    if (date) {
      params.push(date);
      conditions.push(`date = $${params.length}`);
    } else {
      params.push(days);
      conditions.push(`date >= CURRENT_DATE - ($${params.length} || ' days')::INTERVAL`);
    }
    if (type) {
      params.push(type);
      conditions.push(`type = $${params.length}`);
    }
    params.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT * FROM daily_picks ${where} ORDER BY date DESC, score DESC NULLS LAST LIMIT $${params.length}`,
      params
    );
    return rows;
  } catch (err) {
    console.error('getDailyPicks error:', err.message);
    return [];
  }
}

export async function getRejections({ limit = 50 } = {}) {
  if (!dbAvailable) return [];
  try {
    const { rows } = await query(
      `SELECT * FROM trade_rejections ORDER BY rejected_at DESC LIMIT $1`,
      [limit]
    );
    return rows;
  } catch (err) {
    console.error('getRejections error:', err.message);
    return [];
  }
}

export async function getRecentLosses({ symbol, days = 5, account_source } = {}) {
  if (!dbAvailable) return { loss_count: 0, total_pnl: 0, last_loss_at: null };
  try {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const srcClause = account_source
      ? ` AND (account_source = $3 OR account_source IS NULL)` : '';
    const params = [symbol.toUpperCase(), since.toISOString()];
    if (account_source) params.push(account_source);
    const result = await query(`
      SELECT COUNT(*)        AS loss_count,
             SUM(pnl_usd)   AS total_pnl,
             MAX(closed_at) AS last_loss_at
      FROM trades
      WHERE symbol   = $1
        AND closed_at >= $2
        AND pnl_usd  < 0
        AND status   IN ('closed', 'stopped_out')
        ${srcClause}
    `, params);
    return {
      loss_count:   parseInt(result.rows[0]?.loss_count  || 0),
      total_pnl:    parseFloat(result.rows[0]?.total_pnl || 0),
      last_loss_at: result.rows[0]?.last_loss_at || null,
    };
  } catch (err) {
    console.error('getRecentLosses error:', err.message);
    return { loss_count: 0, total_pnl: 0, last_loss_at: null };
  }
}

// ─── Conviction score history ─────────────────────────────────────────────────

export async function recordConvictionScore({
  symbol, name, score, grade, breakdown, signals, tv_available, technical_summary,
}) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO conviction_scores (symbol, name, score, grade, breakdown, signals, tv_available, technical_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [symbol, name ?? null, Math.round(score), grade,
       breakdown ? JSON.stringify(breakdown) : null,
       signals   ? JSON.stringify(signals)   : null,
       tv_available ?? false,
       technical_summary ?? null]
    );
  } catch (err) {
    console.error('recordConvictionScore error:', err.message);
  }
}

// ─── Doc queries ─────────────────────────────────────────────────────────────

export async function recordDocQuery({ query: searchQuery, found, userIp, userAgent }) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `INSERT INTO doc_queries (query, found, user_ip, user_agent)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [searchQuery, found, userIp || null, userAgent || null]
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error('recordDocQuery error:', err.message);
    return null;
  }
}

export async function getDocQueries({ limit = 100, onlyUnanswered = false } = {}) {
  if (!dbAvailable) return [];
  try {
    const { rows } = await query(
      `SELECT id, query, found, user_ip, notified, created_at
       FROM doc_queries
       ${onlyUnanswered ? 'WHERE found = false' : ''}
       ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows;
  } catch (err) {
    console.error('getDocQueries error:', err.message);
    return [];
  }
}

export async function markDocQueryNotified(id) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE doc_queries SET notified = true WHERE id = $1`, [id]);
  } catch (_) {}
}

// ─── Daily P&L ────────────────────────────────────────────────────────────────

export async function upsertDailyPnl({ date, realized_pnl, unrealized_pnl, total_trades, winning_trades, username = 'admin', source = 'alpaca' }) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO daily_pnl (date, username, source, realized_pnl, unrealized_pnl, total_trades, winning_trades, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (date, username, source) DO UPDATE SET
         realized_pnl   = $4,
         unrealized_pnl = $5,
         total_trades   = $6,
         winning_trades = $7,
         updated_at     = NOW()`,
      [date, username, source, realized_pnl ?? 0, unrealized_pnl ?? 0, total_trades ?? 0, winning_trades ?? 0]
    );
  } catch (err) {
    console.error('upsertDailyPnl error:', err.message);
  }
}

export async function getDailyPnlHistory({ days = 30, username = 'admin', source = 'alpaca' } = {}) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `SELECT * FROM daily_pnl
       WHERE date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
         AND username = $2
         AND source = $3
       ORDER BY date DESC`,
      [days, username, source]
    );
    return rows;
  } catch (err) {
    console.error('getDailyPnlHistory error:', err.message);
    return null;
  }
}

// ─── User activity ────────────────────────────────────────────────────────────

export async function logActivity(username, action, detail = null, ip = null) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO user_activity (username, action, detail, ip) VALUES ($1,$2,$3,$4)`,
      [username, action, detail, ip]
    );
  } catch (err) {
    console.error('logActivity error:', err.message);
  }
}

export async function getActivity({ username, limit = 100 } = {}) {
  if (!dbAvailable) return [];
  try {
    const where  = username ? 'WHERE username=$1' : '';
    const params = username ? [username, limit] : [limit];
    const { rows } = await query(
      `SELECT id, username, action, detail, ip,
              to_char(created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS ts
       FROM user_activity ${where}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return rows;
  } catch (err) {
    console.error('getActivity error:', err.message);
    return [];
  }
}

// ─── OTP tokens ──────────────────────────────────────────────────────────────

export async function createOtpToken(email, codeHash) {
  if (!dbAvailable) throw new Error('Database not available');
  // Invalidate any existing unused tokens for this email first
  await query(`UPDATE otp_tokens SET used = true WHERE email = $1 AND used = false`, [email.toLowerCase()]);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  await query(
    `INSERT INTO otp_tokens (email, code_hash, expires_at) VALUES ($1, $2, $3)`,
    [email.toLowerCase(), codeHash, expiresAt]
  );
}

export async function verifyOtpToken(email, codeHash) {
  if (!dbAvailable) return false;
  const { rows } = await query(
    `SELECT id FROM otp_tokens
     WHERE email = $1 AND code_hash = $2 AND used = false AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [email.toLowerCase(), codeHash]
  );
  if (!rows[0]) return false;
  await query(`UPDATE otp_tokens SET used = true WHERE id = $1`, [rows[0].id]);
  return true;
}

export async function cleanupOtpTokens() {
  if (!dbAvailable) return;
  await query(`DELETE FROM otp_tokens WHERE expires_at < NOW() OR used = true`).catch(() => {});
}

// ─── User management (DB-backed) ─────────────────────────────────────────────

function _decryptUserCreds(row) {
  if (!row) return null;
  return {
    ...row,
    alpaca_api_key:         decryptCredential(row.alpaca_api_key),
    alpaca_secret_key:      decryptCredential(row.alpaca_secret_key),
    alpaca_live_api_key:    decryptCredential(row.alpaca_live_api_key),
    alpaca_live_secret_key: decryptCredential(row.alpaca_live_secret_key),
    moomoo_acc_id:          decryptCredential(row.moomoo_acc_id),
    tiger_id:               decryptCredential(row.tiger_id)      || null,
    tiger_account:          decryptCredential(row.tiger_account) || null,
    tiger_private_key:      decryptCredential(row.tiger_private_key),
    tiger_demo_id:          row.tiger_demo_id      || null,
    tiger_demo_account:     row.tiger_demo_account || null,
    tiger_demo_private_key: decryptCredential(row.tiger_demo_private_key),
  };
}

export async function getDbUser(username) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(`SELECT * FROM users WHERE username = $1`, [username.toLowerCase()]);
    return _decryptUserCreds(rows[0] ?? null);
  } catch (err) {
    console.error('getDbUser error:', err.message);
    return null;
  }
}

export async function getDbUserByEmail(email) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
    return _decryptUserCreds(rows[0] ?? null);
  } catch (err) {
    console.error('getDbUserByEmail error:', err.message);
    return null;
  }
}

export async function createDbUser({ username, email, passwordHash, role = 'viewer', plan = 'free', credits = 100, permissions = null }) {
  const { rows } = await query(
    `INSERT INTO users (username, email, password_hash, role, plan, credits, permissions)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [username.toLowerCase(), email?.toLowerCase() ?? null, passwordHash, role, plan, credits,
     permissions ? JSON.stringify(permissions) : null]
  );
  return rows[0];
}

export async function upsertDbUser({ username, email, passwordHash, role, plan, credits, permissions }) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO users (username, email, password_hash, role, plan, credits, permissions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (username) DO NOTHING`,
      [username.toLowerCase(), email ?? null, passwordHash, role, plan ?? 'free', credits ?? 0,
       permissions ? JSON.stringify(permissions) : null]
    );
  } catch (err) {
    console.error('upsertDbUser error:', err.message);
  }
}

export async function updateDbUserLogin(username) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET last_login = NOW() WHERE username = $1`, [username.toLowerCase()]);
  } catch (err) {
    console.error('updateDbUserLogin error:', err.message);
  }
}

export async function deductCredit(username) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `UPDATE users SET credits = credits - 1 WHERE username = $1 AND credits > 0 RETURNING credits`,
      [username.toLowerCase()]
    );
    return rows[0]?.credits ?? null; // null = credits already 0, nothing deducted
  } catch (err) {
    console.error('deductCredit error:', err.message);
    return null;
  }
}

export async function addCredits(username, amount) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET credits = credits + $2 WHERE username = $1`, [username.toLowerCase(), amount]);
  } catch (err) {
    console.error('addCredits error:', err.message);
  }
}

export async function setDisabledSources(username, sources) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET disabled_sources = $2::jsonb WHERE username = $1`, [username.toLowerCase(), JSON.stringify(sources)]);
  } catch (err) {
    console.error('setDisabledSources error:', err.message);
  }
}

export async function suspendUser(username) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET suspended = true WHERE username = $1`, [username.toLowerCase()]);
  } catch (err) {
    console.error('suspendUser error:', err.message);
  }
}

export async function unsuspendUser(username) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET suspended = false WHERE username = $1`, [username.toLowerCase()]);
  } catch (err) {
    console.error('unsuspendUser error:', err.message);
  }
}

export async function setUserCredits(username, amount) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET credits = $2 WHERE username = $1`, [username.toLowerCase(), amount]);
  } catch (err) {
    console.error('setUserCredits error:', err.message);
  }
}

export async function setUserRole(username, role) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET role = $2 WHERE username = $1`, [username.toLowerCase(), role]);
  } catch (err) {
    console.error('setUserRole error:', err.message);
  }
}

export async function resetUserPassword(username, passwordHash) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET password_hash = $2 WHERE username = $1`, [username.toLowerCase(), passwordHash]);
  } catch (err) {
    console.error('resetUserPassword error:', err.message);
  }
}

export async function listDbUsers() {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `SELECT id, username, email, role, plan, credits, permissions, suspended, created_at, last_login
       FROM users ORDER BY created_at ASC`
    );
    return rows;
  } catch (err) {
    console.error('listDbUsers error:', err.message);
    return null;
  }
}

export async function updateDbUserPermissions(username, permissions) {
  await query(
    `UPDATE users SET permissions = $2 WHERE username = $1`,
    [username.toLowerCase(), permissions ? JSON.stringify(permissions) : null]
  );
}

export async function deleteDbUser(username) {
  await query(`DELETE FROM users WHERE username = $1`, [username.toLowerCase()]);
}

export async function saveUserAlpaca(username, { apiKey, secretKey, baseUrl, accountType }) {
  if (!dbAvailable) throw new Error('Database not available');
  if (accountType === 'live') {
    await query(
      `UPDATE users SET alpaca_live_api_key=$2, alpaca_live_secret_key=$3 WHERE username=$1`,
      [username.toLowerCase(), encryptCredential(apiKey), encryptCredential(secretKey)]
    );
  } else {
    await query(
      `UPDATE users SET alpaca_api_key=$2, alpaca_secret_key=$3, alpaca_base_url=$4 WHERE username=$1`,
      [username.toLowerCase(), encryptCredential(apiKey), encryptCredential(secretKey), baseUrl]
    );
  }
}

export async function clearUserAlpaca(username) {
  if (!dbAvailable) return;
  await query(
    `UPDATE users SET alpaca_api_key=NULL, alpaca_secret_key=NULL, alpaca_base_url=NULL WHERE username=$1`,
    [username.toLowerCase()]
  );
}

export async function clearUserLiveAlpaca(username) {
  if (!dbAvailable) return;
  await query(
    `UPDATE users SET alpaca_live_api_key=NULL, alpaca_live_secret_key=NULL WHERE username=$1`,
    [username.toLowerCase()]
  );
}

export async function saveUserMoomoo(username, accId) {
  if (!dbAvailable) throw new Error('Database not available');
  await query(`UPDATE users SET moomoo_acc_id=$2 WHERE username=$1`, [username.toLowerCase(), encryptCredential(String(accId))]);
}

export async function clearUserMoomoo(username) {
  if (!dbAvailable) return;
  await query(`UPDATE users SET moomoo_acc_id=NULL WHERE username=$1`, [username.toLowerCase()]);
}

export async function saveUserTiger(username, { tigerId, account, privateKey, env = 'live' }) {
  if (!dbAvailable) throw new Error('Database not available');
  const encKey = encryptCredential(privateKey);
  if (env === 'demo') {
    await query(
      `UPDATE users
       SET tiger_demo_id=$2, tiger_demo_private_key=$3, tiger_demo_account=$4
       WHERE username=$1`,
      [username.toLowerCase(), tigerId, encKey, account]
    );
  } else {
    await query(
      `UPDATE users
       SET tiger_id=$2, tiger_private_key=$3, tiger_account=$4
       WHERE username=$1`,
      [username.toLowerCase(), tigerId, encKey, account]
    );
  }
}

export async function clearUserTiger(username, env = null) {
  if (!dbAvailable) return;
  if (env === 'demo') {
    await query(
      `UPDATE users SET tiger_demo_id=NULL, tiger_demo_private_key=NULL, tiger_demo_account=NULL WHERE username=$1`,
      [username.toLowerCase()]
    );
  } else if (env === 'live') {
    await query(
      `UPDATE users SET tiger_id=NULL, tiger_private_key=NULL, tiger_account=NULL WHERE username=$1`,
      [username.toLowerCase()]
    );
  } else {
    await query(
      `UPDATE users SET tiger_id=NULL, tiger_private_key=NULL, tiger_account=NULL,
                        tiger_demo_id=NULL, tiger_demo_private_key=NULL, tiger_demo_account=NULL
       WHERE username=$1`,
      [username.toLowerCase()]
    );
  }
}

// ─── Backtest Factor Weights ──────────────────────────────────────────────────
// Computes which score grade buckets historically generate alpha vs SPY.
// Cached in memory for 24h so it doesn't run on every conviction score call.

let _factorWeightsCache = null;
let _factorWeightsCacheTs = 0;
const FACTOR_WEIGHTS_TTL = 24 * 60 * 60 * 1000; // 24h

export function invalidateFactorWeightsCache() {
  _factorWeightsCache   = null;
  _factorWeightsCacheTs = 0;
}

export async function getFactorWeights() {
  if (!dbAvailable) return null;
  if (_factorWeightsCache && Date.now() - _factorWeightsCacheTs < FACTOR_WEIGHTS_TTL)
    return _factorWeightsCache;

  try {
    // ── 1. Try ML model weights first (populated by npm run research:train) ──
    let mlRow = null;
    try {
      const { rows: mlRows } = await query(`
        SELECT id, trained_at, accuracy, auc_roc, f1_1,
               feature_weights, scoring_adjustments,
               train_rows, test_rows
        FROM model_results
        ORDER BY trained_at DESC
        LIMIT 1
      `);
      if (mlRows.length > 0) mlRow = mlRows[0];
    } catch (e) {
      // model_results table doesn't exist yet — fall through to heuristic
      if (e.code !== '42P01') throw e;
    }

    // ── 2. Always fetch per-grade backtest stats (cheap, good for display) ──
    let byGrade = [];
    try {
      const { rows } = await query(`
        SELECT grade,
               COUNT(*)                                                     AS signals,
               ROUND(AVG(ret_1m)::numeric, 4)                              AS avg_ret_1m,
               ROUND(AVG(ret_1m - spy_1m)::numeric, 4)                     AS avg_alpha_1m,
               ROUND(100.0 * SUM(CASE WHEN ret_1m > 0 THEN 1 END) / COUNT(*), 1) AS win_rate_pct
        FROM backtest_returns
        WHERE ret_1m IS NOT NULL AND spy_1m IS NOT NULL
        GROUP BY grade
        ORDER BY grade
      `);
      byGrade = rows;
    } catch { /* backtest_returns not yet populated — skip */ }

    // ── 3a. ML path: use model's scoring_adjustments ─────────────────────────
    if (mlRow) {
      const adjustments = mlRow.scoring_adjustments ?? {};
      _factorWeightsCache = {
        source:          'ml_model',
        model_id:        mlRow.id,
        trained_at:      mlRow.trained_at,
        auc_roc:         mlRow.auc_roc,
        accuracy:        mlRow.accuracy,
        f1_1:            mlRow.f1_1,
        train_rows:      mlRow.train_rows,
        test_rows:       mlRow.test_rows,
        feature_weights: mlRow.feature_weights ?? {},  // { rsi_norm, macd_sign, … }
        adjustments,                                    // { A: +8, B: +3, C: -2, F: -9 }
        by_grade:        byGrade,
        computed_at:     new Date().toISOString(),
      };
      _factorWeightsCacheTs = Date.now();
      return _factorWeightsCache;
    }

    // ── 3b. Heuristic fallback: derive adjustments from backtest alpha ────────
    if (byGrade.length === 0) return null;

    const gradeAlpha = {};
    for (const r of byGrade) gradeAlpha[r.grade] = parseFloat(r.avg_alpha_1m);
    const vals     = Object.values(gradeAlpha);
    const maxAlpha = Math.max(...vals);
    const minAlpha = Math.min(...vals);
    const range    = maxAlpha - minAlpha || 1;
    const adjustments = {};
    for (const [g, a] of Object.entries(gradeAlpha))
      adjustments[g] = +((a - minAlpha) / range * 20 - 10).toFixed(1);

    _factorWeightsCache = {
      source:          'backtest_heuristic',
      feature_weights: null,
      adjustments,
      by_grade:        byGrade,
      computed_at:     new Date().toISOString(),
    };
    _factorWeightsCacheTs = Date.now();
    return _factorWeightsCache;
  } catch (err) {
    console.error('getFactorWeights error:', err.message);
    return null;
  }
}

// ─── Per-User Bot Configuration ───────────────────────────────────────────────

export const BOT_CONFIG_DEFAULTS = {
  profile:              'moderate',
  daily_profit_target:  150,
  daily_loss_limit:     200,
  max_open_positions:   2,
  min_conviction_score: 50,
  auto_execute:         true,
  max_vix_for_scan:     30,
  trade_source:         'paper', // 'paper' | 'tiger' | 'moomoo'
  position_sizing: {
    min_dollars:             1500,
    max_dollars:             5000,
    target_profit_per_trade: 150,
    stop_multiplier:         1.5,
    target_multiplier:       3.0,
    min_atr_pct:             1.0,
  },
  vix_thresholds: {
    defensive: 25,
    crisis:    35,
  },
  sectors_blocklist: [],
  kb_enabled: true,   // Trading Coach / local knowledge-base routing
};

function _deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const key of Object.keys(overrides || {})) {
    if (overrides[key] !== null && typeof overrides[key] === 'object' && !Array.isArray(overrides[key])) {
      result[key] = _deepMerge(defaults[key] || {}, overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

export async function getUserBotConfig(username) {
  if (!isDbAvailable()) return { ...BOT_CONFIG_DEFAULTS };
  try {
    const r = await query('SELECT bot_config FROM users WHERE username = $1', [username.toLowerCase()]);
    const stored = r.rows[0]?.bot_config;
    if (!stored) return { ...BOT_CONFIG_DEFAULTS };
    return _deepMerge(BOT_CONFIG_DEFAULTS, stored);
  } catch {
    return { ...BOT_CONFIG_DEFAULTS };
  }
}

export async function setUserBotConfig(username, config) {
  if (!isDbAvailable()) throw new Error('Database not available');
  await query('UPDATE users SET bot_config = $1 WHERE username = $2', [JSON.stringify(config), username.toLowerCase()]);
}

// ─── Bug Reports ──────────────────────────────────────────────────────────────

export async function createBugReport({ username, title, description, page }) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `INSERT INTO bug_reports (username, title, description, page)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [username, title, description, page || null]
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error('createBugReport error:', err.message);
    return null;
  }
}

export async function getBugReports({ status, limit = 100 } = {}) {
  if (!dbAvailable) return [];
  try {
    const params = status ? [status, limit] : [limit];
    const { rows } = await query(
      `SELECT id, username, title, description, page, status, admin_note, created_at, resolved_at
       FROM bug_reports
       ${status ? 'WHERE status = $1' : ''}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return rows;
  } catch (err) {
    console.error('getBugReports error:', err.message);
    return [];
  }
}

export async function updateBugReport({ id, status, admin_note }) {
  if (!dbAvailable) return false;
  try {
    const resolved_at = status === 'resolved' ? 'NOW()' : 'NULL';
    await query(
      `UPDATE bug_reports
       SET status     = COALESCE($2, status),
           admin_note = COALESCE($3, admin_note),
           resolved_at = CASE WHEN $2 = 'resolved' THEN NOW() ELSE resolved_at END
       WHERE id = $1`,
      [id, status || null, admin_note ?? null]
    );
    return true;
  } catch (err) {
    console.error('updateBugReport error:', err.message);
    return false;
  }
}

// ─── Scanner State (replaces .scanner-paused flag file) ───────────────────────

export async function getScannerState(key) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(`SELECT value FROM scanner_state WHERE key = $1`, [key]);
    return rows[0]?.value ?? null;
  } catch (err) {
    console.error('getScannerState error:', err.message);
    return null;
  }
}

export async function setScannerState(key, value) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO scanner_state (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  } catch (err) {
    console.error('setScannerState error:', err.message);
  }
}

// ─── Daily Briefings ──────────────────────────────────────────────────────────

export async function saveDailyBriefing({ date, content, regime = null, direction = null, vix = null, type = 'morning' }) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO daily_briefings (date, type, content, regime, direction, vix)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (date, type) DO UPDATE SET content=$3, regime=$4, direction=$5, vix=$6, created_at=NOW()`,
      [date, type, content, regime, direction, vix]
    );
  } catch (err) {
    console.error('saveDailyBriefing error:', err.message);
  }
}

export async function getDailyBriefing(date, type = 'morning') {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `SELECT * FROM daily_briefings WHERE date = $1 AND type = $2`, [date, type]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error('getDailyBriefing error:', err.message);
    return null;
  }
}

// ─── Position Monitoring State ─────────────────────────────────────────────────

export async function upsertPositionMonitoring(row) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO position_monitoring
         (symbol, entry_price, stop_price, target_price, stop_moved_to_be, stop_trailed, last_checked_at, last_price)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
       ON CONFLICT (symbol) DO UPDATE SET
         entry_price      = COALESCE($2, position_monitoring.entry_price),
         stop_price       = COALESCE($3, position_monitoring.stop_price),
         target_price     = COALESCE($4, position_monitoring.target_price),
         stop_moved_to_be = $5,
         stop_trailed     = $6,
         last_checked_at  = NOW(),
         last_price       = $7`,
      [row.symbol, row.entry_price, row.stop_price, row.target_price,
       row.stop_moved_to_be ?? false, row.stop_trailed ?? false, row.last_price]
    );
  } catch (err) {
    console.error('upsertPositionMonitoring error:', err.message);
  }
}

export async function getPositionMonitoring(symbol) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(`SELECT * FROM position_monitoring WHERE symbol = $1`, [symbol]);
    return rows[0] ?? null;
  } catch (err) { return null; }
}

export async function getAllPositionMonitoring() {
  if (!dbAvailable) return [];
  try {
    const { rows } = await query(`SELECT * FROM position_monitoring`);
    return rows;
  } catch (err) { return []; }
}

export async function deletePositionMonitoring(symbol) {
  if (!dbAvailable) return;
  try {
    await query(`DELETE FROM position_monitoring WHERE symbol = $1`, [symbol]);
  } catch (err) { console.error('deletePositionMonitoring error:', err.message); }
}

// ─── Trade Lessons ────────────────────────────────────────────────────────────

export async function saveLesson({ date, symbol, outcome, pnl_usd, regime, vix, lesson_type, lesson, ai_source, username }) {
  if (!isDbAvailable()) return;
  try {
    await query(
      `INSERT INTO trade_lessons
         (date, symbol, outcome, pnl_usd, regime, vix, lesson_type, lesson, ai_source, username)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [date, symbol, outcome, pnl_usd, regime, vix, lesson_type, lesson, ai_source ?? 'unknown', username ?? null]
    );
  } catch (e) { console.error('saveLesson error:', e.message); }
}

export async function getRecentLessons({ limit = 15, username } = {}) {
  if (!isDbAvailable()) return [];
  try {
    const where  = username ? 'WHERE username = $2' : '';
    const params = username ? [limit, username]     : [limit];
    const { rows } = await query(
      `SELECT date, symbol, outcome, pnl_usd, regime, lesson_type, lesson, ai_source
       FROM trade_lessons ${where} ORDER BY created_at DESC LIMIT $1`,
      params
    );
    return rows;
  } catch { return []; }
}

export async function upsertPerformancePattern({ regime, vix_bucket, trades, wins, total_pnl, username }) {
  if (!isDbAvailable()) return;
  const win_rate = trades > 0 ? +((wins / trades) * 100).toFixed(1) : 0;
  const avg_pnl  = trades > 0 ? +(total_pnl / trades).toFixed(2)   : 0;
  const uname    = username ?? 'system';
  try {
    await query(
      `INSERT INTO performance_patterns (username, regime, vix_bucket, trades, wins, total_pnl, win_rate, avg_pnl)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (username, regime, vix_bucket) DO UPDATE
       SET trades=$4, wins=$5, total_pnl=$6, win_rate=$7, avg_pnl=$8, updated_at=NOW()`,
      [uname, regime, vix_bucket, trades, wins, total_pnl, win_rate, avg_pnl]
    );
  } catch (e) { console.error('upsertPerformancePattern error:', e.message); }
}

export async function getPerformancePatterns({ username } = {}) {
  if (!isDbAvailable()) return [];
  try {
    const where  = username ? `WHERE username = $1` : `WHERE username = 'system'`;
    const params = username ? [username]             : [];
    const { rows } = await query(
      `SELECT regime, vix_bucket, trades, wins, win_rate, avg_pnl
       FROM performance_patterns ${where} AND trades >= 3
       ORDER BY win_rate DESC`,
      params
    );
    return rows;
  } catch { return []; }
}

export async function saveKnowledgeChunk({ topic, category, title, content, embedding, source = 'built-in' }) {
  await query(
    `INSERT INTO knowledge_chunks (topic, category, title, content, embedding, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [topic, category, title, content, JSON.stringify(embedding), source]
  );
}

export async function searchKnowledge({ embedding, limit = 4 }) {
  // Fetch all chunks with stored embeddings and rank by cosine similarity in JS
  // (pgvector extension not required — embedding stored as JSON text)
  const { rows } = await query(
    `SELECT title, content, category, embedding FROM knowledge_chunks WHERE embedding IS NOT NULL`
  );
  if (!rows.length) return [];

  const dot   = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const norm  = (a)    => Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const qNorm = norm(embedding);

  return rows
    .map(r => {
      try {
        const e   = JSON.parse(r.embedding);
        const sim = dot(embedding, e) / (qNorm * norm(e));
        return { title: r.title, content: r.content, category: r.category, similarity: sim };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

export async function countKnowledgeChunks() {
  const { rows } = await query(`SELECT COUNT(*) AS total FROM knowledge_chunks`);
  return parseInt(rows[0]?.total ?? 0);
}

export async function countKnowledgeChunksByTopic(category) {
  const { rows } = await query(`SELECT COUNT(*) AS total FROM knowledge_chunks WHERE category = $1`, [category]);
  return parseInt(rows[0]?.total ?? 0);
}

// ─── Stock Predictions ────────────────────────────────────────────────────────

export async function upsertPrediction(row) {
  if (!isDbAvailable()) return;
  await query(
    `INSERT INTO stock_predictions
       (symbol, week_start, target_date, predicted_price, predicted_change_pct,
        base_price, algorithm_signal, slope_per_day, r_squared, has_earnings, earnings_date,
        adjusted_change_pct, confidence, uw_modifier_delta, uw_modifier_reason, uw_modifier_label,
        news_modifier_delta, news_modifier_reason, news_modifier_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (symbol, week_start, target_date) DO UPDATE SET
       predicted_price      = EXCLUDED.predicted_price,
       predicted_change_pct = EXCLUDED.predicted_change_pct,
       base_price           = EXCLUDED.base_price,
       algorithm_signal     = EXCLUDED.algorithm_signal,
       slope_per_day        = EXCLUDED.slope_per_day,
       r_squared            = EXCLUDED.r_squared,
       has_earnings         = EXCLUDED.has_earnings,
       earnings_date        = EXCLUDED.earnings_date,
       adjusted_change_pct  = EXCLUDED.adjusted_change_pct,
       confidence           = EXCLUDED.confidence,
       uw_modifier_delta    = EXCLUDED.uw_modifier_delta,
       uw_modifier_reason   = EXCLUDED.uw_modifier_reason,
       uw_modifier_label    = EXCLUDED.uw_modifier_label,
       news_modifier_delta  = EXCLUDED.news_modifier_delta,
       news_modifier_reason = EXCLUDED.news_modifier_reason,
       news_modifier_label  = EXCLUDED.news_modifier_label,
       updated_at           = NOW()`,
    [row.symbol, row.week_start, row.target_date, row.predicted_price,
     row.predicted_change_pct, row.base_price, row.algorithm_signal,
     row.slope_per_day, row.r_squared, row.has_earnings, row.earnings_date ?? null,
     row.adjusted_change_pct ?? null, row.confidence ?? null,
     row.uw_modifier_delta ?? null, row.uw_modifier_reason ?? null, row.uw_modifier_label ?? null,
     row.news_modifier_delta ?? null, row.news_modifier_reason ?? null, row.news_modifier_label ?? null]
  );
}

export async function fillActualPrice(symbol, targetDate, actualPrice, basePriceOverride) {
  if (!isDbAvailable()) return;
  const { rows } = await query(
    `SELECT base_price, predicted_price FROM stock_predictions WHERE symbol=$1 AND target_date=$2`,
    [symbol, targetDate]
  );
  if (!rows.length) return;
  const base      = basePriceOverride ?? rows[0].base_price;
  const predicted = rows[0].predicted_price;
  const actualChangePct  = base  ? +((actualPrice - base)      / base * 100).toFixed(4)      : null;
  const errorPct         = predicted ? +((actualPrice - predicted) / predicted * 100).toFixed(4) : null;
  await query(
    `UPDATE stock_predictions
     SET actual_price=\$3, actual_change_pct=\$4, error_pct=\$5, updated_at=NOW()
     WHERE symbol=\$1 AND target_date=\$2`,
    [symbol, targetDate, actualPrice, actualChangePct, errorPct]
  );
}

export async function getPredictionsForWeek(weekStart) {
  if (!isDbAvailable()) return [];
  const { rows } = await query(
    `SELECT * FROM stock_predictions WHERE week_start=$1 ORDER BY symbol, target_date`,
    [weekStart]
  );
  return rows;
}

export async function getPredictionHistory({ limit = 8 } = {}) {
  if (!isDbAvailable()) return [];
  const { rows } = await query(
    `SELECT week_start,
            COUNT(*) FILTER (WHERE actual_price IS NOT NULL) AS filled,
            COUNT(*) AS total,
            AVG(ABS(error_pct)) FILTER (WHERE error_pct IS NOT NULL) AS avg_abs_error,
            COUNT(*) FILTER (WHERE error_pct IS NOT NULL AND ABS(error_pct) < 2) AS within_2pct,
            COUNT(*) FILTER (WHERE error_pct IS NOT NULL AND
              ((predicted_change_pct > 0 AND actual_change_pct > 0) OR
               (predicted_change_pct < 0 AND actual_change_pct < 0))) AS direction_correct
     FROM stock_predictions
     GROUP BY week_start
     ORDER BY week_start DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

// ─── Account Daily Snapshots (Moomoo / Tiger daily P&L history) ──────────────

export async function upsertAccountSnapshot({ date, source, username, portfolio_value, realized_pl, unrealized_pl }) {
  if (!isDbAvailable()) return;
  try {
    await query(
      `INSERT INTO account_daily_snapshots (date, source, username, portfolio_value, realized_pl, unrealized_pl, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (date, source, username) DO UPDATE SET
         portfolio_value = EXCLUDED.portfolio_value,
         realized_pl     = EXCLUDED.realized_pl,
         unrealized_pl   = EXCLUDED.unrealized_pl,
         updated_at      = NOW()`,
      [date, source, username, portfolio_value ?? null, realized_pl ?? null, unrealized_pl ?? null]
    );
  } catch (err) {
    console.error('upsertAccountSnapshot error:', err.message);
  }
}

export async function getAccountSnapshots({ source, username, days = 30 } = {}) {
  if (!isDbAvailable()) return [];
  try {
    const { rows } = await query(
      `SELECT date, portfolio_value, realized_pl, unrealized_pl
       FROM account_daily_snapshots
       WHERE source = $1 AND username = $2
         AND date >= CURRENT_DATE - ($3 || ' days')::INTERVAL
       ORDER BY date ASC`,
      [source, username, days]
    );
    return rows;
  } catch (err) {
    console.error('getAccountSnapshots error:', err.message);
    return [];
  }
}

// ─── User Watchlist ───────────────────────────────────────────────────────────

export async function getUserWatchlistSymbols(username) {
  if (!isDbAvailable()) return [];
  try {
    const { rows } = await query(
      `SELECT symbol FROM user_watchlist WHERE username = $1 ORDER BY added_at ASC`,
      [username]
    );
    return rows.map(r => r.symbol);
  } catch (err) {
    console.error('getUserWatchlistSymbols error:', err.message);
    return [];
  }
}

export async function addUserWatchlistSymbol(username, symbol) {
  if (!isDbAvailable()) return;
  try {
    await query(
      `INSERT INTO user_watchlist (username, symbol) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [username, symbol.toUpperCase()]
    );
  } catch (err) {
    console.error('addUserWatchlistSymbol error:', err.message);
  }
}

export async function removeUserWatchlistSymbol(username, symbol) {
  if (!isDbAvailable()) return;
  try {
    await query(
      `DELETE FROM user_watchlist WHERE username = $1 AND symbol = $2`,
      [username, symbol.toUpperCase()]
    );
  } catch (err) {
    console.error('removeUserWatchlistSymbol error:', err.message);
  }
}

// All distinct watchlist symbols across every user — used to guarantee scanner coverage
export async function getAllWatchlistSymbols() {
  if (!isDbAvailable()) return [];
  try {
    const { rows } = await query(`SELECT DISTINCT symbol FROM user_watchlist ORDER BY symbol`);
    return rows.map(r => r.symbol);
  } catch (err) {
    console.error('getAllWatchlistSymbols error:', err.message);
    return [];
  }
}

// ─── Agent Error Log ──────────────────────────────────────────────────────────

export async function logClientError({ source = 'browser', level = 'error', message, stack, url, context }) {
  if (!isDbAvailable()) return;
  try {
    await query(
      `INSERT INTO agent_error_log (source, level, message, stack, url, context)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [source, level, message?.slice(0, 2000), stack?.slice(0, 5000), url?.slice(0, 500), context ? JSON.stringify(context) : null]
    );
  } catch (err) {
    console.error('logClientError error:', err.message);
  }
}

export async function logServerError({ source = 'server', level = 'error', message, stack, context, auto_action }) {
  if (!isDbAvailable()) return;
  try {
    await query(
      `INSERT INTO agent_error_log (source, level, message, stack, context, auto_action)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [source, level, message?.slice(0, 2000), stack?.slice(0, 5000), context ? JSON.stringify(context) : null, auto_action?.slice(0, 100)]
    );
  } catch (err) {
    console.error('logServerError error:', err.message);
  }
}

export async function getErrorLog({ limit = 50, source, resolved } = {}) {
  if (!isDbAvailable()) return [];
  try {
    const conditions = [];
    const params = [];
    if (source) { conditions.push(`source = $${params.length + 1}`); params.push(source); }
    if (resolved !== undefined) { conditions.push(`resolved = $${params.length + 1}`); params.push(resolved); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const rows = await query(
      `SELECT id, source, level, message, stack, url, context, auto_action, resolved, created_at
       FROM agent_error_log ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return rows.rows;
  } catch (err) {
    console.error('getErrorLog error:', err.message);
    return [];
  }
}

export async function resolveError(id) {
  if (!isDbAvailable()) return;
  try {
    await query(`UPDATE agent_error_log SET resolved = TRUE WHERE id = $1`, [id]);
  } catch (err) {
    console.error('resolveError error:', err.message);
  }
}


// ─── Sentinel helpers ─────────────────────────────────────────────────────────

export async function insertSentinelRun({ mode, as_of, risks_json, proposals_json, email_sent, error }) {
  if (!isDbAvailable()) return null;
  try {
    const { rows } = await query(
      `INSERT INTO sentinel_runs (mode, as_of, risks_json, proposals_json, email_sent, error)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [mode, as_of, JSON.stringify(risks_json ?? []), JSON.stringify(proposals_json ?? []), email_sent ?? false, error ?? null]
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error('insertSentinelRun error:', err.message);
    return null;
  }
}

export async function insertPendingAction({ symbol, broker, side, qty, limit_price, stop_price, reason, severity, signed_token, expires_at }) {
  if (!isDbAvailable()) return null;
  try {
    const { rows } = await query(
      `INSERT INTO pending_actions (symbol, broker, side, qty, limit_price, stop_price, reason, severity, signed_token, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [symbol, broker ?? 'alpaca', side, qty, limit_price ?? null, stop_price ?? null, reason ?? null, severity ?? null, signed_token, expires_at]
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    if (err.code === '23505') {
      console.log(`[sentinel] duplicate proposal suppressed for ${symbol}/${side}/${qty}`);
      return null;
    }
    console.error('insertPendingAction error:', err.message);
    return null;
  }
}

export async function getPendingAction(id) {
  if (!isDbAvailable()) return null;
  try {
    const { rows } = await query(`SELECT * FROM pending_actions WHERE id = $1`, [id]);
    return rows[0] ?? null;
  } catch (err) {
    console.error('getPendingAction error:', err.message);
    return null;
  }
}

export async function updatePendingAction(id, fields) {
  if (!isDbAvailable()) return;
  const keys   = Object.keys(fields);
  const values = Object.values(fields);
  const set    = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  try {
    await query(`UPDATE pending_actions SET ${set} WHERE id = $1`, [id, ...values]);
  } catch (err) {
    console.error('updatePendingAction error:', err.message);
  }
}

export async function getSentinelRecipients() {
  if (!isDbAvailable()) return [];
  try {
    const { rows } = await query(
      `SELECT username, email FROM users
       WHERE email IS NOT NULL AND email <> ''
         AND (suspended IS NULL OR suspended = false)
       ORDER BY username`
    );
    return rows; // [{ username, email }, ...]
  } catch (err) {
    console.error('getSentinelRecipients error:', err.message);
    return [];
  }
}

// ─── Bot helpers ──────────────────────────────────────────────────────────────

export async function listBots(userId, { includeArchived = false } = {}) {
  if (!isDbAvailable()) return [];
  try {
    const where = includeArchived
      ? 'WHERE user_id=$1'
      : 'WHERE user_id=$1 AND deleted_at IS NULL';
    const { rows } = await query(
      `SELECT * FROM bots ${where} ORDER BY created_at DESC`,
      [userId]
    );
    return rows;
  } catch (err) {
    logger.error('[db] listBots error:', err.message);
    return [];
  }
}

export async function softDeleteBot(botId, userId) {
  if (!isDbAvailable()) return;
  try {
    await query(
      `UPDATE bots SET deleted_at=NOW() WHERE id=$1 AND user_id=$2`,
      [botId, userId]
    );
  } catch (err) {
    logger.error('[db] softDeleteBot error:', err.message);
  }
}

export async function getBotKpis(userId) {
  if (!isDbAvailable()) return { total_pnl_usd: 0, total_trades: 0, winning_trades: 0, overall_wr: null, active_count: 0, archived_count: 0, best_bot: null, worst_bot: null };
  try {
  const [{ rows: totals }, { rows: counts }, { rows: bestRows }, { rows: worstRows }] =
    await Promise.all([
      query(`
        SELECT COALESCE(SUM(t.pnl_usd), 0)                              AS total_pnl_usd,
               COUNT(t.id)                                               AS total_trades,
               COUNT(t.id) FILTER (WHERE t.pnl_usd > 0)                 AS winning_trades
        FROM trades t
        JOIN bots b ON t.bot_id = b.id
        WHERE b.user_id = $1 AND t.status = 'closed'`, [userId]),
      query(`
        SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL)  AS active_count,
               COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS archived_count
        FROM bots WHERE user_id = $1`, [userId]),
      query(`
        SELECT id, name, cumulative_pnl_usd AS pnl
        FROM bots WHERE user_id=$1 AND deleted_at IS NULL
        ORDER BY cumulative_pnl_usd DESC LIMIT 1`, [userId]),
      query(`
        SELECT id, name, cumulative_pnl_usd AS pnl
        FROM bots WHERE user_id=$1 AND deleted_at IS NULL
        ORDER BY cumulative_pnl_usd ASC LIMIT 1`, [userId]),
    ]);
  const t = totals[0];
  const c = counts[0];
  const totalTrades   = Number(t.total_trades)   || 0;
  const winningTrades = Number(t.winning_trades) || 0;
  return {
    total_pnl_usd:  Number(t.total_pnl_usd) || 0,
    total_trades:   totalTrades,
    winning_trades: winningTrades,
    overall_wr:     totalTrades > 0 ? +(winningTrades / totalTrades * 100).toFixed(1) : null,
    active_count:   Number(c.active_count)   || 0,
    archived_count: Number(c.archived_count) || 0,
    best_bot:  bestRows[0]  ? { id: bestRows[0].id,  name: bestRows[0].name,  pnl: Number(bestRows[0].pnl)  } : null,
    worst_bot: worstRows[0] ? { id: worstRows[0].id, name: worstRows[0].name, pnl: Number(worstRows[0].pnl) } : null,
  };
  } catch (err) {
    console.error('[db] getBotKpis error:', err.message);
    return { total_pnl_usd: 0, total_trades: 0, winning_trades: 0, overall_wr: null, active_count: 0, archived_count: 0, best_bot: null, worst_bot: null };
  }
}

export async function getRecentBotDecisions(userId, limit = 20) {
  if (!isDbAvailable()) return [];
  try {
    const { rows } = await query(`
      SELECT bd.id AS decision_id, bd.bot_id, b.name AS bot_name,
             bd.scanned_at, bd.action, bd.symbol, bd.composite_score, bd.notes,
             bd.setup_type, bd.thesis
      FROM bot_decisions bd
      JOIN bots b ON b.id = bd.bot_id
      WHERE b.user_id = $1
      ORDER BY bd.scanned_at DESC
      LIMIT $2`, [userId, limit]);
    return rows;
  } catch (err) {
    console.error('[db] getRecentBotDecisions error:', err.message);
    return [];
  }
}

export async function getBotTrades(botId, userId, limit = 50) {
  if (!isDbAvailable()) return [];
  try {
    const { rows: botRows } = await query(
      'SELECT id FROM bots WHERE id=$1 AND user_id=$2',
      [botId, userId]
    );
    if (!botRows.length) return null;
    const { rows } = await query(`
      SELECT id, symbol, qty, entry_price, exit_price, pnl_usd,
             status, opened_at, closed_at, stop_loss,
             conviction_score, conviction_grade, account_source,
             setup_type, thesis, expected_hold_days_min, expected_hold_days_max
      FROM trades
      WHERE bot_id = $1
      ORDER BY opened_at DESC
      LIMIT $2`, [botId, limit]);
    return rows;
  } catch (err) {
    console.error('[db] getBotTrades error:', err.message);
    return [];
  }
}
