#!/usr/bin/env node

/**
 * Trading Signal Bot — Telegram
 *
 * Commands:
 *   /start            — welcome + help
 *   /calendar         — all stocks reporting earnings today
 *   /calendar DATE    — earnings on a specific date (YYYY-MM-DD)
 *   /scan SYM SYM ... — scan tickers for upcoming earnings + history
 *   /earnings SYM     — last 4 quarters EPS + revenue for a ticker
 *   /news SYM         — latest news headlines for a ticker
 *   /financials SYM   — income statement (quarterly)
 *   /watchlist        — scan the default watchlist
 *   /help             — command reference
 *
 * Scheduled jobs:
 *   9:00 AM ET Mon–Fri — morning briefing (today's calendar + watchlist scan)
 */

import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';
import {
  getEarningsCalendar,
  scanEarnings,
  getEarnings,
  getSymbolNews,
  getFinancials,
} from '../core/news.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;  // your personal chat ID (set after first /start)

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN env var is required');
  process.exit(1);
}

// Default watchlist — edit this to your stocks
const DEFAULT_WATCHLIST = [
  'MRVL', 'NVDA', 'AMD', 'AAPL', 'MSFT', 'GOOGL', 'META', 'AMZN',
  'TSLA', 'NFLX', 'INTC', 'QCOM', 'MU', 'AVGO', 'TSM', 'SMCI',
];

const bot = new TelegramBot(TOKEN, { polling: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(num, decimals = 2) {
  if (num == null) return 'n/a';
  return Number(num).toFixed(decimals);
}

function fmtRevenue(val) {
  if (val == null) return 'n/a';
  if (val >= 1e9) return `$${(val / 1e9).toFixed(1)}B`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(0)}M`;
  return `$${val}`;
}

function trendIcon(val) {
  if (val == null) return '➖';
  return val > 10 ? '🚀' : val > 0 ? '✅' : val > -10 ? '⚠️' : '🔴';
}

function callTimeIcon(ct) {
  if (!ct) return '';
  return ct === 'BMO' ? '🌅 BMO' : ct === 'AMC' ? '🌙 AMC' : ct;
}

async function send(chatId, text) {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    // Retry without markdown if formatting fails
    try { await bot.sendMessage(chatId, text.replace(/[*_`[\]]/g, '')); } catch (_) {}
  }
}

// ─── Command: /start ──────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  console.log(`Chat ID: ${chatId}`);  // Log so user can set TELEGRAM_CHAT_ID

  await send(chatId, `👋 *Trading Signal Bot is live!*

Your Chat ID is: \`${chatId}\`
Set this as TELEGRAM\\_CHAT\\_ID in your .env file to receive scheduled alerts.

*Commands:*
/calendar — today's earnings calendar
/watchlist — scan your default watchlist
/scan AAPL NVDA MRVL — scan specific tickers
/earnings MRVL — EPS history for a ticker
/news MRVL — latest news headlines
/financials MRVL — income statement
/help — full command list`);
});

// ─── Command: /help ───────────────────────────────────────────────────────────

bot.onText(/\/help/, async (msg) => {
  await send(msg.chat.id, `*Trading Bot Commands*

📅 */calendar* — earnings reporting today
📅 */calendar 2026-04-29* — specific date
🔍 */scan AAPL NVDA MRVL* — upcoming earnings + history
📊 */earnings MRVL* — last 4 quarters EPS/revenue
📰 */news TSLA* — latest headlines
💰 */financials NVDA* — income statement
📋 */watchlist* — scan default watchlist (${DEFAULT_WATCHLIST.length} stocks, 30-day window)

*Scheduled alerts (auto-sent Mon–Fri):*
🌅 9:00 AM ET — morning briefing with today's earnings + watchlist`);
});

// ─── Command: /calendar [date] ────────────────────────────────────────────────

