/**
 * Migration: sector_rotation
 *
 * Daily sector strength + rotation analytics computed from SPDR sector ETFs
 * (XLK/XLF/XLV/XLY/XLE/XLP/XLI/XLU/XLB/XLC/XLRE) + broad market (SPY/QQQ/IWM/DIA).
 *
 * For each (price_date, sector_etf), stores:
 *   - chg_1d / chg_5d / chg_20d                — period returns
 *   - rank_1d / rank_5d / rank_20d              — 1=strongest, 11=weakest among sectors
 *   - rel_vs_spy_1d / rel_vs_spy_5d              — sector outperformance vs market
 *   - mom_score                        — momentum acceleration (1d − 20d, positive = recent strength)
 *
 * Use cases:
 *   - "What sectors are leading today?" → query latest rank_1d
 *   - "Which sectors are accelerating?" → mom_score desc
 *   - "Is XYZ stock benefiting from its sector?" → join on sector ETF rank
 *   - Feature input for the forward-prediction model
 *
 * Built fresh daily (one row per date × 11 sector ETFs + 4 broad = 15 rows/day).
 * Tiny table: 252 days × 15 = ~3,780 rows/year. No partitioning needed.
 */

/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('sector_rotation', {
    price_date:   { type: 'date',        notNull: true },
    etf_symbol:   { type: 'varchar(10)', notNull: true },
    sector_label: { type: 'varchar(40)' },                     // 'Technology' for XLK, 'Market' for SPY, etc.
    close:        { type: 'numeric(12,4)' },
    chg_1d:       { type: 'numeric(8,2)' },                    // % change vs prior close
    chg_5d:       { type: 'numeric(8,2)' },                    // % over 5 trading days
    chg_20d:      { type: 'numeric(8,2)' },                    // % over 20 trading days
    rank_1d:      { type: 'smallint' },                        // 1=top, n=bottom among sectors only (excludes broad)
    rank_5d:      { type: 'smallint' },
    rank_20d:     { type: 'smallint' },
    rel_vs_spy_1d:{ type: 'numeric(8,2)' },                    // chg_1d - SPY.chg_1d (positive = outperforming)
    rel_vs_spy_5d:{ type: 'numeric(8,2)' },
    mom_score:    { type: 'numeric(8,2)' },                    // chg_1d - chg_20d (positive = momentum accelerating)
    is_sector:    { type: 'boolean', default: true },          // false for broad-market ETFs
    computed_at:  { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.addConstraint('sector_rotation', 'sector_rotation_pkey', {
    primaryKey: ['price_date', 'etf_symbol'],
  });

  pgm.createIndex('sector_rotation', ['price_date'], { name: 'idx_sector_rot_date' });
  pgm.createIndex('sector_rotation', ['etf_symbol'], { name: 'idx_sector_rot_etf' });
};

export const down = (pgm) => {
  pgm.dropTable('sector_rotation');
};
