/**
 * src/regime-bot/db-pool.js
 *
 * Single shared pg.Pool for the regime-bot process. Previously each of the
 * 4 regime-bot modules (decision-log, markov-gate, price-loader, trade-log)
 * instantiated its own Pool — that meant 4 separate connection pools per
 * process, multiplying the connection-exhaustion risk flagged in code review.
 *
 * Why not import from src/core/db.js?
 *   The regime-bot also runs as a *standalone* PM2 process (`trading-regime-bot`)
 *   without calling initDb() — it doesn't need the dashboard's full schema-init
 *   logic. Keeping a tiny dedicated pool keeps the regime-bot self-contained
 *   while still consolidating from 4 pools → 1.
 */

import pg from 'pg';

const { Pool } = pg;
let _pool = null;

export function getPool() {
  if (_pool) return _pool;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('[regime-bot] DATABASE_URL is not set — cannot connect to PostgreSQL');

  _pool = new Pool({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  _pool.on('error', (err) => {
    console.error('[regime-bot] DB pool error:', err.message);
  });

  return _pool;
}

/**
 * Shorthand wrapper — same shape as src/core/db.js `query(sql, params)`.
 */
export async function query(sql, params = []) {
  return getPool().query(sql, params);
}

export async function getClient() {
  return getPool().connect();
}

export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
