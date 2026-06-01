-- src/regime-bot/migrations/002_regime_snapshots.sql
-- Market-wide regime snapshot table for the regime detector.
-- Observational only — does NOT change bot behavior.
--
-- Apply once:
--   psql "$DATABASE_URL" -f src/regime-bot/migrations/002_regime_snapshots.sql
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS regime_snapshots (
  id               BIGSERIAL PRIMARY KEY,
  snapshot_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  regime           VARCHAR(20) NOT NULL,  -- risk_on, neutral, risk_off, vol_spike
  strength         NUMERIC(5,2),          -- 0-100 confidence
  spy_slope_50d    NUMERIC(8,4),          -- % per day over last 50 days
  spy_pct_from_50d NUMERIC(8,4),          -- SPY % above/below 50d MA
  vix_proxy        NUMERIC(8,4),          -- 5-day realized vol of SPY (annualized, as VIX proxy)
  vix_5d_change    NUMERIC(8,4),          -- 5d change in vix_proxy
  sector_leaders   TEXT[],                -- top 3 sector ETFs by 5d RS vs SPY
  sector_laggers   TEXT[],                -- bottom 3 sector ETFs by 5d RS vs SPY
  notes            TEXT
);

CREATE INDEX IF NOT EXISTS idx_regime_snapshots_at ON regime_snapshots(snapshot_at DESC);
