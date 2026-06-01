/**
 * Migration: daily_intraday_features
 *
 * One row per (symbol, price_date). Aggregates minute bars from
 * intraday_bars_1m into actionable daily features the bot/predictor uses.
 *
 * Sessions (ET, converted from UTC ts_event):
 *   - PRE-MARKET     04:00 - 09:29
 *   - REGULAR        09:30 - 16:00
 *   - POST-MARKET    16:00 - 20:00
 *   - OPENING RANGE  09:30 - 10:00 (first 30 min of regular session)
 *
 * Per-row features (see column comments):
 *   • Open/high/low/close + sessions
 *   • Opening range high/low — breakout setup detection
 *   • VWAP — institutional fair value
 *   • Price snapshots at 10/11/12/14/15:30 ET — intraday momentum curve
 *   • Volume profile: first 30 min vs full day
 *   • Pre/post-market change %
 *   • Intraday range, ATR proxy, RVOL
 *
 * Not a materialized view because we want a regular table for:
 *   (a) idempotent backfill (chunk by date)
 *   (b) cheap incremental daily update (one date at a time)
 *   (c) indexable for arbitrary queries
 *
 * Populated by scripts/build-daily-intraday-features.mjs.
 */

/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('daily_intraday_features', {
    symbol:         { type: 'varchar(20)', notNull: true },
    price_date:     { type: 'date',        notNull: true },

    // ── Session OHLC ──
    pre_open:       { type: 'numeric(14,4)' },   // first pre-market bar open (04:00-09:29 ET)
    pre_high:       { type: 'numeric(14,4)' },
    pre_low:        { type: 'numeric(14,4)' },
    pre_close:      { type: 'numeric(14,4)' },   // last bar before 09:30
    pre_volume:     { type: 'bigint' },

    reg_open:       { type: 'numeric(14,4)' },   // 09:30 first bar open
    reg_high:       { type: 'numeric(14,4)' },
    reg_low:        { type: 'numeric(14,4)' },
    reg_close:      { type: 'numeric(14,4)' },   // 16:00 last bar close
    reg_volume:     { type: 'bigint' },

    post_open:      { type: 'numeric(14,4)' },   // 16:00 first post bar
    post_high:      { type: 'numeric(14,4)' },
    post_low:       { type: 'numeric(14,4)' },
    post_close:     { type: 'numeric(14,4)' },   // 20:00 last bar
    post_volume:    { type: 'bigint' },

    // ── Opening range (first 30 min of regular session, 09:30-10:00) ──
    or_high:        { type: 'numeric(14,4)' },
    or_low:         { type: 'numeric(14,4)' },
    or_volume:      { type: 'bigint' },

    // ── VWAP (volume-weighted average price for regular session) ──
    vwap:           { type: 'numeric(14,4)' },

    // ── Intraday momentum snapshots (regular session, ET) ──
    px_10am:        { type: 'numeric(14,4)' },
    px_11am:        { type: 'numeric(14,4)' },
    px_12pm:        { type: 'numeric(14,4)' },
    px_2pm:         { type: 'numeric(14,4)' },
    px_330pm:       { type: 'numeric(14,4)' },

    // ── Derived metrics ──
    pre_change_pct:    { type: 'numeric(8,2)' },   // (reg_open - prev_reg_close) / prev_reg_close
    intraday_chg_pct:  { type: 'numeric(8,2)' },   // (reg_close - reg_open) / reg_open
    post_change_pct:   { type: 'numeric(8,2)' },   // (post_close - reg_close) / reg_close
    full_day_chg_pct:  { type: 'numeric(8,2)' },   // (reg_close - prev_reg_close) / prev_reg_close
    intraday_range_pct:{ type: 'numeric(8,2)' },   // (reg_high - reg_low) / reg_open
    or_range_pct:      { type: 'numeric(8,2)' },   // (or_high - or_low) / reg_open

    // ── Liquidity / activity ──
    total_volume:        { type: 'bigint' },
    total_transactions:  { type: 'integer' },
    avg_minute_volume:   { type: 'numeric(14,2)' },
    first_30min_pct_vol: { type: 'numeric(8,2)' }, // first 30 min vol / total day vol
    rvol_30d:            { type: 'numeric(8,2)' }, // total_volume / 30-day avg

    // ── Bookkeeping ──
    bar_count:    { type: 'integer' },             // how many 1-min bars contributed
    computed_at:  { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.addConstraint('daily_intraday_features', 'daily_intraday_features_pkey', {
    primaryKey: ['symbol', 'price_date'],
  });

  pgm.createIndex('daily_intraday_features', ['price_date'],            { name: 'idx_dif_date' });
  pgm.createIndex('daily_intraday_features', ['full_day_chg_pct'],      { name: 'idx_dif_chgpct' });
  pgm.createIndex('daily_intraday_features', ['rvol_30d'],              { name: 'idx_dif_rvol' });
};

export const down = (pgm) => {
  pgm.dropTable('daily_intraday_features');
};