bot.onText(/\/calendar(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const date = match[1]?.trim() || null;
  const label = date || 'today';

  await send(chatId, `⏳ Fetching earnings calendar for ${label}...`);

  try {
    const result = await getEarningsCalendar({ date, limit: 50 });
    if (!result.earnings.length) {
      return send(chatId, `📅 No earnings scheduled for ${result.date} (market may be closed)`);
    }

    // Group by call time
    const bmo = result.earnings.filter(e => e.call_time === 'BMO');
    const amc = result.earnings.filter(e => e.call_time === 'AMC');
    const other = result.earnings.filter(e => e.call_time !== 'BMO' && e.call_time !== 'AMC');

    let text = `📅 *Earnings: ${result.date}* (${result.count} companies)\n\n`;

    if (bmo.length) {
      text += `🌅 *Before Market Open:*\n`;
      for (const e of bmo.slice(0, 10)) {
        const est = e.eps_estimate != null ? `est $${fmt(e.eps_estimate)}` : '';
        const ly = e.eps_last_year != null ? `vs $${fmt(e.eps_last_year)} LY` : '';
        text += `• *${e.symbol}* — ${e.company?.slice(0, 25)} ${est} ${ly}\n`;
      }
      if (bmo.length > 10) text += `  _(+${bmo.length - 10} more)_\n`;
      text += '\n';
    }

    if (amc.length) {
      text += `🌙 *After Market Close:*\n`;
      for (const e of amc.slice(0, 10)) {
        const est = e.eps_estimate != null ? `est $${fmt(e.eps_estimate)}` : '';
        const ly = e.eps_last_year != null ? `vs $${fmt(e.eps_last_year)} LY` : '';
        text += `• *${e.symbol}* — ${e.company?.slice(0, 25)} ${est} ${ly}\n`;
      }
      if (amc.length > 10) text += `  _(+${amc.length - 10} more)_\n`;
      text += '\n';
    }

    if (other.length) {
      text += `⏰ *Time TBD:*\n`;
      for (const e of other.slice(0, 5)) {
        text += `• *${e.symbol}* — ${e.company?.slice(0, 25)}\n`;
      }
    }

    await send(chatId, text);
  } catch (err) {
    await send(chatId, `❌ Error: ${err.message}`);
  }
});

// ─── Command: /scan SYM SYM ... ───────────────────────────────────────────────

bot.onText(/\/scan(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbols = match[1].trim().toUpperCase().split(/[\s,]+/).filter(Boolean);

  if (!symbols.length) return send(chatId, 'Usage: /scan AAPL NVDA MRVL');

  await send(chatId, `🔍 Scanning ${symbols.join(', ')} for upcoming earnings...`);

  try {
    const result = await scanEarnings({ symbols, days_ahead: 30 });

    if (!result.results.length) {
      return send(chatId, `✅ Scanned ${result.scanned} tickers — no earnings in the next 30 days.`);
    }

    let text = `📊 *Earnings Scan* (next 30 days)\n_Scanned ${result.scanned} tickers, found ${result.with_upcoming_earnings}_\n\n`;

    for (const r of result.results) {
      const epsIcon = trendIcon(r.eps_growth_qoq_pct);
      const eps = r.eps_growth_qoq_pct != null ? `EPS ${r.eps_growth_qoq_pct > 0 ? '+' : ''}${fmt(r.eps_growth_qoq_pct, 1)}% QoQ` : '';
      const rev = r.latest_revenue ? `Rev ${fmtRevenue(r.latest_revenue)}` : '';
      const est = r.eps_estimate != null ? `Est $${fmt(r.eps_estimate)}` : '';

      text += `${epsIcon} *${r.symbol}* — ${r.earnings_date} ${callTimeIcon(r.call_time)}\n`;
      text += `  ${[est, eps, rev].filter(Boolean).join(' | ')}\n`;

      if (r.recent_quarters?.length) {
        const q = r.recent_quarters[0];
        text += `  Last: $${fmt(q.eps_actual)} EPS (${q.period} ${q.end_date?.slice(0, 7)})\n`;
      }
      text += '\n';
    }

    await send(chatId, text);
  } catch (err) {
    await send(chatId, `❌ Error: ${err.message}`);
  }
});

