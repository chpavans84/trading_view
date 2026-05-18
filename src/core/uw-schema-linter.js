/**
 * UW field-mapping linter.
 * Samples the raw JSONB column from each persisted UW table and reports
 * keys that are unknown (schema drift) or missing (cron bug).
 */

import { query, isDbAvailable } from './db.js';

// Keys the crons actually read from UW API responses (grep INSERT INTO uw_* in server.js).
// Only tables with a raw JSONB column are included; insider/congress lack one.
// Includes both primary field names AND observed fallback aliases.
const EXPECTED_KEYS = {
  uw_flow_alerts: [
    'ticker', 'type', 'strike', 'expiry', 'total_premium', 'volume', 'open_interest',
    'sentiment', 'created_at',
    // additional fields UW sends — not mapped but not drift
    'alert_rule', 'all_opening_trades', 'ask', 'bid', 'end_time', 'er_time', 'expiry_count',
    'has_floor', 'has_multileg', 'has_singleleg', 'has_sweep', 'id', 'issue_type',
    'iv_end', 'iv_start', 'marketcap', 'missing_periscope', 'next_earnings_date',
    'option_chain', 'price', 'rule_id', 'sector', 'start_time', 'total_ask_side_prem',
    'total_bid_side_prem', 'total_size', 'trade_count', 'underlying_price', 'volume_oi_ratio',
  ],
  uw_top_movers: ['ticker', 'direction', 'change_percent', 'change', 'price', 'volume'],
};

export async function auditUWSchemas() {
  const report = {};
  for (const [table, expectedKeys] of Object.entries(EXPECTED_KEYS)) {
    report[table] = await auditTable(table, expectedKeys);
  }
  return report;
}

async function auditTable(table, expectedKeys) {
  if (!isDbAvailable()) return { sample_size: 0, unknown_keys: [], missing_keys: [], error: 'db unavailable' };
  try {
    const { rows } = await query(
      `SELECT raw FROM ${table} WHERE raw IS NOT NULL ORDER BY id DESC LIMIT 100`
    );
    if (!rows.length) return { sample_size: 0, unknown_keys: [], missing_keys: [] };

    const observedKeys = new Set();
    for (const row of rows) {
      const obj = typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw;
      if (obj && typeof obj === 'object') {
        for (const k of Object.keys(obj)) observedKeys.add(k);
      }
    }

    const expected = new Set(expectedKeys);
    const unknown = [...observedKeys].filter(k => !expected.has(k)).sort();
    const missing = expectedKeys.filter(k => !observedKeys.has(k)).sort();

    return { sample_size: rows.length, unknown_keys: unknown, missing_keys: missing };
  } catch (e) {
    return { sample_size: 0, unknown_keys: [], missing_keys: [], error: e.message };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { initDb } = await import('./db.js');
  await initDb();
  const report = await auditUWSchemas();
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
