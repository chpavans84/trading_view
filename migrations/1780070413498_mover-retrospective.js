/**
 * Migration: mover_retrospective + mover_signals
 *
 * Two tables to power the "daily movers retrospective" — for every stock that
 * moved ±3% on a given trading day, store the move + everything we know about
 * WHY it moved (news, UW options flow, insider buys, congressional trades,
 * earnings, bot conviction score), and whether our bot would have picked it.
 *
 * Designed for 1 year of history (~175K rows in mover_retrospective).
 * Signal coverage degrades for older dates per signal-source depth:
 *   - news (Benzinga):       last 10 days only
 *   - uw_flow:               last 10 days only
 *   - uw_insider:            last 28 months
 *   - uw_congress:           last 5 months
 *   - bot conviction_scores: last 36 days
 *   - earnings (fundamentals): 10 yrs but only ~351 symbols
 * The `signal_coverage_window` column records which tier applies per row so
 * downstream UI / queries can colour-code "we don't have data" vs "no signal".
 */

/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

export const up = (pgm) => {
  // ─── mover_retrospective — spine table (one row per UP/DOWN ±3% mover per date)
  pgm.createTable('mover_retrospective', {
    id:                  { type: 'bigserial',   primaryKey: true },
    price_date:          { type: 'date',        notNull: true },
    symbol:              { type: 'varchar(20)', notNull: true },
    direction:           { type: 'varchar(4)',  notNull: true },   // 'UP' or 'DOWN'
    prev_close:          { type: 'numeric(12,4)' },
    close:               { type: 'numeric(12,4)' },
    chg_pct:             { type: 'numeric(8,2)' },
    chg_pct_extended:    { type: 'numeric(8,2)' },                  // pre/post (last 10d only)
    volume:              { type: 'bigint' },
    volume_vs_30d_avg:   { type: 'numeric(8,2)' },                  // 5.0 = 5x normal
    sector:              { type: 'varchar(60)' },
    sector_etf_move_pct: { type: 'numeric(8,2)' },                  // SPDR XL* move that day
    market_cap_band:     { type: 'varchar(10)' },                   // mega/large/mid/small/micro
    created_at:          { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.addConstraint('mover_retrospective', 'mover_retro_unique', {
    unique: ['price_date', 'symbol', 'direction'],
  });

  pgm.createIndex('mover_retrospective', ['price_date'], { name: 'idx_mover_date_desc' });
  pgm.createIndex('mover_retrospective', ['symbol'],     { name: 'idx_mover_symbol'   });
  pgm.createIndex('mover_retrospective', ['direction', 'price_date'], { name: 'idx_mover_dir_date' });
  pgm.createIndex('mover_retrospective', ['chg_pct'],    { name: 'idx_mover_chgpct'   });

  // ─── mover_signals — one row per mover with all signal context joined
  pgm.createTable('mover_signals', {
    mover_id: {
      type: 'bigint',
      notNull: true,
      primaryKey: true,
      references: '"mover_retrospective"(id)',
      onDelete: 'CASCADE',
    },

    // Earnings
    had_earnings_in_window: { type: 'boolean' },
    earnings_date:          { type: 'date'    },

    // News (Benzinga, only meaningful last 10 days)
    news_count_24h:  { type: 'integer' },
    news_sentiment:  { type: 'varchar(20)' },
    news_categories: { type: 'text[]' },
    top_headline:    { type: 'text' },

    // UW options flow (last 10 days)
    uw_flow_premium_24h: { type: 'numeric(14,2)' },
    uw_flow_sentiment:   { type: 'varchar(20)' },
    uw_flow_largest:     { type: 'numeric(14,2)' },

    // UW insider (last 28 months — broad coverage)
    insider_buys_30d_value:  { type: 'numeric(14,2)' },
    insider_sells_30d_value: { type: 'numeric(14,2)' },
    insider_net_signal:      { type: 'varchar(20)' },   // 'buying' | 'selling' | null

    // UW congress (last 5 months)
    congress_activity_30d: { type: 'boolean' },
    congress_details:      { type: 'jsonb' },

    // Bot signal (only meaningful last 36 days)
    bot_conviction_score: { type: 'integer' },
    bot_grade:            { type: 'varchar(5)' },
    bot_action:           { type: 'varchar(20)' },     // BUY | NEAR | BLOCKED | WATCH
    bot_in_daily_picks:   { type: 'boolean' },

    // Verdict (computed during backfill)
    primary_signal:         { type: 'varchar(20)' },    // earnings | news_ma | uw_flow | insider | congress | sector | unknown
    signal_coverage_window: { type: 'varchar(20)' },    // full | partial | sparse
    caught_by_bot:          { type: 'boolean' },        // bot_action='BUY' AND scored before move
  });

  pgm.createIndex('mover_signals', ['primary_signal'], { name: 'idx_mover_sig_primary' });
  pgm.createIndex('mover_signals', ['caught_by_bot'],  { name: 'idx_mover_sig_caught'  });
  pgm.createIndex('mover_signals', ['signal_coverage_window'], { name: 'idx_mover_sig_window' });
};

export const down = (pgm) => {
  pgm.dropTable('mover_signals');
  pgm.dropTable('mover_retrospective');
};
