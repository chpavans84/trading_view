#!/usr/bin/env node
/**
 * scripts/ops/insider-bot-weekly.mjs
 *
 * Weekly check-in on the insider-only bot 4 (reconfigured 2026-07-09). Computes win rate,
 * profit factor, and P&L on the insider trades SINCE the reconfig, plus open positions and
 * account equity, and sends a Telegram summary. Scheduled via LaunchAgent (NOT cron — cron
 * doesn't fire reliably on this Mac). See com.pavan.insider-bot-weekly.plist.
 *
 * Run manually: node --env-file=.env scripts/ops/insider-bot-weekly.mjs
 */
import pg from 'pg';

const RECONFIG = '2026-07-09';   // insider-only config went live
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function n(x, d = 2) { return x == null ? '—' : Number(x).toFixed(d); }

async function main() {
  // 1. Closed insider trades since reconfig
  const { rows: [s] } = await pool.query(`
    SELECT count(*) n,
      sum((pnl_usd>0)::int) wins,
      round(sum(pnl_usd)::numeric,2)                               net,
      round(sum(pnl_usd) FILTER(WHERE pnl_usd>0)::numeric,2)       gwin,
      round(abs(sum(pnl_usd) FILTER(WHERE pnl_usd<0))::numeric,2)  gloss,
      round(avg(pnl_usd) FILTER(WHERE pnl_usd>0)::numeric,2)       avgwin,
      round(avg(pnl_usd) FILTER(WHERE pnl_usd<0)::numeric,2)       avgloss,
      round(avg(extract(epoch from (closed_at-opened_at))/86400)::numeric,1) avg_hold_days
    FROM bot_advance_trades
    WHERE bot_id=4 AND account_source='alpaca_paper' AND status='closed'
      AND entry_rule='insider_director_cluster' AND opened_at >= $1`, [RECONFIG]);

  // 2. Open insider positions
  const { rows: [o] } = await pool.query(`
    SELECT count(*) n, coalesce(round(sum(peak_pnl_usd)::numeric,2),0) peak
    FROM bot_advance_trades WHERE bot_id=4 AND status IN ('open','pending')`);

  // 3. Account equity (ground truth)
  let equity = '—', acctLine = '';
  try {
    const B = 'https://paper-api.alpaca.markets';
    const a = await (await fetch(B + '/v2/account', { headers: {
      'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
    } })).json();
    equity = n(a.equity, 0);
    acctLine = `\n💰 Account equity: $${equity} (cash $${n(a.cash,0)})`;
  } catch { /* best-effort */ }

  const trades = Number(s.n) || 0;
  const winPct = trades ? Math.round(100 * Number(s.wins) / trades) : null;
  const pf = (s.gloss && Number(s.gloss) > 0) ? (Number(s.gwin || 0) / Number(s.gloss)) : null;

  let body;
  if (trades === 0) {
    body = `🔎 <b>Insider bot — weekly check-in</b>\n\nNo closed insider trades yet since ${RECONFIG}.\n`
         + `That's expected — insider *cluster* signals (2+ Director/10%-owner buys ≥$100K) are rare, `
         + `and holds are ~20 days. ${Number(o.n)} position(s) currently open.${acctLine}`;
  } else {
    const grade = (pf == null)
      ? (Number(s.net) > 0 ? '✅ on track (no losses yet)' : '🟡 early')
      : (pf >= 2 ? '✅ on track' : pf >= 1 ? '🟡 marginal' : '🔴 losing');
    body = `🔎 <b>Insider bot — weekly check-in</b>  ${grade}\n`
      + `<i>(insider-only, since ${RECONFIG})</i>\n\n`
      + `📊 Closed trades: <b>${trades}</b>  |  Win rate: <b>${winPct}%</b>\n`
      + `⚖️ Profit factor: <b>${pf != null ? n(pf) : '—'}</b>  (target &gt; 2)\n`
      + `💵 Net P&L: <b>$${n(s.net)}</b>\n`
      + `   avg win $${n(s.avgwin)} vs avg loss $${n(s.avgloss)}  |  avg hold ${n(s.avg_hold_days,1)}d\n`
      + `📈 Open now: ${Number(o.n)} position(s)${acctLine}\n\n`
      + `<i>Reminder: judge on profit factor, not win rate. ~55% win with big winners is the goal.</i>`;
  }

  // Send Telegram (best-effort)
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (tok && chat) {
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: body, parse_mode: 'HTML' }),
    }).catch(() => {});
  }
  console.log(body.replace(/<[^>]+>/g, ''));
  await pool.end();
}
main().catch(e => { console.error('[insider-weekly] FATAL', e); process.exit(1); });
