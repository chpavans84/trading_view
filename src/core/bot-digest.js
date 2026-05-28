/**
 * src/core/bot-digest.js — daily P&L + activity summary email for bots.
 *
 * Fires at 4:15 PM ET (after market close + EOD fill). User reads with morning
 * coffee in Singapore (~4-5 AM SGT). Single email, all bots, today's activity.
 *
 * Public API:
 *   generateDigest({ dateStr? })  → { subject, html, text }   pure, testable
 *   sendDigest({ dateStr? })      → { sent: boolean, ... }    fires email + telegram
 *
 * Idempotent: safe to call multiple times for the same date; just sends another email.
 */

import { Resend } from 'resend';
import { query, isDbAvailable } from './db.js';
import { sendTelegram } from './telegram.js';

// ─── Data fetch (pure DB reads) ──────────────────────────────────────────────

async function _fetchTodayData(dateStr) {
  // Day window in ET — start/end calculated as the calendar day in NY tz.
  // Postgres handles the conversion via AT TIME ZONE.
  const dayStartSql = `($1::date AT TIME ZONE 'America/New_York')`;
  const dayEndSql   = `(($1::date + INTERVAL '1 day') AT TIME ZONE 'America/New_York')`;

  const { rows: bots } = await query(`
    SELECT id, name, status, broker, capital_usd, cumulative_pnl_usd, current_trade_id
    FROM bots
    WHERE deleted_at IS NULL
    ORDER BY id
  `);

  const { rows: decisionCounts } = await query(`
    SELECT bot_id, action, COUNT(*)::int AS n
    FROM bot_decisions
    WHERE scanned_at >= ${dayStartSql} AND scanned_at < ${dayEndSql}
    GROUP BY bot_id, action
  `, [dateStr]);

  const { rows: topBlockers } = await query(`
    SELECT bot_id,
           split_part(notes, ' ', 1) AS first_token,
           COUNT(*)::int AS n
    FROM bot_decisions
    WHERE scanned_at >= ${dayStartSql} AND scanned_at < ${dayEndSql}
      AND action LIKE 'skip_%'
    GROUP BY bot_id, first_token
    ORDER BY n DESC
  `, [dateStr]);

  const { rows: tradesOpened } = await query(`
    SELECT id, bot_id, symbol, qty, entry_price, account_source
    FROM trades
    WHERE opened_at >= ${dayStartSql} AND opened_at < ${dayEndSql}
    ORDER BY opened_at
  `, [dateStr]);

  const { rows: tradesClosed } = await query(`
    SELECT id, bot_id, symbol, qty, entry_price, exit_price, pnl_usd, pnl_pct, account_source
    FROM trades
    WHERE closed_at >= ${dayStartSql} AND closed_at < ${dayEndSql}
    ORDER BY closed_at
  `, [dateStr]);

  const { rows: openTrades } = await query(`
    SELECT id, bot_id, symbol, qty, entry_price, stop_loss, setup_type, opened_at, account_source
    FROM trades WHERE status='open' ORDER BY id
  `);

  const { rows: sysAlerts } = await query(`
    SELECT id, key, severity, title, created_at
    FROM system_alerts
    WHERE created_at >= ${dayStartSql} AND created_at < ${dayEndSql}
      AND severity IN ('warn', 'critical')
    ORDER BY created_at
  `, [dateStr]);

  return { bots, decisionCounts, topBlockers, tradesOpened, tradesClosed, openTrades, sysAlerts };
}

// ─── HTML rendering ──────────────────────────────────────────────────────────

