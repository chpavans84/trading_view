/**
 * Daily UW data-quality report.
 * Checks row counts, staleness, and NULL rates for each UW table.
 * Called by an 8 AM ET cron in server.js.
 */

import { query, isDbAvailable } from './db.js';

const TABLES = [
  {
    name: 'uw_flow_alerts',
    ts_col: 'alerted_at',
    null_cols: ['premium', 'strike', 'expiry'],
  },
  {
    name: 'uw_top_movers',
    ts_col: 'captured_at',
    null_cols: ['change_pct', 'price'],
  },
  {
    name: 'uw_insider_trades',
    ts_col: 'ingested_at',
    null_cols: ['value', 'filed_at'],
  },
  {
    name: 'uw_congressional_trades',
    ts_col: 'ingested_at',
    null_cols: ['traded_at', 'transaction_type'],
  },
];

export async function dailyDataQualityReport() {
  const report = {};
  if (!isDbAvailable()) return report;

  for (const { name, ts_col, null_cols } of TABLES) {
    try {
      const selects = [
        `COUNT(*) FILTER (WHERE ${ts_col} > NOW() - INTERVAL '7 days') AS total_rows_7d`,
        `COUNT(*) FILTER (WHERE ${ts_col} > NOW() - INTERVAL '24 hours') AS rows_24h`,
        `COUNT(DISTINCT ticker) FILTER (WHERE ${ts_col} > NOW() - INTERVAL '24 hours') AS unique_tickers_24h`,
        `EXTRACT(EPOCH FROM (NOW() - MIN(${ts_col}) FILTER (WHERE ${ts_col} > NOW() - INTERVAL '24 hours'))) / 60 AS oldest_24h_row_age_minutes`,
        ...null_cols.map(col =>
          `ROUND(100.0 * COUNT(*) FILTER (WHERE ${ts_col} > NOW() - INTERVAL '24 hours' AND ${col} IS NULL) ` +
          `/ NULLIF(COUNT(*) FILTER (WHERE ${ts_col} > NOW() - INTERVAL '24 hours'), 0), 1) AS null_${col}`
        ),
      ];

      const { rows } = await query(`SELECT ${selects.join(', ')} FROM ${name}`);
      const r = rows[0] || {};

      const null_rates = {};
      for (const col of null_cols) {
        null_rates[col] = parseFloat(r[`null_${col}`] ?? 0);
      }

      report[name] = {
        total_rows_7d:              parseInt(r.total_rows_7d ?? 0),
        rows_24h:                   parseInt(r.rows_24h ?? 0),
        unique_tickers_24h:         parseInt(r.unique_tickers_24h ?? 0),
        oldest_24h_row_age_minutes: parseFloat(r.oldest_24h_row_age_minutes ?? 0),
        null_rates,
      };
    } catch (e) {
      report[name] = { error: e.message };
    }
  }
  return report;
}
