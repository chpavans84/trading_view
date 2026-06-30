/* Ownership snapshot for the screener tab: daily float + institutional holdings (from Yahoo).
   Daily snapshots enable the "change" columns. Idempotent (table may already exist from psql). */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS screener_ownership (
      symbol               varchar(20) NOT NULL,
      snapshot_date        date        NOT NULL,
      float_shares         bigint,
      shares_outstanding   bigint,
      inst_pct             numeric(7,4),
      inst_float_pct       numeric(7,4),
      inst_shares          bigint,
      insiders_pct         numeric(7,4),
      fetched_at           timestamptz DEFAULT now(),
      PRIMARY KEY (symbol, snapshot_date)
    );
    CREATE INDEX IF NOT EXISTS idx_screener_ownership_date ON screener_ownership(snapshot_date);
  `);
};

export const down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS screener_ownership;`);
};
