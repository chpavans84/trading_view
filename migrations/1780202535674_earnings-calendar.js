/**
 * Migration: earnings_calendar
 *
 * One row per symbol. Stores upcoming + most-recent earnings dates, fetched
 * from Yahoo Finance quoteSummary { calendarEvents, earningsHistory }.
 *
 * Distinct from `fundamentals` table:
 *   - fundamentals = historical filings (revenue, EPS, net income per quarter)
 *   - earnings_calendar = forward-looking dates + last-reported summary
 *
 * Refreshed weekly by a cron (TBD). Daily for any symbol within 14 days of
 * its next earnings date.
 *
 * Use cases:
 *   - mover_signals.had_earnings_in_window now covers all 12K symbols (was 351)
 *   - Bot avoids opening positions <2 days before earnings (catastrophic gap risk)
 *   - Pre-earnings IV-crush trades on liquid names
 *   - "Earnings season" context for sector rotation analytics
 */

/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('earnings_calendar', {
    symbol:           { type: 'varchar(20)', notNull: true, primaryKey: true },
    next_earnings:    { type: 'date' },                      // upcoming announce date
    next_call_time:   { type: 'varchar(10)' },                // 'BMO' | 'AMC' | 'TAS' | null
    last_earnings:    { type: 'date' },                      // most recent past announce date
    last_eps_actual:  { type: 'numeric(12,4)' },
    last_eps_estimate:{ type: 'numeric(12,4)' },
    last_surprise_pct:{ type: 'numeric(8,2)' },               // (actual - estimate) / |estimate| * 100
    earnings_avg_est: { type: 'numeric(12,4)' },              // upcoming estimate
    revenue_avg_est:  { type: 'bigint' },                     // upcoming estimate
    ex_dividend_date: { type: 'date' },                       // bonus from same calendarEvents call
    dividend_date:    { type: 'date' },
    source:           { type: 'varchar(20)', default: 'yahoo' },
    fetched_at:       { type: 'timestamptz', default: pgm.func('NOW()') },
    fetch_status:     { type: 'varchar(20)' },                // 'ok' | 'no_data' | 'error'
    fetch_error:      { type: 'text' },
  });

  pgm.createIndex('earnings_calendar', ['next_earnings'],  { name: 'idx_earn_cal_next' });
  pgm.createIndex('earnings_calendar', ['last_earnings'],  { name: 'idx_earn_cal_last' });
  pgm.createIndex('earnings_calendar', ['fetched_at'],     { name: 'idx_earn_cal_fetched' });
};

export const down = (pgm) => {
  pgm.dropTable('earnings_calendar');
};
