/**
 * src/core/migration-runner.js
 *
 * Run any pending node-pg-migrate migrations at boot. Called after initDb()
 * so the baseline schema is already in place.
 *
 * Designed to fail SAFE: if migrations error out, we log loudly and continue
 * boot — the existing baseline schema is still functional. A failed migration
 * is a deploy-time bug, not a runtime crash.
 *
 * Returns:
 *   { applied: number, skipped: 'no_migrations_dir' | 'no_files', error?: string }
 */

import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

export async function runPendingMigrations() {
  // 1. Bail early if no migrations directory or no migration files
  if (!existsSync(MIGRATIONS_DIR)) {
    return { applied: 0, skipped: 'no_migrations_dir' };
  }
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => /\.(cjs|js|sql)$/.test(f));
  if (files.length === 0) {
    return { applied: 0, skipped: 'no_files' };
  }

  // 2. Load node-pg-migrate dynamically so it stays a devDep at build time
  let runner;
  try {
    const mod = await import('node-pg-migrate');
    runner = mod.default ?? mod;
  } catch (e) {
    // Module not installed (e.g. production deploy without devDeps) — that's fine.
    // Skip migrations and let boot proceed with the baseline schema.
    console.warn(`[migrations] node-pg-migrate not installed — skipping (${e.message})`);
    return { applied: 0, skipped: 'module_not_installed' };
  }

  // 3. Run migrations
  try {
    const result = await runner({
      databaseUrl: process.env.DATABASE_URL,
      dir: MIGRATIONS_DIR,
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: false,
      singleTransaction: true,
      // Don't lock — the baseline already created the migrations table if missing,
      // and on a stale schema we want this to be observable, not silent.
      noLock: false,
      // Skip README.md and any other markdown files in migrations/
      ignorePattern: '(README|.*\\.md)',
    });
    const applied = Array.isArray(result) ? result.length : 0;
    if (applied > 0) {
      console.log(`[migrations] ✓ applied ${applied} migration(s):`,
        result.map(m => m.name || m).join(', '));
    } else {
      console.log('[migrations] ✓ all up-to-date');
    }
    return { applied };
  } catch (e) {
    // Loudly log but don't crash — the baseline schema is still good.
    console.error('[migrations] ✗ failed:', e.message);
    return { applied: 0, error: e.message };
  }
}
