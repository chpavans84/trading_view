#!/usr/bin/env node
/**
 * scripts/bot-control.mjs — emergency kill switch + status check + restart for bots.
 *
 * Usage:
 *   npm run bot:stop              → stop ALL active bots
 *   npm run bot:stop 27           → stop bot #27 only
 *   npm run bot:start 27          → re-activate bot #27 (status='active')
 *   npm run bot:status            → snapshot of every non-deleted bot + open trades
 *
 * Design notes:
 *   - "Stop" sets bots.status='stopped'. The executor's `runExecutorForAllActive()`
 *     only iterates `status='active'` bots, so a stopped bot is fully inert at the
 *     next 1-minute cron tick. NO PM2 restart needed — effect is immediate.
 *   - Open positions DO get a final manage tick before the bot becomes inert
 *     (since the executor walks active bots, and we're flipping status not deleting).
 *     To exit a held position cleanly, leave the bot 'active', let it hit its stop.
 *   - Every stop/start writes a row to `system_alerts` so the dashboard's audit
 *     trail captures who-stopped-what-when. Severity='info' so it doesn't trip
 *     alert emails.
 *   - Pure script, no MCP/HTTP/cron — safe to run from anywhere with DB access.
 *   - Reads DATABASE_URL from .env via Node's --env-file flag (set in package.json scripts).
 */

import pg from 'pg';
import os from 'node:os';

const { Pool } = pg;

const COMMAND = process.argv[2];            // 'stop' | 'start' | 'status'
const BOT_ID  = process.argv[3];            // optional, may be 'all' or numeric

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set — cannot connect to DB. Check .env');
  process.exit(2);
}

const pool = new Pool({ connectionString: DATABASE_URL });

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function listActiveBots() {
  const { rows } = await pool.query(
    `SELECT id, name, status, broker, capital_usd, current_trade_id, cumulative_pnl_usd
       FROM bots
      WHERE deleted_at IS NULL
      ORDER BY id`
  );
  return rows;
}

async function listOpenTrades() {
  const { rows } = await pool.query(
    `SELECT id, symbol, qty, entry_price, stop_loss, setup_type, opened_at, bot_id, account_source
       FROM trades
      WHERE status='open'
      ORDER BY opened_at`
  );
  return rows;
}

