/**
 * src/core/daily-bot-report.js
 *
 * Sends a "what did the bots do today" email at 5:00 PM ET on weekdays.
 *
 * Per-bot summary:
 *  - Total scans · trades placed
 *  - Realized P&L today (from trades closed today)
 *  - Unrealized P&L on open position (if any)
 *  - Top blocker (reason most scans were skipped)
 *  - Near-misses (score ≥ 50 but below threshold)
 *
 * Uses the same Resend integration as sentinel.js.
 * No LLM calls — pure data, no API cost.
 *
 * Added 2026-05-24 (G.2 task).
 */

import { Resend }              from 'resend';
import { query }               from './db.js';
import { getSentinelRecipients } from './db.js';

// ─── Build per-user, per-bot summary from DB ──────────────────────────────────

async function _fetchDailyData(userId) {
  // Today midnight ET
  const sinceClause = `(NOW() AT TIME ZONE 'America/New_York')::date::timestamptz AT TIME ZONE 'America/New_York'`;

  // All bots for this user (excluding archived)
  const { rows: bots } = await query(
    `SELECT id, name, status, broker, capital_usd FROM bots WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id`,
    [userId]
  );
  if (!bots.length) return null;

  const botIds = bots.map(b => b.id);

  // Today's decisions for all bots
  const { rows: decisions } = await query(
    `SELECT bot_id, action, notes, composite_score, symbol
     FROM bot_decisions
     WHERE bot_id = ANY($1) AND scanned_at >= ${sinceClause}
     ORDER BY bot_id, scanned_at`,
    [botIds]
  );

  // Today's trades (both opened and closed today)
  const { rows: trades } = await query(
    `SELECT bot_id, symbol, status, pnl_usd, entry_price, exit_price, qty,
            opened_at, closed_at, setup_type
     FROM trades
     WHERE bot_id = ANY($1)
       AND (opened_at >= ${sinceClause} OR closed_at >= ${sinceClause})
     ORDER BY bot_id, opened_at`,
    [botIds]
  );

  // Build per-bot stats
  return bots.map(bot => {
    const botDecs   = decisions.filter(d => d.bot_id === bot.id);
    const botTrades = trades.filter(t => t.bot_id === bot.id);

    const totalScans = botDecs.length;
    const buys       = botDecs.filter(d => d.action === 'buy').length;
    const openTrade  = botTrades.find(t => t.status === 'open');
    const closedToday = botTrades.filter(t => t.status === 'closed' && t.closed_at >= new Date(Date.now() - 86400000));
    const realizedPnl = closedToday.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);

    // Top blocker
    const skipDecs = botDecs.filter(d => d.action !== 'buy');
    const blockerCounts = {};
    const nearMisses = [];
    for (const d of skipDecs) {
      const n = (d.notes || '').toLowerCase();
      let key;
      if (d.action === 'skip_no_candidate' && d.composite_score != null) {
        key = +d.composite_score >= 50 ? 'near_miss' : 'score_too_low';
        if (+d.composite_score >= 50) nearMisses.push({ symbol: d.symbol, score: +d.composite_score });
      } else if (n.includes('no classifiable') || d.action === 'skip_unclassifiable_setup') {
        key = 'no_setup_match';
      } else if (n.includes('filtered') || d.action === 'skip_filtered') {
        key = 'hard_gate';
      } else if (n.includes('empty universe')) {
        key = 'empty_universe';
      } else if (d.action === 'skip_circuit_breaker') {
        key = 'circuit_breaker';
      } else {
        key = d.action;
      }
      blockerCounts[key] = (blockerCounts[key] || 0) + 1;
    }
    const topBlockerEntry = Object.entries(blockerCounts).sort((a, b) => b[1] - a[1])[0];
    const topBlockerLabel = {
      near_miss:      'near-miss (score ≥ 50 but below threshold)',
      score_too_low:  'score below threshold',
      no_setup_match: 'no matching setup',
      hard_gate:      'hard gate blocked (earnings/VIX/liquidity)',
      empty_universe: 'empty market / no candidates',
      circuit_breaker:'circuit breaker tripped',
    };
    const topBlocker = topBlockerEntry
      ? `${topBlockerLabel[topBlockerEntry[0]] ?? topBlockerEntry[0]} (${topBlockerEntry[1]}x)`
      : null;

    return {
      bot,
      totalScans,
      buys,
      openTrade,
      realizedPnl,
      closedTodayCount: closedToday.length,
      topBlocker,
      nearMisses: nearMisses.slice(0, 3),
    };
  });
}

