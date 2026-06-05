#!/usr/bin/env node
/**
 * One-off: close DGICA, FGBI, MXF, KBON on bot 2 (pavan_acct2 tiger_demo).
 * Keep MU open. User-requested 2026-06-02.
 *
 * Uses the same broker path bot-advance uses internally:
 *   - getTigerQuote   → current ask/bid for P&L computation
 *   - placeTigerOrder → SELL the qty at market
 *   - UPDATE bot_advance_trades → status=closed, exit_reason=manual_close, pnl_usd/pct
 *
 * Run: node scripts/manual-close-bot2-keep-mu.mjs
 *      DRY=1 node scripts/manual-close-bot2-keep-mu.mjs   (preview only, no orders)
 */
import 'dotenv/config';
import { initDb, query } from '../src/core/db.js';
import { getTigerQuote, placeTigerOrder } from '../src/core/tiger.js';
import { decryptCredential } from '../src/core/crypto.js';

const BOT_ID = 2;
const SYMBOLS_TO_CLOSE = ['DGICA', 'FGBI', 'MXF', 'KBON'];
const DRY = process.env.DRY === '1';

async function main() {
  await initDb();

  // Load bot + user creds
  const { rows: botRows } = await query(`SELECT * FROM bots_advance WHERE id=$1`, [BOT_ID]);
  const bot = botRows[0];
  if (!bot) throw new Error(`bot ${BOT_ID} not found`);
  console.log(`Bot: ${bot.name} (user=${bot.user_id}, broker=${bot.broker})`);

  const { rows: userRows } = await query(`SELECT * FROM users WHERE id=$1`, [bot.user_id]);
  const u = userRows[0];
  if (!u?.tiger_demo_id || !u?.tiger_demo_account || !u?.tiger_demo_private_key) {
    throw new Error(`user ${bot.user_id} has no tiger_demo credentials`);
  }
  const creds = {
    tiger_id:    u.tiger_demo_id,
    account:     u.tiger_demo_account,
    private_key: decryptCredential(u.tiger_demo_private_key),
  };

  // Load open trades for this bot
  const { rows: openTrades } = await query(
    `SELECT id, symbol, qty, entry_price, dollars_invested
       FROM bot_advance_trades
      WHERE bot_id=$1 AND status='open' AND UPPER(symbol) = ANY($2::text[])
      ORDER BY symbol`,
    [BOT_ID, SYMBOLS_TO_CLOSE]
  );

  if (!openTrades.length) {
    console.log('No matching open trades. Nothing to close.');
    return;
  }
  console.log(`\nFound ${openTrades.length} open trade(s) to close:`);
  for (const t of openTrades) {
    console.log(`  #${t.id} ${t.symbol} qty=${t.qty} entry=$${t.entry_price}`);
  }

  if (DRY) { console.log('\n[DRY RUN] Skipping order placement.'); return; }

  const results = [];
  for (const t of openTrades) {
    const symbol = t.symbol.toUpperCase();
    const qty    = Number(t.qty);
    console.log(`\n--- Closing ${symbol} qty=${qty} ---`);

    // Live quote for P&L computation (bid for sell)
    let livePrice = null;
    try {
      const q = await getTigerQuote(creds, symbol);
      livePrice = Number(q.bid || q.last || q.ask || 0);
      console.log(`  quote: bid=${q.bid} last=${q.last} ask=${q.ask}`);
    } catch (e) {
      console.warn(`  quote failed: ${e.message}`);
    }

    // Place market sell
    let order;
    try {
      order = await placeTigerOrder(creds, { symbol, side: 'SELL', qty, outsideRth: false });
      console.log(`  order placed:`, JSON.stringify(order).slice(0, 200));
    } catch (e) {
      console.error(`  ❌ SELL FAILED: ${e.message}`);
      results.push({ symbol, ok: false, error: e.message });
      continue;
    }

    // Use the live price as fill estimate (Tiger paper doesn't return immediate fill)
    const exitPrice = livePrice || Number(t.entry_price);
    const entry     = Number(t.entry_price);
    const pnlUsd    = +((exitPrice - entry) * qty).toFixed(2);
    const pnlPct    = +(((exitPrice - entry) / entry) * 100).toFixed(3);

    // Mark closed in DB
    await query(`
      UPDATE bot_advance_trades
         SET status='closed',
             exit_price=$1, exit_reason='manual_close_user_request',
             pnl_usd=$2, pnl_pct=$3, closed_at=NOW()
       WHERE id=$4
    `, [exitPrice, pnlUsd, pnlPct, t.id]);

    console.log(`  ✅ trade #${t.id} closed @ $${exitPrice} pnl=$${pnlUsd} (${pnlPct}%)`);
    results.push({ symbol, ok: true, exitPrice, pnlUsd, pnlPct });
  }

  // Update bot's cumulative P&L and clear current_trade_id pointer if it pointed at one of these
  const totalPnl = results.filter(r => r.ok).reduce((s, r) => s + r.pnlUsd, 0);
  await query(`
    UPDATE bots_advance
       SET cumulative_pnl_usd = COALESCE(cumulative_pnl_usd, 0) + $1,
           current_trade_id = (
             SELECT id FROM bot_advance_trades
              WHERE bot_id=$2 AND status='open' ORDER BY id DESC LIMIT 1
           ),
           updated_at = NOW()
     WHERE id=$2
  `, [totalPnl, BOT_ID]);

  console.log(`\n=== SUMMARY ===`);
  console.log(`Closed: ${results.filter(r=>r.ok).length}/${results.length}`);
  console.log(`Realized P&L: $${totalPnl.toFixed(2)}`);
  console.log(`Bot 2 should now hold ONLY MU.`);

  // Final state confirm
  const { rows: stillOpen } = await query(
    `SELECT symbol, qty, entry_price FROM bot_advance_trades WHERE bot_id=$1 AND status='open'`,
    [BOT_ID]
  );
  console.log(`\nRemaining OPEN on bot ${BOT_ID}:`);
  for (const t of stillOpen) console.log(`  ${t.symbol} qty=${t.qty} @ $${t.entry_price}`);
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error('FATAL:', e); process.exit(1); });