// ─── Command: /watchlist ──────────────────────────────────────────────────────

bot.onText(/\/watchlist/, async (msg) => {
  const chatId = msg.chat.id;
  await send(chatId, `🔍 Scanning watchlist (${DEFAULT_WATCHLIST.length} stocks, 30-day window)...`);

  try {
    const result = await scanEarnings({ symbols: DEFAULT_WATCHLIST, days_ahead: 30 });

    if (!result.results.length) {
      return send(chatId, `📋 Watchlist: no earnings in the next 30 days.`);
    }

    let text = `📋 *Watchlist Earnings Scan*\n_${result.with_upcoming_earnings} of ${result.scanned} reporting in 30 days_\n\n`;

    for (const r of result.results) {
      const epsIcon = trendIcon(r.eps_growth_qoq_pct);
      const est = r.eps_estimate != null ? `Est $${fmt(r.eps_estimate)}` : '';
      const eps = r.eps_growth_qoq_pct != null ? `${r.eps_growth_qoq_pct > 0 ? '+' : ''}${fmt(r.eps_growth_qoq_pct, 1)}% QoQ` : '';
      const rev = r.latest_revenue ? fmtRevenue(r.latest_revenue) : '';

      text += `${epsIcon} *${r.symbol}* ${r.earnings_date} ${callTimeIcon(r.call_time)}\n`;
      text += `  ${[est, eps, rev].filter(Boolean).join(' · ')}\n`;
    }

    await send(chatId, text);
  } catch (err) {
    await send(chatId, `❌ Error: ${err.message}`);
  }
});

// ─── Command: /earnings SYM ───────────────────────────────────────────────────

bot.onText(/\/earnings\s+(\S+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].toUpperCase();

  await send(chatId, `📊 Fetching earnings history for *${symbol}*...`);

  try {
    const result = await getEarnings({ symbol });

    let text = `📊 *${symbol} Earnings History*\n`;
    if (result.next_earnings_dates?.length) {
      text += `🗓 Next: ${result.next_earnings_dates[0]}\n`;
    }
    text += '\n';

    for (const q of result.history) {
      const rev = q.revenue ? fmtRevenue(q.revenue) : 'n/a';
      text += `*${q.period} ${q.end_date?.slice(0, 7)}*\n`;
      text += `  EPS: $${fmt(q.eps_actual)}  |  Rev: ${rev}\n`;
      text += `  Filed: ${q.filed}\n\n`;
    }

    text += `_Source: SEC EDGAR XBRL_`;
    await send(chatId, text);
  } catch (err) {
    await send(chatId, `❌ ${symbol}: ${err.message}`);
  }
});

// ─── Command: /news SYM ───────────────────────────────────────────────────────

bot.onText(/\/news\s+(\S+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].toUpperCase();

  await send(chatId, `📰 Fetching news for *${symbol}*...`);

  try {
    const result = await getSymbolNews({ symbol, limit: 5 });

    let text = `📰 *${symbol} — Latest News*\n\n`;
    for (const a of result.articles) {
      const date = a.published?.slice(0, 10);
      text += `• [${a.title}](${a.url})\n`;
      text += `  _${a.publisher} · ${date}_\n\n`;
    }

    await send(chatId, text);
  } catch (err) {
    await send(chatId, `❌ ${symbol}: ${err.message}`);
  }
});

// ─── Command: /financials SYM ─────────────────────────────────────────────────

