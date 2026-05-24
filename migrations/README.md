# Database Migrations

Future schema changes go here. The **baseline schema** (everything that
already exists in production) lives in `src/core/db.js` `initDb()` — that
file runs first on every boot and creates any missing tables/columns
idempotently via `CREATE TABLE IF NOT EXISTS` and `DO $$ … IF NOT EXISTS
… ADD COLUMN`.

After the baseline runs, the migration framework (`node-pg-migrate`) runs
any **un-applied** migrations in this directory in order. Each migration
runs exactly once per database and is tracked in the `pgmigrations` table.

---

## Adding a new schema change

1. **Create the migration file**:

   ```bash
   npm run migrate:create add_widgets_table
   ```

   This drops a timestamped file in this directory, e.g.
   `1740400000000_add-widgets-table.cjs`.

2. **Write the migration** — both UP and DOWN. Example:

   ```js
   exports.up = (pgm) => {
     pgm.createTable('widgets', {
       id:       'id',
       name:     { type: 'text', notNull: true },
       owner_id: { type: 'integer', references: 'users(id)' },
       created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
     });
     pgm.createIndex('widgets', 'owner_id');
   };

   exports.down = (pgm) => {
     pgm.dropTable('widgets');
   };
   ```

3. **Apply locally** before committing:

   ```bash
   npm run migrate:up
   ```

4. **Commit + push** — the dashboard's boot sequence will pick up the new
   migration automatically on next restart in any environment.

---

## Operational commands

| Command | What it does |
|---------|--------------|
| `npm run migrate:up`     | Apply all pending migrations |
| `npm run migrate:down`   | Roll back the most recent migration |
| `npm run migrate:status` | Show which migrations have been applied |
| `npm run migrate:create <name>` | Scaffold a new migration file |

`DATABASE_URL` is read from `.env` automatically via the runner script.

---

## Why this directory exists (history)

Prior to 2026-05-24 every schema change was a new `DO $$ BEGIN IF NOT EXISTS
… ADD COLUMN` block appended to `src/core/db.js`. That file grew to ~2,700
lines with no history, no rollback path, and no way to verify what changed
when. The code-review feedback flagged this as a maintainability risk.

The hybrid approach: keep the current `initDb()` as the "this is what
prod looks like" baseline (zero-risk), and adopt `node-pg-migrate` for
all *future* changes. Eventually the baseline can be extracted into
individual migrations if needed, but it doesn't have to happen all at once.
