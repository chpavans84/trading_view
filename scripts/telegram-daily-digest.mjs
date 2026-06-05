#!/usr/bin/env node
/**
 * Telegram daily digest: top ML picks + fleet summary + market quick stats.
 * Cron at 09:00 ET pre-market (= 21:00 SGT) so Pavan sees it before he sleeps.
 *
 * Pulls:
 *   - Today's top-10 ML picks (after quality filter)
 *   - Yesterday's bot fleet P&L
 *   - Today's open positions across all bots
 *   - Drift detector last run (any phantoms reconciled?)
 */
import 'dotenv/config';
import { initDb, query } from '../src/core/db.js';
import { scoreUniverse, POOR_SECTORS_DEFAULT } from '../src/core/model-v2-scorer.js';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log(text); return; }
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, parse_mode: 'HTML', text, disable_web_page_preview: true }),
  }).catch(e => console.error('telegram error:', e.message));
}

async function main() {
  await initDb();

  // Top ML picks today (after quality filter)
  let picksBlock = '';
  try {
    const r = await scoreUniverse({
      limit: 10, minPrice: 5, maxPrice: 500, minVolume: 1_000_000,
      excludeSectors: POOR_SECTORS_DEFAULT, bullishMin: 20, bullishMax: 65,
    });
    if (r.results?.length) {
      picksBlock = '🎯 <b>Top ML picks today (' + r.date + ')</b>\n';
      for (let i = 0; i < Math.min(10, r.results.length); i++) {
        const p = r.results[i];
        picksBlock += `${i+1}. <code>${p.symbol}</code> ${(p.prob*100).toFixed(0)}% @ $${Number(p.reg_close).toFixed(2)} (${p.sector || '?'})\n`;
      }
    } else {
      picksBlock = '⚠️ ML picks: 0 (no fresh data)\n';
    }
  } catch (e) {
    picksBlock = '⚠️ ML picks failed: ' + e.message.slice(0, 80) + '\n';
  }

  // Yesterday's P&L per bot
  let pnlBlock = '\n📊 <b>Yesterday P&amp;L (closed trades)</b>\n';
  try {
    const { rows } = await query(`
      SELECT b.name, COALESCE(SUM(t.pnl_usd), 0)::numeric(10,2) AS pnl, COUNT(*) AS trades
        FROM bots b LEFT JOIN trades t ON t.bot_id=b.id
       WHERE t.status='closed'
         AND (t.closed_at AT TIME ZONE 'America/New_York')::date = (NOW() AT TIME ZONE 'America/New_York')::date - 1
       GROUP BY b.id, b.name
       UNION ALL
      SELECT ba.name, COALESCE(SUM(bat.pnl_usd), 0)::numeric(10,2), COUNT(*)
        FROM bots_advance ba LEFT JOIN bot_advance_trades bat ON bat.bot_id=ba.id
       WHERE bat.status='closed'
         AND (bat.closed_at AT TIME ZONE 'America/New_York')::date = (NOW() AT TIME ZONE 'America/New_York')::date - 1
       GROUP BY ba.id, ba.name
       ORDER BY pnl DESC
    `);
    if (rows.length === 0) pnlBlock += '  (no closed trades yesterday)\n';
    for (const r of rows) {
      const sign = Number(r.pnl) >= 0 ? '+' : '';
      pnlBlock += `  ${r.name}: ${sign}$${r.pnl} (${r.trades} trades)\n`;
    }
  } catch (e) { pnlBlock += '  query failed\n'; }

  // Current open positions
  let openBlock = '\n📂 <b>Open positions now</b>\n';
  try {
    const { rows } = await query(`
      SELECT b.name AS bot, t.symbol, t.entry_price::numeric(10,2) AS entry, t.qty
        FROM trades t JOIN bots b ON b.id=t.bot_id
       WHERE t.status='open'
       UNION ALL
      SELECT ba.name, bat.symbol, bat.entry_price::numeric(10,2), bat.qty
        FROM bot_advance_trades bat JOIN bots_advance ba ON ba.id=bat.bot_id
       WHERE bat.status='open'
       ORDER BY bot, symbol
    `);
    if (rows.length === 0) openBlock += '  (none)\n';
    for (const r of rows) {
      openBlock += `  ${r.bot}: ${r.symbol} x${Number(r.qty)} @ $${r.entry}\n`;
    }
  } catch (e) { openBlock += '  query failed\n'; }

  await tg(picksBlock + pnlBlock + openBlock);
  console.log('digest sent');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
