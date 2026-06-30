/**
 * src/sim/db.mjs — BOT_SIM database connection (restricted role).
 *
 * Connects as `sim_runner`: ALL on schema sim, SELECT-only on public.
 * An accidental production write is rejected by Postgres itself (verified
 * 2026-06-13). The engine never imports the production db.js — full isolation.
 */
import 'dotenv/config';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { Pool, types } = pg;
types.setTypeParser(1082, v => v);   // DATE → 'YYYY-MM-DD' string

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIM_PW = readFileSync(join(__dirname, '.sim-secret'), 'utf8').trim();

// Derive host/db from the owner URL but connect as the restricted role.
const owner = new URL(process.env.DATABASE_URL || 'postgresql://localhost/tradingbot');
const host = owner.hostname || 'localhost';
const port = owner.port || 5432;
const database = owner.pathname.slice(1) || 'tradingbot';

const pool = new Pool({ host, port, database, user: 'sim_runner', password: SIM_PW, max: 6 });

export async function simQuery(text, params = []) {
  const r = await pool.query(text, params);
  return r;
}
export async function simEnd() { await pool.end(); }
export { pool as simPool };
