#!/usr/bin/env node
/**
 * scripts/bot-advance-control.mjs — operator CLI for the bot-advance challenger.
 *
 *   npm run bot-advance:status               # snapshot of advance bots + open trades + last 24h decisions
 *   npm run bot-advance:stop                 # stop ALL advance bots
 *   npm run bot-advance:stop <id>            # stop one
 *   npm run bot-advance:start <id>           # reactivate
 *   npm run bot-advance:scan                 # run one scan tick manually (any time)
 *   npm run bot-advance:set-mode shadow      # all bots → shadow_mode=true
 *   npm run bot-advance:set-mode live        # all bots → shadow_mode=false (CARE)
 */

import { initDb, query } from '../src/core/db.js';
import { runAdvanceScanForAllActive } from '../src/core/bot-advance/engine.js';
import os from 'node:os';

const CMD = process.argv[2];
const ARG = process.argv[3];

await initDb();

async function audit(action, ids, note) {
  try {
    await query(`
      INSERT INTO system_alerts (key, severity, title, detail, hostname, pid)
      VALUES ($1, 'info', $2, $3, $4, $5)
    `, [
      `bot_advance_control:${action}`,
      `bot-advance ${action} (${ids.join(',') || 'none'})`,
      JSON.stringify({ action, bot_ids: ids, note, ts: new Date().toISOString() }),
      os.hostname(), process.pid,
    ]);
  } catch {}
}

async function cmdStatus() {
  const bots = await query(`SELECT * FROM bots_advance ORDER BY id`);
  console.log('\n📊 BOT-ADVANCE STATUS — ' + new Date().toISOString());
  console.log('─'.repeat(80));
  for (const b of bots.rows) {
    const icon = b.status === 'active' ? '🟢' : b.status === 'stopped' ? '🛑' : '⏸';
    const mode = b.shadow_mode ? '🧪 SHADOW' : '🔴 LIVE-PAPER';
    console.log(
      `  ${icon} bot ${String(b.id).padStart(2)} ${b.name.padEnd(20)} ${b.status.padEnd(8)} ${mode.padEnd(15)} ` +
      `$${Number(b.capital_usd).toFixed(0)} cumPnl=$${Number(b.cumulative_pnl_usd).toFixed(2)} ` +
      `current_trade=${b.current_trade_id ?? '—'}`
    );
    console.log(`        rules: ${JSON.stringify(b.enabled_rules)}`);
  }

  console.log('\nOpen trades:');
  const open = await query(`
    SELECT id, bot_id, symbol, qty, entry_price, entry_rule, stop_loss_price, opened_at, shadow_mode
      FROM bot_advance_trades
     WHERE status='open' ORDER BY opened_at
  `);
  if (!open.rows.length) console.log('  (none)');
  open.rows.forEach(t => {
    const tag = t.shadow_mode ? '🧪' : '🔴';
    const age = ((Date.now() - new Date(t.opened_at).getTime()) / 3600000).toFixed(1);
    console.log(`  ${tag} #${t.id} ${t.symbol} x${t.qty} @$${t.entry_price} stop=$${t.stop_loss_price ?? '—'} rule=${t.entry_rule} bot=${t.bot_id} age=${age}h`);
  });

  // Last 24h decision summary
  const dec = await query(`
    SELECT bot_id, action, entry_rule, COUNT(*)::int AS n
      FROM bot_advance_decisions
     WHERE scanned_at > NOW() - INTERVAL '24 hours'
     GROUP BY bot_id, action, entry_rule
     ORDER BY bot_id, n DESC
  `);
  console.log('\nLast 24h decisions:');
  if (!dec.rows.length) console.log('  (no decisions yet)');
  dec.rows.forEach(d => console.log(`  bot ${d.bot_id}  ${d.action.padEnd(20)} rule=${(d.entry_rule ?? '—').padEnd(28)} ${d.n}`));

  // Last 5 would_buy decisions
  const wb = await query(`
    SELECT scanned_at, bot_id, symbol, entry_rule, composite_score, also_matched, shadow_mode
      FROM bot_advance_decisions
     WHERE action='would_buy'
     ORDER BY scanned_at DESC LIMIT 5
  `);
  console.log('\nMost recent 5 WOULD_BUY decisions:');
  if (!wb.rows.length) console.log('  (none yet)');
  wb.rows.forEach(d => console.log(
    `  ${String(d.scanned_at).slice(0,19)} bot=${d.bot_id} ${d.symbol.padEnd(6)} rule=${d.entry_rule.padEnd(28)} ` +
    `composite=${d.composite_score ?? '—'} ${d.shadow_mode ? 'SHADOW' : 'LIVE'}`
  ));

  console.log('');
}

