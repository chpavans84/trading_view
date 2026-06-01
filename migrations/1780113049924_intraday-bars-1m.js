/**
 * Migration: intraday_bars_1m
 *
 * Full-universe minute-aggregate OHLCV bars. Sourced from Polygon.io flat-files
 * (us_stocks_sip/minute_aggs_v1) which we already downloaded to disk at
 * ~/polygon-data/. The downloaded data covers 2017-now with ~11,700 distinct
 * symbols per trading day (vs. our existing `databento_ohlcv_1m` which only
 * has 115 symbols).
 *
 * Phase 1 ingestion target: last 365 days (~70 GB on disk in Postgres).
 * Phase 2 (TBD): COVID era 2020-2021, either with TimescaleDB compression or
 * aggregated to 5-min bars.
 *
 * Indexing strategy:
 *   - Primary key on (symbol, ts_event) covers the most common access pattern
 *     ("OHLCV for symbol X over date range Y").
 *   - BRIN on ts_event makes cross-symbol time-window scans cheap (~1 byte
 *     per row vs btree's ~20). BRIN is ideal for append-only time-series.
 *   - No separate symbol index — covered by primary key prefix.
 *
 * Schema differences vs databento_ohlcv_1m:
 *   - Adds `transactions` column (Polygon ships this, Databento doesn't)
 *   - `source` column tracks origin (polygon | databento | etc.) for future
 *     multi-source merging
 *   - Drops `instrument_id` (Databento-specific, not in Polygon)
 */

/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('intraday_bars_1m', {
    symbol:       { type: 'varchar(20)',  notNull: true },
    ts_event:     { type: 'timestamptz',  notNull: true },
    open:         { type: 'numeric(14,4)' },
    high:         { type: 'numeric(14,4)' },
    low:          { type: 'numeric(14,4)' },
    close:        { type: 'numeric(14,4)' },
    volume:       { type: 'bigint' },
    transactions: { type: 'integer' },                          // Polygon-only
    source:       { type: 'varchar(20)', default: 'polygon' },
    ingested_at:  { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.addConstraint('intraday_bars_1m', 'intraday_bars_1m_pkey', {
    primaryKey: ['symbol', 'ts_event'],
  });

  // BRIN index on time — extremely small, perfect for append-only time-series.
  // pages_per_range=32 gives good selectivity for ~minute-resolution data.
  pgm.sql(`
    CREATE INDEX idx_intraday_bars_ts_brin
      ON intraday_bars_1m USING BRIN (ts_event)
      WITH (pages_per_range = 32)
  `);
};

export const down = (pgm) => {
  pgm.dropTable('intraday_bars_1m');
};
