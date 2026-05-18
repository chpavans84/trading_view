/**
 * UW data retention policy.
 * Purges rows older than the configured window from high-volume tables.
 * Called by a daily 3 AM ET cron in server.js.
 */

import { query, isDbAvailable } from './db.js';

const RETENTION = {
  uw_flow_alerts:  { col: 'alerted_at',  days: parseInt(process.env.UW_FLOW_RETENTION_DAYS    || '90',  10) },
  uw_top_movers:   { col: 'captured_at', days: parseInt(process.env.UW_MOVERS_RETENTION_DAYS  || '30',  10) },
  uw_options_flow: { col: 'ingested_at', days: parseInt(process.env.UW_OPTIONS_FLOW_RETENTION_DAYS || '90', 10) },
};

export async function purgeOldUwRows() {
  const result = {};
  if (!isDbAvailable()) return result;
  for (const [table, { col, days }] of Object.entries(RETENTION)) {
    try {
      const { rowCount } = await query(
        `DELETE FROM ${table} WHERE ${col} < NOW() - INTERVAL '${days} days'`
      );
      result[table] = rowCount ?? 0;
    } catch (e) {
      result[table] = 0;
    }
  }
  return result;
}