async function cmdStop() {
  const targets = ARG && ARG !== 'all'
    ? [parseInt(ARG, 10)]
    : (await query(`SELECT id FROM bots_advance WHERE status='active'`)).rows.map(r => r.id);
  const r = await query(`
    UPDATE bots_advance SET status='stopped', updated_at=NOW()
     WHERE id = ANY($1::int[]) AND status='active'
     RETURNING id, name
  `, [targets]);
  if (!r.rows.length) return console.log('ℹ️  Nothing to stop.');
  await audit('stop', r.rows.map(x => x.id));
  console.log(`🛑 Stopped ${r.rows.length} advance bot(s):`);
  r.rows.forEach(x => console.log(`   - bot ${x.id} ${x.name}`));
}

async function cmdStart() {
  const targets = ARG && ARG !== 'all'
    ? [parseInt(ARG, 10)]
    : (await query(`SELECT id FROM bots_advance WHERE status IN ('stopped','paused')`)).rows.map(r => r.id);
  const r = await query(`
    UPDATE bots_advance SET status='active', updated_at=NOW()
     WHERE id = ANY($1::int[]) AND status != 'active'
     RETURNING id, name
  `, [targets]);
  if (!r.rows.length) return console.log('ℹ️  Nothing to start.');
  await audit('start', r.rows.map(x => x.id));
  console.log(`🟢 Started ${r.rows.length} advance bot(s):`);
  r.rows.forEach(x => console.log(`   - bot ${x.id} ${x.name}`));
}

async function cmdScan() {
  console.log('Running one scan tick across all active advance bots…');
  const t = performance.now();
  const r = await runAdvanceScanForAllActive();
  console.log(`Done in ${((performance.now() - t) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(r, null, 2));
}

async function cmdSetMode() {
  const mode = ARG;
  if (mode !== 'shadow' && mode !== 'live') {
    console.error('Usage: npm run bot-advance:set-mode shadow|live');
    process.exit(2);
  }
  const newVal = mode === 'shadow';
  const r = await query(`UPDATE bots_advance SET shadow_mode=$1, updated_at=NOW() RETURNING id, name, shadow_mode`, [newVal]);
  await audit(`set-mode-${mode}`, r.rows.map(x => x.id));
  console.log(`🔧 Set ${r.rows.length} bot(s) to shadow_mode=${newVal}:`);
  r.rows.forEach(x => console.log(`   - bot ${x.id} ${x.name} shadow=${x.shadow_mode}`));
  if (!newVal) {
    console.log('\n⚠️  LIVE-PAPER MODE ACTIVE. Bot-advance will now place real paper trades.');
  }
}

try {
  switch (CMD) {
    case 'status':   await cmdStatus(); break;
    case 'stop':     await cmdStop(); break;
    case 'start':    await cmdStart(); break;
    case 'scan':     await cmdScan(); break;
    case 'set-mode': await cmdSetMode(); break;
    default:
      console.log(`Usage:
  npm run bot-advance:status
  npm run bot-advance:stop [id|all]
  npm run bot-advance:start [id|all]
  npm run bot-advance:scan                  # run one scan tick now
  npm run bot-advance:set-mode shadow|live  # flip all advance bots`);
      process.exit(1);
  }
} catch (e) {
  console.error('💥', e.message);
  process.exit(1);
} finally {
  process.exit(0);
}