bot.onText(/\/financials\s+(\S+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].toUpperCase();

  await send(chatId, `💰 Fetching financials for *${symbol}*...`);

  try {
    const result = await getFinancials({ symbol });

    let text = `💰 *${symbol} Financials* (quarterly)\n`;
    if (result.revenue_growth_yoy_pct != null) {
      text += `YoY Revenue Growth: ${trendIcon(result.revenue_growth_yoy_pct)} ${result.revenue_growth_yoy_pct > 0 ? '+' : ''}${fmt(result.revenue_growth_yoy_pct)}%\n`;
    }
    text += '\n';

    for (const s of result.statements) {
      text += `*${s.end_date}*\n`;
      text += `  Rev: ${fmtRevenue(s.revenue)}  |  Net: ${fmtRevenue(s.net_income)}\n`;
      if (s.eps_diluted != null) text += `  EPS: $${fmt(s.eps_diluted)}`;
      if (s.profit_margin_pct != null) text += `  |  Margin: ${fmt(s.profit_margin_pct)}%`;
      text += '\n\n';
    }

    await send(chatId, text);
  } catch (err) {
    await send(chatId, `❌ ${symbol}: ${err.message}`);
  }
});

// ─── Scheduled: Morning Briefing (9 AM ET, Mon–Fri) ──────────────────────────

async function sendMorningBriefing(chatId) {
  console.log(`Sending morning briefing to ${chatId}`);
  const today = new Date().toISOString().split('T')[0];

  try {
    // Today's earnings calendar
    const cal = await getEarningsCalendar({ date: today, limit: 30 });
    const notable = cal.earnings.filter(e => e.num_estimates >= 3);  // analyst-covered companies

    let text = `☀️ *Good morning! Earnings Briefing — ${today}*\n\n`;

    if (notable.length) {
      text += `📅 *Reporting today (${notable.length} analyst-covered):*\n`;
      const bmo = notable.filter(e => e.call_time === 'BMO').slice(0, 8);
      const amc = notable.filter(e => e.call_time === 'AMC').slice(0, 8);

      if (bmo.length) {
        text += `🌅 BMO: ${bmo.map(e => `*${e.symbol}*`).join(', ')}\n`;
      }
      if (amc.length) {
        text += `🌙 AMC: ${amc.map(e => `*${e.symbol}*`).join(', ')}\n`;
      }
      text += '\n';
    } else {
      text += `📅 No major earnings today.\n\n`;
    }

    // Watchlist scan
    const scan = await scanEarnings({ symbols: DEFAULT_WATCHLIST, days_ahead: 7 });
    if (scan.results.length) {
      text += `📋 *Watchlist — reporting this week:*\n`;
      for (const r of scan.results) {
        text += `• *${r.symbol}* — ${r.earnings_date} ${callTimeIcon(r.call_time)}`;
        if (r.eps_estimate != null) text += ` (est $${fmt(r.eps_estimate)})`;
        text += '\n';
      }
    }

    await send(chatId, text);
  } catch (err) {
    await send(chatId, `⚠️ Morning briefing error: ${err.message}`);
  }
}

// Schedule: 9:00 AM ET = 13:00 UTC (or 14:00 UTC during EDT)
// Using 13:00 UTC which covers most of year; adjust for daylight saving if needed
cron.schedule('0 13 * * 1-5', () => {
  if (CHAT_ID) sendMorningBriefing(CHAT_ID);
  else console.log('TELEGRAM_CHAT_ID not set — skipping scheduled briefing');
});

// ─── Catch-all for unknown commands ───────────────────────────────────────────

bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return;  // handled by onText above
  const chatId = msg.chat.id;
  // Echo chat ID (useful for first-time setup)
  if (msg.text?.toLowerCase().includes('chat id') || msg.text?.toLowerCase().includes('chatid')) {
    await send(chatId, `Your Chat ID is: \`${chatId}\``);
  }
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

console.log('🤖 Trading Signal Bot started. Waiting for messages...');
console.log('📋 Default watchlist:', DEFAULT_WATCHLIST.join(', '));
