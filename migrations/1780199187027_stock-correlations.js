/**
 * Migration: stock_correlations
 *
 * Pairwise daily-return Pearson correlations between liquid symbols.
 * Computed from full_day_chg_pct in daily_intraday_features.
 *
 * Stored only where ABS(correlation) >= 0.30 (cuts the 500K-pair fan-out
 * down to a useful ~50-100K rows of meaningful relationships).
 *
 * Symmetric pair storage: (A, B) stored exactly once with symbol_a < symbol_b
 * to avoid 2× row count. Application queries should handle both directions.
 *
 * Lookback windows:
 *   - corr_30d  — short-term regime / pairs trading
 *   - corr_90d  — medium-term sector / theme grouping
 *   - corr_252d — long-term structural (full year)
 *
 * Use cases:
 *   - "What other stocks move with NVDA?" → SELECT ... WHERE symbol_a='NVDA' OR symbol_b='NVDA' ORDER BY corr DESC
 *   - "Avoid concentration" → flag positions with corr > 0.7 to existing holdings
 *   - "Sector confirmation" → if buying XYZ and 5 correlated stocks are also up, signal strength higher
 *   - Feeds into Neo4j as :CORRELATES_WITH edges
 */

/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('stock_correlations', {
    symbol_a:   { type: 'varchar(20)', notNull: true },
    symbol_b:   { type: 'varchar(20)', notNull: true },
    corr_30d:   { type: 'numeric(6,4)' },   // Pearson on full_day_chg_pct, 30d lookback
    corr_90d:   { type: 'numeric(6,4)' },
    corr_252d:  { type: 'numeric(6,4)' },
    obs_30d:    { type: 'integer' },         // # of paired observations
    obs_90d:    { type: 'integer' },
    obs_252d:   { type: 'integer' },
    computed_at:{ type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.addConstraint('stock_correlations', 'stock_correlations_pkey', {
    primaryKey: ['symbol_a', 'symbol_b'],
  });

  pgm.createIndex('stock_correlations', ['symbol_a'], { name: 'idx_corr_sym_a' });
  pgm.createIndex('stock_correlations', ['symbol_b'], { name: 'idx_corr_sym_b' });
  pgm.createIndex('stock_correlations', ['corr_90d'], { name: 'idx_corr_90d'   });
};

export const down = (pgm) => {
  pgm.dropTable('stock_correlations');
};
