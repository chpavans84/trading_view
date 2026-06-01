-- Migration 003: relative_strength table (M4 — RS Scanner)
-- One row per symbol per calc_date. Computed daily after market close.
-- calc_date = the trading date for which RS was computed (usually today).

CREATE TABLE IF NOT EXISTS relative_strength (
  id              BIGSERIAL PRIMARY KEY,
  symbol          VARCHAR(20)  NOT NULL,
  calc_date       DATE         NOT NULL,
  return_5d       NUMERIC(10,4),   -- raw 5d return % for the stock
  return_20d      NUMERIC(10,4),   -- raw 20d return %
  rs_vs_spy_5d    NUMERIC(10,4),   -- stock 5d return minus SPY 5d return (pp)
  rs_vs_spy_20d   NUMERIC(10,4),   -- stock 20d return minus SPY 20d return (pp)
  rs_vs_sector_5d NUMERIC(10,4),   -- stock 5d return minus sector ETF 5d return (pp)
  sector_etf      VARCHAR(10),     -- e.g. 'XLK', 'XLV'
  rank_sector     INTEGER,         -- rank within sector (1 = strongest RS)
  rank_overall    INTEGER,         -- rank across all symbols with RS data (1 = strongest)
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rs_symbol_date
  ON relative_strength(symbol, calc_date);

CREATE INDEX IF NOT EXISTS idx_rs_calc_date
  ON relative_strength(calc_date DESC);

CREATE INDEX IF NOT EXISTS idx_rs_vs_spy
  ON relative_strength(calc_date DESC, rs_vs_spy_5d DESC);

CREATE INDEX IF NOT EXISTS idx_rs_sector_etf
  ON relative_strength(sector_etf, calc_date DESC, rs_vs_sector_5d DESC);
