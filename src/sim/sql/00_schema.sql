-- ============================================================================
-- BOT_SIM database isolation — schema `sim` + restricted role `sim_runner`.
--
-- Triple-locked production safety (2026-06-13):
--   1. Separate schema      → sim.* namespace, never collides with public.*
--   2. Restricted role      → sim_runner has SELECT-only on public, ALL on sim,
--                             so an accidental production write is rejected by
--                             Postgres itself, not by our code being correct.
--   3. Lake reads           → minute bars / features come from parquet (no write
--                             path at all); only sim.* and read-only public
--                             reference tables are touched.
--
-- Run as the DB owner (pavan). :sim_pw is passed via psql -v.
-- Reset everything between iterations:  DROP SCHEMA sim CASCADE;
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS sim;

-- ── restricted role ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sim_runner') THEN
    CREATE ROLE sim_runner LOGIN PASSWORD :'sim_pw';
  ELSE
    ALTER ROLE sim_runner PASSWORD :'sim_pw';
  END IF;
END $$;

-- public = read-only reference/historical data (uw_flow_alerts, benzinga_news, …)
GRANT USAGE ON SCHEMA public TO sim_runner;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sim_runner;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO sim_runner;
-- NB: deliberately NO insert/update/delete on public.

-- sim = full read/write
GRANT ALL ON SCHEMA sim TO sim_runner;
GRANT ALL ON ALL TABLES IN SCHEMA sim TO sim_runner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA sim TO sim_runner;
ALTER DEFAULT PRIVILEGES IN SCHEMA sim GRANT ALL ON TABLES TO sim_runner;
ALTER DEFAULT PRIVILEGES IN SCHEMA sim GRANT ALL ON SEQUENCES TO sim_runner;

-- bare table names resolve to sim first (writes), public second (reference reads)
ALTER ROLE sim_runner SET search_path = sim, public;

-- ── replay data tables (populated by owner ETL, read-only to the engine) ────
CREATE TABLE IF NOT EXISTS sim.universe (
  symbol      text PRIMARY KEY,
  in_sp500    boolean DEFAULT false,
  in_ndx100   boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS sim.minute_bars (
  symbol  text NOT NULL,
  ts      timestamptz NOT NULL,          -- bar START, US/Eastern semantics (UTC stored)
  open    double precision,
  high    double precision,
  low     double precision,
  close   double precision,
  volume  double precision,
  PRIMARY KEY (symbol, ts)
);
CREATE INDEX IF NOT EXISTS idx_sim_minute_ts ON sim.minute_bars (ts);

-- daily features as-of each session CLOSE (consumed only for d < sim-clock date)
CREATE TABLE IF NOT EXISTS sim.daily_features (
  symbol        text NOT NULL,
  d             date NOT NULL,
  close         double precision,
  ret_5d        double precision,
  rvol          double precision,
  dist_sma50    double precision,
  dist_sma200   double precision,
  dist_52whigh  double precision,
  rs_spy_20     double precision,
  adv20         double precision,
  dist_20dhigh  double precision,   -- close/prior-20d-high − 1 (>0 = 20-day breakout). Used by the `breakout` strategy.
  PRIMARY KEY (symbol, d)
);

CREATE TABLE IF NOT EXISTS sim.regime (
  d         date PRIMARY KEY,
  spy_close double precision,
  sma200    double precision,
  rvol20    double precision,
  regime    text                         -- R1_up_calm | R2_up_vol | R3_down_calm | R4_down_vol
);

-- point-in-time event streams (known_at = when the bot could first have seen it)
CREATE TABLE IF NOT EXISTS sim.events_uw (
  ticker     text NOT NULL,
  known_at   timestamptz NOT NULL,
  bull_prem  double precision DEFAULT 0,
  bear_prem  double precision DEFAULT 0,
  premium    double precision DEFAULT 0,
  sentiment  text
);
CREATE INDEX IF NOT EXISTS idx_sim_uw ON sim.events_uw (ticker, known_at);

CREATE TABLE IF NOT EXISTS sim.events_news (
  symbol     text NOT NULL,
  known_at   timestamptz NOT NULL,
  title      text,
  sentiment  text
);
CREATE INDEX IF NOT EXISTS idx_sim_news ON sim.events_news (symbol, known_at);

-- ── engine output tables (written by sim_runner during the replay) ──────────
CREATE TABLE IF NOT EXISTS sim.runs (
  run_id      text PRIMARY KEY,
  started_at  timestamptz DEFAULT now(),
  finished_at timestamptz,
  window_from date,
  window_to   date,
  params      jsonb,
  status      text DEFAULT 'running',
  summary     jsonb
);

CREATE TABLE IF NOT EXISTS sim.decisions (
  id        bigserial PRIMARY KEY,
  run_id    text NOT NULL,
  ts        timestamptz NOT NULL,         -- sim-clock at decision
  symbol    text,
  action    text,                         -- would_buy | hold | skip
  setup     text,
  score     double precision,
  regime    text,
  reasons   jsonb,
  notes     text
);
CREATE INDEX IF NOT EXISTS idx_sim_dec_run ON sim.decisions (run_id, ts);

CREATE TABLE IF NOT EXISTS sim.trades (
  id            bigserial PRIMARY KEY,
  run_id        text NOT NULL,
  symbol        text NOT NULL,
  setup         text,
  regime        text,
  qty           double precision,
  entry_ts      timestamptz,
  entry_px      double precision,
  ref_px        double precision,         -- decision-time bar close (for honest slippage)
  slippage_bps  double precision,
  stop_px       double precision,
  exit_ts       timestamptz,
  exit_px       double precision,
  exit_reason   text,
  pnl           double precision,
  pnl_pct       double precision,
  hold_minutes  integer,
  status        text DEFAULT 'open',
  policy_version integer
);
CREATE INDEX IF NOT EXISTS idx_sim_trades_run ON sim.trades (run_id, entry_ts);

CREATE TABLE IF NOT EXISTS sim.policy (
  id            bigserial PRIMARY KEY,
  run_id        text NOT NULL,
  version       integer NOT NULL,
  effective_date date NOT NULL,
  params        jsonb NOT NULL,
  source        text,                     -- 'seed' | 'stats' | 'claude'
  rationale     text,
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sim_policy_run ON sim.policy (run_id, version);

CREATE TABLE IF NOT EXISTS sim.equity (
  run_id      text NOT NULL,
  ts          timestamptz NOT NULL,
  cash        double precision,
  positions_value double precision,
  equity      double precision,
  PRIMARY KEY (run_id, ts)
);

CREATE TABLE IF NOT EXISTS sim.lessons (
  id              bigserial PRIMARY KEY,
  run_id          text NOT NULL,
  sim_date        date NOT NULL,
  closed_n        integer,
  claude_proposal jsonb,
  stats_verdict   jsonb,
  adopted         boolean,
  narrative       text,
  created_at      timestamptz DEFAULT now()
);

-- re-grant for the tables just created (idempotent)
GRANT ALL ON ALL TABLES IN SCHEMA sim TO sim_runner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA sim TO sim_runner;
