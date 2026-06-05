/**
 * Migration: schema for the OLTP backfill ETLs (items #1-3 + #5-6 from coverage audit).
 *
 * Creates four new tables that hold the Polygon REST + FRED data we already
 * have on disk but never loaded into OLTP. After these tables exist, the
 * scripts under scripts/etl/* can populate them idempotently.
 *
 * Tables created:
 *   - polygon_financials        — quarterly income/BS/CF per symbol (Polygon authoritative)
 *   - corporate_actions         — splits + dividends per symbol (Polygon authoritative)
 *   - macro_data                — FRED Fed funds, CPI, etc.
 *   - vix_history               — Cboe/Yahoo VIX daily extending past Polygon's 2023+
 *
 * The existing `fundamentals` table is LEFT INTACT (Yahoo-derived) to avoid
 * breaking current bot code. New ML training set should prefer
 * polygon_financials. Yahoo `fundamentals` can be dropped later after migration.
 *
 * Reversible via `down`.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ─── 1. polygon_financials — quarterly income / balance / cash flow ──────
  pgm.createTable('polygon_financials', {
    id:                 'id',
    ticker:             { type: 'varchar(20)', notNull: true },
    fiscal_year:        { type: 'integer' },
    fiscal_period:      { type: 'varchar(4)' },   // Q1/Q2/Q3/Q4/FY
    timeframe:          { type: 'varchar(20)' },   // 'quarterly' | 'annual'
    start_date:         { type: 'date' },
    end_date:           { type: 'date', notNull: true },
    filing_date:        { type: 'date' },
    acceptance_datetime:{ type: 'timestamp with time zone' },
    cik:                { type: 'varchar(20)' },
    sic:                { type: 'varchar(10)' },
    company_name:       { type: 'text' },
    source_filing_url:  { type: 'text' },
    income_statement:   { type: 'jsonb' },         // raw Polygon nested object
    balance_sheet:      { type: 'jsonb' },
    cash_flow_statement:{ type: 'jsonb' },
    comprehensive_income:{ type: 'jsonb' },
    revenues:           { type: 'numeric(20,2)' },  // flattened convenience columns
    net_income:         { type: 'numeric(20,2)' },
    eps_diluted:        { type: 'numeric(12,4)' },
    total_assets:       { type: 'numeric(20,2)' },
    total_liabilities:  { type: 'numeric(20,2)' },
    cash_and_equiv:     { type: 'numeric(20,2)' },
    operating_cash_flow:{ type: 'numeric(20,2)' },
    raw:                { type: 'jsonb' },          // full original row for fidelity
    ingested_at:        { type: 'timestamp with time zone', default: pgm.func('NOW()') },
  });
  pgm.addConstraint('polygon_financials', 'polygon_financials_unique',
    { unique: ['ticker', 'fiscal_year', 'fiscal_period'] });
  pgm.createIndex('polygon_financials', 'ticker');
  pgm.createIndex('polygon_financials', 'end_date');

  // ─── 2. corporate_actions — splits + dividends ──────────────────────────
  pgm.createTable('corporate_actions', {
    id:               'id',
    ticker:           { type: 'varchar(20)', notNull: true },
    action_type:      { type: 'varchar(20)', notNull: true },  // 'split' | 'dividend'
    execution_date:   { type: 'date' },                         // splits: execution_date; divs: ex_dividend_date
    declaration_date: { type: 'date' },
    record_date:      { type: 'date' },
    pay_date:         { type: 'date' },
    // Split fields
    split_from:       { type: 'integer' },
    split_to:         { type: 'integer' },
    // Dividend fields
    cash_amount:      { type: 'numeric(14,6)' },
    currency:         { type: 'varchar(8)' },
    dividend_type:    { type: 'varchar(10)' },  // CD / SC / LT / etc.
    frequency:        { type: 'integer' },
    polygon_id:       { type: 'text' },         // Polygon's own ID for dedup
    raw:              { type: 'jsonb' },
    ingested_at:      { type: 'timestamp with time zone', default: pgm.func('NOW()') },
  });
  pgm.addConstraint('corporate_actions', 'corporate_actions_unique',
    { unique: ['polygon_id'] });
  pgm.createIndex('corporate_actions', 'ticker');
  pgm.createIndex('corporate_actions', 'execution_date');
  pgm.createIndex('corporate_actions', ['ticker', 'action_type', 'execution_date']);

  // ─── 3. macro_data — FRED + similar ─────────────────────────────────────
  pgm.createTable('macro_data', {
    id:           'id',
    series_id:    { type: 'varchar(40)', notNull: true },  // 'DFF', 'CPIAUCSL', 'UNRATE', 'GDP'
    series_name:  { type: 'text' },
    observation_date: { type: 'date', notNull: true },
    value:        { type: 'numeric(20,6)' },
    units:        { type: 'varchar(40)' },
    frequency:    { type: 'varchar(20)' },   // daily / monthly / quarterly
    source:       { type: 'varchar(20)', default: 'FRED' },
    ingested_at:  { type: 'timestamp with time zone', default: pgm.func('NOW()') },
  });
  pgm.addConstraint('macro_data', 'macro_data_unique', { unique: ['series_id', 'observation_date'] });
  pgm.createIndex('macro_data', 'observation_date');
  pgm.createIndex('macro_data', ['series_id', 'observation_date']);

  // ─── 4. vix_history — extends ^VIX past Polygon's 2023-04 start ─────────
  // Loaded from Yahoo (free) or Cboe DataShop. Mirrors backtest_prices schema
  // for trivial join. We could just write into backtest_prices with symbol='VIX'
  // but a dedicated table makes provenance + retention obvious.
  pgm.createTable('vix_history', {
    id:          'id',
    price_date:  { type: 'date', notNull: true },
    open:        { type: 'numeric(10,4)' },
    high:        { type: 'numeric(10,4)' },
    low:         { type: 'numeric(10,4)' },
    close:       { type: 'numeric(10,4)' },
    volume:      { type: 'bigint' },
    source:      { type: 'varchar(20)', default: 'yahoo' },  // 'yahoo' | 'cboe' | 'polygon'
    ingested_at: { type: 'timestamp with time zone', default: pgm.func('NOW()') },
  });
  pgm.addConstraint('vix_history', 'vix_history_unique', { unique: ['price_date'] });
  pgm.createIndex('vix_history', 'price_date');
};

exports.down = (pgm) => {
  pgm.dropTable('vix_history');
  pgm.dropTable('macro_data');
  pgm.dropTable('corporate_actions');
  pgm.dropTable('polygon_financials');
};
