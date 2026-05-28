#!/usr/bin/env node
/**
 * scripts/bot-advance-provision.mjs
 *
 * Provision a bot-advance instance for a given user, auto-detecting their
 * available paper-broker credentials.
 *
 *   npm run bot-advance:provision <username>
 *   npm run bot-advance:provision pavan_acct2
 *
 * For each broker the user has creds for (alpaca, tiger_demo), creates a
 * bot named BOT_ADVANCE_<username>_<broker>. Idempotent — re-running just
 * reports existing bots.
 *
 * Skips brokers the user doesn't have credentials for. Skips 'tiger' (live)
 * because bot-advance is paper-only by design.
 */

import { initDb, query } from '../src/core/db.js';

const username = process.argv[2];
if (!username) {
  console.error('Usage: npm run bot-advance:provision <username>');
  process.exit(2);
}

await initDb();

const { rows: u } = await query(`SELECT * FROM users WHERE username=$1 LIMIT 1`, [username]);
if (!u.length) {
  console.error(`User '${username}' not found.`);
  process.exit(2);
}
const user = u[0];

const brokers = [];
if (user.alpaca_api_key) brokers.push('alpaca');
if (user.tiger_demo_id && user.tiger_demo_account && user.tiger_demo_private_key) brokers.push('tiger_demo');

if (!brokers.length) {
  console.error(`User '${username}' has no paper-broker credentials configured.`);
  console.error('Bot-advance needs alpaca paper or tiger_demo credentials.');
  process.exit(3);
}

console.log(`User '${username}' (id=${user.id}) has brokers: ${brokers.join(', ')}\n`);

const DEFAULT_RULES = {
  sizing:        { position_size_pct: 95, max_position_usd: 1000 },
  execution:     { order_type: 'auto', allow_outside_rth: false },
  entry_filters: { price_min: 5, price_max: 2500, avoid_earnings_within_days: 3, block_late_session: true },
};

const DEFAULT_ENABLED_RULES = [
  'insider_director_cluster',
  'at_52w_high_with_volume',
  'momentum_flip',
  'congress_high_conviction',
  'composite_70',
];

for (const broker of brokers) {
  const name = `BOT_ADVANCE_${username}_${broker}`;
  const existing = await query(`SELECT id, status, shadow_mode FROM bots_advance WHERE name=$1`, [name]);
  if (existing.rows.length) {
    const b = existing.rows[0];
    console.log(`  ○ ${name} already exists (#${b.id}, status=${b.status}, shadow=${b.shadow_mode})`);
    continue;
  }
  const r = await query(`
    INSERT INTO bots_advance (name, user_id, broker, status, shadow_mode, capital_usd, rules, enabled_rules)
    VALUES ($1, $2, $3, 'active', TRUE, 10000, $4::jsonb, $5::jsonb)
    RETURNING id
  `, [name, user.id, broker, JSON.stringify(DEFAULT_RULES), JSON.stringify(DEFAULT_ENABLED_RULES)]);
  console.log(`  ✓ Created bot #${r.rows[0].id} ${name} (broker=${broker}, shadow=TRUE, $10K capital)`);
}

console.log('\nDone. Run `npm run bot-advance:status` to see them.');
console.log('When ready to start placing real paper trades:');
console.log(`  npm run bot-advance:set-mode live`);
process.exit(0);
