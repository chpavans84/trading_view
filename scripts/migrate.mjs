#!/usr/bin/env node
/**
 * scripts/migrate.mjs
 *
 * Thin wrapper around node-pg-migrate that:
 *   1. Loads .env via the same fallback mechanism src/core/env-loader.js uses
 *      (so DATABASE_URL works even when the shell hasn't been sourced)
 *   2. Auto-detects the migrations directory at <repo-root>/migrations
 *   3. Forwards any CLI args to node-pg-migrate
 *
 * Used by these npm scripts:
 *   npm run migrate:up       — apply all pending
 *   npm run migrate:down     — roll back the most recent
 *   npm run migrate:status   — show applied vs pending
 *   npm run migrate:create   — scaffold a new migration
 */

import '../src/core/env-loader.js';     // populates process.env from .env

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');

if (!process.env.DATABASE_URL) {
  console.error('[migrate] DATABASE_URL is not set — check .env');
  process.exit(2);
}

// node-pg-migrate's CLI uses positional command + flags
const userArgs = process.argv.slice(2);
const cmd = userArgs[0];

if (!cmd) {
  console.error(`
Usage: npm run migrate:<command>

Commands:
  up        Apply all pending migrations
  down      Roll back the most recent migration
  status    Show applied vs pending migrations
  create    Scaffold a new migration file (pass <name> after)

Examples:
  npm run migrate:up
  npm run migrate:create -- add_widgets_table
`);
  process.exit(1);
}

// node-pg-migrate doesn't have a top-level `status` command; it uses `redo`/`up`/`down`.
// Add a thin wrapper so the npm script names map nicely.
let args;
switch (cmd) {
  case 'status':
    // Show applied migrations by querying the pgmigrations table directly
    await showStatus();
    process.exit(0);

  case 'create':
    // node-pg-migrate's create command — the name comes after
    args = ['create', userArgs[1] || 'unnamed', '--migration-file-language', 'js'];
    break;

  case 'up':
  case 'down':
  case 'redo':
    args = userArgs;
    break;

  default:
    args = userArgs;
}

const result = spawnSync(
  'npx',
  [
    'node-pg-migrate',
    ...args,
    '--migrations-dir', MIGRATIONS_DIR,
    '--database-url-var', 'DATABASE_URL',
    '--ignore-pattern', '(README|.*\\.md)',
  ],
  { stdio: 'inherit', cwd: REPO_ROOT }
);

process.exit(result.status ?? 0);

// ─── Helpers ────────────────────────────────────────────────────────────────
async function showStatus() {
  const { default: pg } = await import('pg');
  const { readdirSync, existsSync } = await import('node:fs');

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Make sure the tracking table exists
  await client.query(`CREATE TABLE IF NOT EXISTS pgmigrations (
    id   serial PRIMARY KEY,
    name varchar(255) NOT NULL,
    run_on timestamp NOT NULL DEFAULT NOW()
  )`);

  const { rows } = await client.query(`SELECT name, run_on FROM pgmigrations ORDER BY id`);
  const applied = new Set(rows.map(r => r.name));

  const files = existsSync(MIGRATIONS_DIR)
    ? readdirSync(MIGRATIONS_DIR).filter(f => /\.(cjs|js|sql)$/.test(f) && f !== 'README.md').sort()
    : [];

  console.log(`Migrations directory: ${MIGRATIONS_DIR}`);
  console.log(`Total migrations: ${files.length}   Applied: ${rows.length}   Pending: ${files.length - rows.length}\n`);

  if (files.length === 0) {
    console.log('(no migrations yet — schema baseline lives in src/core/db.js initDb)');
  } else {
    for (const f of files) {
      const name = f.replace(/\.(cjs|js|sql)$/, '');
      const row = rows.find(r => r.name === name);
      const status = row ? `✓ applied ${new Date(row.run_on).toISOString()}` : '· pending';
      console.log(`  ${status.padEnd(40)} ${f}`);
    }
  }

  await client.end();
}