function _fmtUsd(n)    { const v = Number(n) || 0; return (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2); }
function _fmtPct(n)    { const v = Number(n) || 0; return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
function _color(n)     { const v = Number(n); return v > 0 ? '#16a34a' : v < 0 ? '#dc2626' : '#6b7280'; }
function _esc(s)       { return String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function _summarizeBot(bot, data) {
  const myDec = data.decisionCounts.filter(d => d.bot_id === bot.id);
  const totalScans = myDec.reduce((s, d) => s + d.n, 0);
  const buys       = myDec.find(d => d.action === 'buy')?.n ?? 0;
  const holds      = myDec.find(d => d.action === 'hold')?.n ?? 0;
  const skips      = myDec.filter(d => d.action.startsWith('skip_')).reduce((s, d) => s + d.n, 0);

  const myBlockers = data.topBlockers.filter(b => b.bot_id === bot.id).sort((a, b) => b.n - a.n);
  const topBlocker = myBlockers[0];

  const todayClose = data.tradesClosed.filter(t => t.bot_id === bot.id);
  const todayPnl   = todayClose.reduce((s, t) => s + (Number(t.pnl_usd) || 0), 0);

  const openTrade = data.openTrades.find(t => t.bot_id === bot.id);

  return { totalScans, buys, holds, skips, topBlocker, todayClose, todayPnl, openTrade };
}

export function renderDigestHtml(dateStr, data) {
  const totalPnlToday   = data.tradesClosed.reduce((s, t) => s + (Number(t.pnl_usd) || 0), 0);
  const totalCumPnl     = data.bots.reduce((s, b) => s + (Number(b.cumulative_pnl_usd) || 0), 0);
  const tradesOpenedCnt = data.tradesOpened.length;
  const tradesClosedCnt = data.tradesClosed.length;

  const headlineColor = _color(totalPnlToday);

  // Per-bot rows
  const botRows = data.bots.map(b => {
    const s = _summarizeBot(b, data);
    const statusIcon = b.status === 'active' ? '🟢' : b.status === 'stopped' ? '🛑' : '⏸️';
    const blockerText = s.topBlocker ? `${s.topBlocker.first_token} (${s.topBlocker.n})` : '—';
    const openLine = s.openTrade
      ? `<span style="color:#374151">holding ${_esc(s.openTrade.symbol)} x${s.openTrade.qty} @ $${Number(s.openTrade.entry_price).toFixed(2)}</span>`
      : '<span style="color:#9ca3af">—</span>';
    const todayPnlStr = s.todayClose.length
      ? `<span style="color:${_color(s.todayPnl)};font-weight:600">${_fmtUsd(s.todayPnl)}</span> (${s.todayClose.length} closed)`
      : '<span style="color:#9ca3af">no closes</span>';

    return `<tr style="border-bottom:1px solid #e5e7eb">
      <td style="padding:8px">${statusIcon} <b>${_esc(b.name)}</b><br><span style="color:#6b7280;font-size:0.85em">#${b.id} • ${_esc(b.broker)}</span></td>
      <td style="padding:8px;text-align:right;color:${_color(b.cumulative_pnl_usd)};font-weight:600">${_fmtUsd(b.cumulative_pnl_usd)}</td>
      <td style="padding:8px;text-align:right">${todayPnlStr}</td>
      <td style="padding:8px;text-align:right">${s.totalScans} scans<br><span style="color:#6b7280;font-size:0.85em">${s.buys} buy · ${s.holds} hold · ${s.skips} skip</span></td>
      <td style="padding:8px;color:#dc2626;font-size:0.85em">${_esc(blockerText)}</td>
      <td style="padding:8px;font-size:0.85em">${openLine}</td>
    </tr>`;
  }).join('');

  // Trade events
  const openedRows = data.tradesOpened.map(t => `<li>🟢 #${t.id} bot ${t.bot_id} OPEN ${_esc(t.symbol)} x${t.qty} @ $${Number(t.entry_price).toFixed(2)} (${_esc(t.account_source)})</li>`).join('');
  const closedRows = data.tradesClosed.map(t => {
    const c = _color(t.pnl_usd);
    return `<li>🔴 #${t.id} bot ${t.bot_id} CLOSE ${_esc(t.symbol)} x${t.qty} @ $${Number(t.exit_price).toFixed(2)} <b style="color:${c}">${_fmtUsd(t.pnl_usd)} (${_fmtPct(t.pnl_pct)})</b></li>`;
  }).join('');

  // System alerts
  const alertRows = data.sysAlerts.map(a =>
    `<li style="color:${a.severity === 'critical' ? '#dc2626' : '#d97706'}">${a.severity === 'critical' ? '🚨' : '⚠️'} <b>${_esc(a.title)}</b> <code style="background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:0.85em">${_esc(a.key)}</code></li>`
  ).join('') || '<li style="color:#9ca3af">No warn/critical alerts today.</li>';

  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:780px;margin:0 auto;color:#1a1a2e;padding:24px">
    <h2 style="margin:0 0 4px">TradingBot Daily — ${dateStr}</h2>
    <p style="color:#6b7280;margin:0 0 18px;font-size:0.9em">Generated at market close (4:15 PM ET) • paper trading only</p>

    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:20px">
      <div style="display:flex;gap:24px;flex-wrap:wrap">
        <div><div style="color:#6b7280;font-size:0.85em">Today's realized P&amp;L</div><div style="font-size:1.6em;font-weight:700;color:${headlineColor}">${_fmtUsd(totalPnlToday)}</div></div>
        <div><div style="color:#6b7280;font-size:0.85em">Cumulative</div><div style="font-size:1.4em;font-weight:600;color:${_color(totalCumPnl)}">${_fmtUsd(totalCumPnl)}</div></div>
        <div><div style="color:#6b7280;font-size:0.85em">Trades today</div><div style="font-size:1.4em;font-weight:600">${tradesOpenedCnt} open · ${tradesClosedCnt} close</div></div>
        <div><div style="color:#6b7280;font-size:0.85em">Open positions</div><div style="font-size:1.4em;font-weight:600">${data.openTrades.length}</div></div>
      </div>
    </div>

    <h3 style="margin:24px 0 8px;color:#374151">Bots</h3>
    <table style="width:100%;border-collapse:collapse;font-size:0.9em;border:1px solid #e5e7eb">
      <thead style="background:#f3f4f6"><tr>
        <th style="padding:8px;text-align:left">Bot</th>
        <th style="padding:8px;text-align:right">Cumulative P&amp;L</th>
        <th style="padding:8px;text-align:right">Today</th>
        <th style="padding:8px;text-align:right">Activity</th>
        <th style="padding:8px;text-align:left">Top blocker</th>
        <th style="padding:8px;text-align:left">Position</th>
      </tr></thead>
      <tbody>${botRows}</tbody>
    </table>

    <h3 style="margin:24px 0 8px;color:#374151">Trade events</h3>
    ${data.tradesOpened.length ? `<p style="color:#6b7280;font-size:0.9em">Opens:</p><ul style="font-size:0.9em">${openedRows}</ul>` : ''}
    ${data.tradesClosed.length ? `<p style="color:#6b7280;font-size:0.9em">Closes:</p><ul style="font-size:0.9em">${closedRows}</ul>` : ''}
    ${!data.tradesOpened.length && !data.tradesClosed.length ? '<p style="color:#9ca3af;font-size:0.9em">No trades today.</p>' : ''}

    <h3 style="margin:24px 0 8px;color:#374151">System alerts</h3>
    <ul style="font-size:0.9em">${alertRows}</ul>

    <p style="color:#9ca3af;font-size:0.8em;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:12px">
      Auto-generated by bot-digest cron. Stop a bot with <code>npm run bot:stop &lt;id&gt;</code>. Not financial advice.
    </p>
  </body></html>`;
}

export function renderDigestText(dateStr, data) {
  const totalPnlToday = data.tradesClosed.reduce((s, t) => s + (Number(t.pnl_usd) || 0), 0);
  const lines = [`TradingBot Daily — ${dateStr}`, '─'.repeat(50)];
  lines.push(`Today's P&L: ${_fmtUsd(totalPnlToday)} | Trades: ${data.tradesOpened.length} open, ${data.tradesClosed.length} close`);
  lines.push('');
  for (const b of data.bots) {
    const s = _summarizeBot(b, data);
    lines.push(`bot ${b.id} ${b.name} (${b.status})`);
    lines.push(`  cum=${_fmtUsd(b.cumulative_pnl_usd)}  today=${s.todayClose.length ? _fmtUsd(s.todayPnl) : '—'}  scans=${s.totalScans}  position=${s.openTrade ? s.openTrade.symbol : '—'}`);
  }
  if (data.sysAlerts.length) {
    lines.push('', 'Alerts:');
    data.sysAlerts.forEach(a => lines.push(`  [${a.severity}] ${a.title} (${a.key})`));
  }
  return lines.join('\n');
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build the digest HTML/text/subject for a given date (no I/O side effects).
 * @param {{ dateStr?: string }} opts  dateStr in YYYY-MM-DD (ET), defaults to today-ET
 */
export async function generateDigest({ dateStr } = {}) {
  if (!isDbAvailable()) return { error: 'no_db' };
  const date = dateStr || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const data = await _fetchTodayData(date);
  const subject = `TradingBot Daily — ${date}`;
  const html    = renderDigestHtml(date, data);
  const text    = renderDigestText(date, data);
  return { subject, html, text, data, dateStr: date };
}

/**
 * Generate + send the digest. Sends email via Resend (if configured) and a short
 * Telegram summary. Returns { sent, channels } so caller can log outcomes.
 */
export async function sendDigest({ dateStr } = {}) {
  const out = await generateDigest({ dateStr });
  if (out.error) return out;
  const { subject, html, text, data } = out;

  const channels = { email: false, telegram: false };

  // Email via Resend (same config as system-alerts)
  const apiKey = process.env.RESEND_API;
  const from   = process.env.RESEND_FROM || 'info@dlpinnovations.com';
  const to     = process.env.ALERT_EMAIL || 'info@trading.dlpinnovations.com';
  if (apiKey) {
    try {
      const resend = new Resend(apiKey);
      await resend.emails.send({ from: `Trading Dashboard <${from}>`, to, subject, html });
      channels.email = true;
      console.log(`[bot-digest] email sent to ${to}`);
    } catch (e) {
      console.warn('[bot-digest] email failed:', e.message);
    }
  }

  // Short Telegram summary (skip if no activity)
  const hasActivity = data.tradesOpened.length || data.tradesClosed.length || data.sysAlerts.length;
  if (hasActivity) {
    const totalPnl = data.tradesClosed.reduce((s, t) => s + (Number(t.pnl_usd) || 0), 0);
    const pnlSign  = totalPnl >= 0 ? '+' : '';
    const tgMsg = [
      `📊 <b>Daily ${out.dateStr}</b>`,
      `P&L today: <b>${pnlSign}$${totalPnl.toFixed(2)}</b>`,
      `Trades: ${data.tradesOpened.length} open · ${data.tradesClosed.length} close`,
      data.sysAlerts.length ? `⚠️ ${data.sysAlerts.length} alert(s) fired` : '',
      `Full report sent to email.`,
    ].filter(Boolean).join('\n');
    try {
      const r = await sendTelegram(tgMsg);
      channels.telegram = !!r.sent;
    } catch (e) {
      console.warn('[bot-digest] telegram failed:', e.message);
    }
  }

  return { sent: channels.email || channels.telegram, channels, text };
}