async function logAudit(action, botIds, note) {
  // system_alerts is the existing audit table — severity=info means "just for the record".
  try {
    await pool.query(
      `INSERT INTO system_alerts (key, severity, title, detail, hostname, pid)
       VALUES ($1, 'info', $2, $3, $4, $5)`,
      [`bot_control:${action}`, `bot-control ${action} (${botIds.join(',') || 'none'})`,
       JSON.stringify({ action, bot_ids: botIds, note, ts: new Date().toISOString() }),
       os.hostname(), process.pid]
    );
  } catch (e) {
    console.warn('⚠️  audit insert failed (proceeding):', e.message);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdStatus() {
  const bots = await listActiveBots();
  const trades = await listOpenTrades();

  console.log('\n📊 BOT STATUS — ' + new Date().toISOString());
  console.log('─'.repeat(70));

  if (!bots.length) {
    console.log('  (no bots configured)');
  } else {
    for (const b of bots) {
      const icon = b.status === 'active' ? '🟢' : b.status === 'stopped' ? '🛑' : '⏸️ ';
      const trade = trades.find(t => t.bot_id === b.id);
      const tradeStr = trade
        ? `holding ${trade.symbol} x${trade.qty} @ $${trade.entry_price}`
        : '—';
      console.log(`  ${icon} bot ${b.id.toString().padStart(2)} ${b.name.padEnd(28)} ${b.status.padEnd(13)} ${b.broker.padEnd(12)} $${Number(b.capital_usd).toFixed(0).padStart(6)} cumPnl=$${Number(b.cumulative_pnl_usd).toFixed(2).padStart(9)}  ${tradeStr}`);
    }
  }

  console.log('─'.repeat(70));
  console.log(`Open trades: ${trades.length}`);
  for (const t of trades) {
    const ageHrs = ((Date.now() - new Date(t.opened_at).getTime()) / 3600000).toFixed(1);
    console.log(`  #${t.id} ${t.symbol} x${t.qty} @ $${t.entry_price} stop=$${t.stop_loss} setup=${t.setup_type} bot=${t.bot_id} age=${ageHrs}h`);
  }
  console.log('');
}

async function cmdStop() {
  const targets = await resolveTargets({ requireActive: true });
  if (!targets.length) {
    console.log('ℹ️  No bots to stop (none currently active).');
    return;
  }

  const { rows } = await pool.query(
    `UPDATE bots SET status='stopped', updated_at=NOW()
      WHERE id = ANY($1::int[]) AND status='active' AND deleted_at IS NULL
      RETURNING id, name, current_trade_id`,
    [targets]
  );

  if (!rows.length) {
    console.log('ℹ️  Nothing changed (targets were not in active state).');
    return;
  }

  await logAudit('stop', rows.map(r => r.id), `stopped via npm run bot:stop`);

  console.log(`\n🛑 STOPPED ${rows.length} bot(s):`);
  for (const r of rows) {
    const note = r.current_trade_id
      ? `(holding trade #${r.current_trade_id} — position will keep being managed until exit)`
      : '(no open position)';
    console.log(`   - bot ${r.id} ${r.name} ${note}`);
  }
  console.log('\nNext executor tick (within 60s) will skip these bots. No restart needed.');
  if (rows.some(r => r.current_trade_id)) {
    console.log('⚠️  Bots holding positions: the executor still manages OPEN trades for STOPPED bots');
    console.log('    (graceful exit). To force-close, do it via your broker UI.');
  }
  console.log('');
}

async function cmdStart() {
  const targets = await resolveTargets({ requireActive: false });
  if (!targets.length) {
    console.log('ℹ️  No targets specified.');
    return;
  }

  const { rows } = await pool.query(
    `UPDATE bots SET status='active', updated_at=NOW()
      WHERE id = ANY($1::int[]) AND status IN ('stopped','paused_today') AND deleted_at IS NULL
      RETURNING id, name`,
    [targets]
  );

  if (!rows.length) {
    console.log('ℹ️  Nothing changed (targets were not in stopped/paused state).');
    return;
  }

  await logAudit('start', rows.map(r => r.id), `started via npm run bot:start`);

  console.log(`\n🟢 STARTED ${rows.length} bot(s):`);
  for (const r of rows) console.log(`   - bot ${r.id} ${r.name}`);
  console.log('\nNext scanner/executor tick will pick them up.\n');
}

async function resolveTargets({ requireActive }) {
  if (!BOT_ID || BOT_ID === 'all') {
    // All active bots (for stop) or all stopped bots (for start)
    const status = requireActive ? 'active' : 'stopped';
    const { rows } = await pool.query(
      `SELECT id FROM bots WHERE status=$1 AND deleted_at IS NULL`, [status]
    );
    return rows.map(r => r.id);
  }
  const id = parseInt(BOT_ID, 10);
  if (!Number.isFinite(id)) {
    console.error(`❌ Bad bot id: "${BOT_ID}" — must be numeric or "all"`);
    process.exit(2);
  }
  return [id];
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

try {
  switch (COMMAND) {
    case 'status': await cmdStatus(); break;
    case 'stop':   await cmdStop();   break;
    case 'start':  await cmdStart();  break;
    default:
      console.error(`Usage:
  npm run bot:status                 # snapshot of every bot + open trades
  npm run bot:stop                   # stop ALL active bots
  npm run bot:stop <bot_id>          # stop one bot
  npm run bot:start <bot_id>         # re-activate a stopped/paused bot
  npm run bot:start all              # re-activate all stopped bots`);
      process.exit(1);
  }
} catch (e) {
  console.error('💥 fatal:', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