// ─── HTML email builder ───────────────────────────────────────────────────────

function _buildEmailHtml(allUserData) {
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York',
  });

  const sections = allUserData.map(({ username, botSummaries }) => {
    if (!botSummaries) return '';
    const botBlocks = botSummaries.map(s => {
      const { bot, totalScans, buys, openTrade, realizedPnl, closedTodayCount, topBlocker, nearMisses } = s;
      const statusColor = bot.status === 'active' ? '#3fb950' : bot.status === 'paused' ? '#e3b341' : '#f85149';
      const pnlColor    = realizedPnl >= 0 ? '#3fb950' : '#f85149';
      const pnlStr      = realizedPnl === 0 ? '$0.00' : `${realizedPnl > 0 ? '+' : ''}$${Math.abs(realizedPnl).toFixed(2)}`;

      const nearMissHtml = nearMisses.length
        ? `<div style="margin-top:6px;color:#e3b341;font-size:0.82em">🟡 Near-misses: ${nearMisses.map(m => `${m.symbol} (${m.score.toFixed(1)})`).join(', ')}</div>`
        : '';
      const openPosHtml = openTrade
        ? `<div style="margin-top:6px;padding:8px;background:#0d1117;border-radius:4px;font-size:0.82em;color:#c9d1d9">
             📌 Open position: <strong style="color:#58a6ff">${openTrade.symbol}</strong>
             · ${openTrade.qty} shares @ $${Number(openTrade.entry_price).toFixed(2)}
             · ${openTrade.setup_type ?? '—'}
           </div>`
        : '';

      return `<div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div>
            <span style="font-weight:700;color:#e6edf3">${_esc(bot.name)}</span>
            <span style="margin-left:8px;background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44;border-radius:4px;padding:1px 7px;font-size:0.75em;font-weight:600">${_esc(bot.status)}</span>
          </div>
          <div style="color:#8b949e;font-size:0.8em">${_esc(bot.broker ?? 'alpaca')}</div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:0.85em">
          <tr>
            <td style="padding:3px 0;color:#8b949e;width:150px">Scans today</td>
            <td style="color:#e6edf3;font-weight:600">${totalScans}</td>
          </tr>
          <tr>
            <td style="padding:3px 0;color:#8b949e">Trades placed</td>
            <td style="color:${buys > 0 ? '#3fb950' : '#8b949e'};font-weight:600">${buys}</td>
          </tr>
          ${closedTodayCount > 0 ? `
          <tr>
            <td style="padding:3px 0;color:#8b949e">Realized P&amp;L</td>
            <td style="color:${pnlColor};font-weight:700">${pnlStr} (${closedTodayCount} closed)</td>
          </tr>` : ''}
          ${topBlocker ? `
          <tr>
            <td style="padding:3px 0;color:#8b949e">Top blocker</td>
            <td style="color:#c9d1d9">${_esc(topBlocker)}</td>
          </tr>` : ''}
        </table>
        ${nearMissHtml}
        ${openPosHtml}
      </div>`;
    }).join('');

    return `<div style="margin-bottom:24px">
      <div style="font-size:0.75em;color:#8b949e;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em">Account: ${_esc(username)}</div>
      ${botBlocks}
    </div>`;
  }).join('');

  const totalTrades = allUserData.flatMap(u => u.botSummaries ?? []).reduce((s, b) => s + b.buys, 0);
  const totalPnl    = allUserData.flatMap(u => u.botSummaries ?? []).reduce((s, b) => s + b.realizedPnl, 0);
  const heroColor   = totalPnl >= 0 ? '#3fb950' : '#f85149';
  const heroStr     = totalPnl === 0 ? '$0.00' : `${totalPnl >= 0 ? '+' : '-'}$${Math.abs(totalPnl).toFixed(2)}`;

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;background:#0d1117;color:#c9d1d9;border-radius:12px;overflow:hidden">
      <!-- Header -->
      <div style="background:#161b22;border-bottom:1px solid #30363d;padding:20px 24px">
        <div style="font-size:1.2em;font-weight:700;color:#e6edf3">🤖 Daily Bot Report</div>
        <div style="color:#8b949e;font-size:0.85em;margin-top:3px">${dateStr}</div>
      </div>

      <!-- Hero strip -->
      <div style="display:flex;gap:0;border-bottom:1px solid #30363d">
        <div style="flex:1;padding:14px 24px;border-right:1px solid #30363d;text-align:center">
          <div style="font-size:1.6em;font-weight:700;color:#e6edf3">${totalTrades}</div>
          <div style="color:#8b949e;font-size:0.75em;margin-top:2px">TRADES TODAY</div>
        </div>
        <div style="flex:1;padding:14px 24px;text-align:center">
          <div style="font-size:1.6em;font-weight:700;color:${heroColor}">${heroStr}</div>
          <div style="color:#8b949e;font-size:0.75em;margin-top:2px">REALIZED P&amp;L</div>
        </div>
      </div>

      <!-- Bot summaries -->
      <div style="padding:20px 24px">
        ${sections || '<div style="color:#8b949e;text-align:center;padding:16px">No active bots found.</div>'}
      </div>

      <!-- Footer -->
      <div style="background:#161b22;border-top:1px solid #30363d;padding:14px 24px;font-size:0.75em;color:#6e7681;text-align:center">
        Sent by your Trading Bot at 5:00 PM ET · <a href="${process.env.PUBLIC_URL || 'http://localhost:3000'}" style="color:#58a6ff">Open Dashboard</a>
        · <a href="${process.env.PUBLIC_URL || 'http://localhost:3000'}/api/daily-bot-report/unsubscribe" style="color:#6e7681">Unsubscribe</a>
      </div>
    </div>`;
}

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runDailyBotReport() {
  const apiKey = process.env.RESEND_API;
  const from   = process.env.RESEND_FROM || 'info@dlpinnovations.com';

  if (!apiKey) {
    console.warn('[daily-bot-report] RESEND_API not configured — skipping email');
    return { skipped: true, reason: 'no_resend_api' };
  }

  // Load recipients (all users with alerts enabled)
  let recipients = await getSentinelRecipients();
  if (!recipients.length) {
    const fallback = process.env.ALERT_EMAIL;
    if (!fallback) { console.warn('[daily-bot-report] no recipients'); return { skipped: true, reason: 'no_recipients' }; }
    recipients = [{ username: 'admin', email: fallback }];
  }

  // Build data for each unique user
  // Group recipients by username (each may have a user_id via DB join later)
  // For simplicity: getSentinelRecipients returns { username, email, user_id? }
  const { rows: userRows } = await query(
    `SELECT DISTINCT ON (u.username) u.id AS user_id, u.username, u.email
     FROM users u
     WHERE u.email = ANY($1) AND u.email IS NOT NULL`,
    [recipients.map(r => r.email)]
  );

  const allUserData = await Promise.all(
    userRows.map(async u => {
      try {
        const botSummaries = await _fetchDailyData(u.user_id);
        return { username: u.username, email: u.email, botSummaries };
      } catch (e) {
        console.error(`[daily-bot-report] data fetch failed for ${u.username}:`, e.message);
        return { username: u.username, email: u.email, botSummaries: null };
      }
    })
  );

  // Send one email per recipient (each sees only their own bots)
  const resend = new Resend(apiKey);
  let sentCount = 0;

  for (const userData of allUserData) {
    if (!userData.email) continue;
    try {
      const html    = _buildEmailHtml([userData]);
      const subject = `🤖 Bot Report ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}`;
      await resend.emails.send({ from: `Trading Bot <${from}>`, to: userData.email, subject, html });
      console.log(`[daily-bot-report] sent to ${userData.email} (${userData.username})`);
      sentCount++;
    } catch (e) {
      console.error(`[daily-bot-report] email failed for ${userData.email}:`, e.message);
    }
  }

  return { ok: true, sentCount, recipients: userRows.length };
}
