#!/usr/bin/env node

/**
 * AI Trading Analyst Bot — Telegram + Claude
 *
 * An interactive analyst that reads news, connects geopolitical/macro events
 * to specific stocks, and gives actionable trade ideas with entry/target/stop.
 *
 * Just chat naturally:
 *   "What's the impact of the trade war on semiconductors?"
 *   "Should I buy MRVL before earnings?"
 *   "What defense stocks benefit from the Middle East situation?"
 *   "Scan my watchlist for opportunities this week"
 */

import TelegramBot from 'node-telegram-bot-api';
import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import {
  getEarningsCalendar,
  scanEarnings,
  getEarnings,
  getSymbolNews,
  getFinancials,
} from '../core/news.js';
import {
  getMarketSentiment,
  getSectorPerformance,
  getTrendingStocks,
  getDayTradingDashboard,
} from '../core/sentiment.js';
import {
  getAccount,
  getPositions,
  getOrders,
  placeTrade,
  closePosition,
  getMarketStatus,
} from '../core/trader.js';

// Pending trade approvals: orderId → { trade, timer, chatId }
const pendingTrades = new Map();

// ─── Config ───────────────────────────────────────────────────────────────────

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!TOKEN || !ANTHROPIC_KEY) {
  console.error('TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY are required');
  process.exit(1);
}

const DEFAULT_WATCHLIST = [
  'MRVL', 'NVDA', 'AMD', 'AAPL', 'MSFT', 'GOOGL', 'META', 'AMZN',
  'TSLA', 'NFLX', 'INTC', 'QCOM', 'MU', 'AVGO', 'TSM', 'SMCI',
  'RTX', 'LMT', 'XOM', 'JPM',
];

const bot = new TelegramBot(TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// Per-chat conversation history (in-memory, resets on bot restart)
const chatHistory = new Map();

// ─── Usage Tracker (persisted to disk) ───────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATS_FILE = join(__dirname, '../../.bot-stats.json');

// Claude Haiku pricing (per million tokens)
const PRICE_INPUT_PER_M  = 0.80;
const PRICE_OUTPUT_PER_M = 4.00;

function loadStats() {
  try {
    if (existsSync(STATS_FILE)) return JSON.parse(readFileSync(STATS_FILE, 'utf8'));
  } catch (_) {}
  return {
    totalMessages: 0,
    totalToolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    dailyInputTokens: 0,
    dailyOutputTokens: 0,
    dailyMessages: 0,
    lastResetDate: new Date().toISOString().split('T')[0],
  };
}

function saveStats() {
  try { writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); } catch (_) {}
}

const stats = { startTime: new Date(), ...loadStats() };

function trackUsage(response) {
  const u = response.usage;
  if (!u) return;
  stats.inputTokens        += u.input_tokens  || 0;
  stats.outputTokens       += u.output_tokens || 0;
  stats.dailyInputTokens   += u.input_tokens  || 0;
  stats.dailyOutputTokens  += u.output_tokens || 0;
  stats.totalToolCalls     += (response.content || []).filter(b => b.type === 'tool_use').length;
  saveStats();
}

function resetDailyIfNeeded() {
  const today = new Date().toISOString().split('T')[0];
  if (today !== stats.lastResetDate) {
    stats.dailyInputTokens  = 0;
    stats.dailyOutputTokens = 0;
    stats.dailyMessages     = 0;
    stats.lastResetDate     = today;
    saveStats();
  }
}

function calcCost(inputTok, outputTok) {
  return (inputTok / 1e6) * PRICE_INPUT_PER_M + (outputTok / 1e6) * PRICE_OUTPUT_PER_M;
}

function uptimeStr() {
  const ms = Date.now() - new Date(stats.startTime).getTime();
  const h  = Math.floor(ms / 3600000);
  const m  = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── Claude Tools (what Claude can call to fetch live data) ───────────────────

const TOOLS = [
  {
    name: 'get_news',
    description: 'Get latest news headlines for a stock symbol or topic from Yahoo Finance. Use this to find recent events affecting a company or sector.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Stock ticker or search term, e.g. "NVDA", "defense stocks", "oil"' },
        limit: { type: 'number', description: 'Number of articles (default 8)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_earnings',
    description: 'Get last 4 quarters of EPS actuals, revenue, and next earnings date for a stock from SEC EDGAR.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Stock ticker, e.g. "MRVL"' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_financials',
    description: 'Get income statement: revenue, net income, EPS, profit margins, YoY revenue growth for a stock.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Stock ticker' },
        period: { type: 'string', enum: ['quarterly', 'annual'], description: 'quarterly (default) or annual' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_earnings_calendar',
    description: 'Get all companies reporting earnings on a specific date. Use this to find upcoming catalysts.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today.' },
      },
    },
  },
  {
    name: 'scan_watchlist',
    description: 'Scan a list of stock symbols for upcoming earnings in the next N days, with EPS history and revenue trends.',
    input_schema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of tickers. If not provided, scans the default watchlist.',
        },
        days_ahead: { type: 'number', description: 'Days to look ahead (default 14)' },
      },
    },
  },
  {
    name: 'get_market_sentiment',
    description: 'Get current market sentiment: VIX fear/greed level, S&P500/Nasdaq/Dow performance, ES and NQ futures direction. Use this for any day trading question or when asked about market mood.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_sector_performance',
    description: 'Get today\'s performance for all 11 S&P sectors plus gold, bonds, and the dollar. Shows which sectors are leading/lagging and detects risk-on vs risk-off rotation.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_trending_stocks',
    description: 'Get the most searched/trending stocks on Yahoo Finance right now with their price changes. Shows where retail attention and volume is focused today.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of trending stocks to return (default 15)' },
      },
    },
  },
  {
    name: 'get_day_trading_dashboard',
    description: 'Full day trading dashboard in one call: market sentiment (VIX, fear/greed), all sector performance with rotation signal, and trending stocks. Use this when asked about day trading conditions or "what\'s the market doing today".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_portfolio',
    description: 'Get current paper trading portfolio: account balance, buying power, and all open positions with unrealized P&L.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'propose_trade',
    description: 'Propose a trade to the user for approval. The user gets 5 minutes to cancel — otherwise it executes automatically. Use this when you have a high-conviction trade idea backed by earnings data and sentiment.',
    input_schema: {
      type: 'object',
      properties: {
        symbol:          { type: 'string',  description: 'Ticker symbol e.g. "MRVL"' },
        side:            { type: 'string',  enum: ['buy', 'sell'], description: 'buy or sell' },
        dollars:         { type: 'number',  description: 'Dollar amount to invest (e.g. 200)' },
        stop_loss_pct:   { type: 'number',  description: 'Stop loss % below entry (default 7)' },
        take_profit_pct: { type: 'number',  description: 'Take profit % above entry (default 12)' },
        reasoning:       { type: 'string',  description: 'Why this trade — shown to user for approval' },
      },
      required: ['symbol', 'side', 'dollars', 'reasoning'],
    },
  },
  {
    name: 'close_position',
    description: 'Close (sell) an open position immediately at market price.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker to close' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_market_status',
    description: 'Check if the US stock market is currently open or closed, and when it next opens/closes.',
    input_schema: { type: 'object', properties: {} },
  },
];

// ─── Tool Executor ────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  try {
    switch (name) {
      case 'get_news':
        return await getSymbolNews({ symbol: input.symbol, limit: input.limit || 8 });
      case 'get_earnings':
        return await getEarnings({ symbol: input.symbol });
      case 'get_financials':
        return await getFinancials({ symbol: input.symbol, period: input.period || 'quarterly' });
      case 'get_earnings_calendar':
        return await getEarningsCalendar({ date: input.date, limit: 50 });
      case 'scan_watchlist':
        return await scanEarnings({
          symbols: input.symbols || DEFAULT_WATCHLIST,
          days_ahead: input.days_ahead || 14,
        });
      case 'get_market_sentiment':
        return await getMarketSentiment();
      case 'get_sector_performance':
        return await getSectorPerformance();
      case 'get_trending_stocks':
        return await getTrendingStocks({ limit: input.limit || 15 });
      case 'get_day_trading_dashboard':
        return await getDayTradingDashboard();
      case 'get_portfolio': {
        const [account, positions, orders] = await Promise.all([
          getAccount(), getPositions(), getOrders()
        ]);
        return { account, positions, open_orders: orders };
      }
      case 'propose_trade':
        return await handleProposeTrade(input, _currentChatId);
      case 'close_position':
        return await closePosition(input.symbol);
      case 'get_market_status':
        return await getMarketStatus();
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert trading analyst and portfolio advisor with deep knowledge of:
- Macro economics, geopolitics, and their impact on financial markets
- Sector rotation: how wars, trade conflicts, sanctions, and economic cycles move money between sectors
- Technical analysis and earnings-driven trading
- Risk management (position sizing, stop losses, profit targets)

Your job is to help the user find actionable trade ideas by connecting real-world events to specific stocks.

When analyzing events (wars, tariffs, sanctions, earnings, etc.):
1. Identify WHICH sectors and companies benefit vs. suffer
2. Give SPECIFIC stock tickers with reasoning
3. Provide actionable trade details: entry price range, target price, stop loss, time horizon
4. Explain the catalyst and when to exit

Format your responses for Telegram (keep it clear, use emojis for visual hierarchy):
- 📈 for buy ideas
- 📉 for avoid/sell
- 🎯 for price targets
- ⛔ for stop loss
- 💡 for key insight
- ⚠️ for risk warning
- 🗓 for timing/catalyst

Always use the available tools to fetch REAL current data (news, earnings, financials) before making recommendations.
Never make up financial data — always fetch it.

The user's current watchlist includes: ${DEFAULT_WATCHLIST.join(', ')}
Today's date: ${new Date().toISOString().split('T')[0]}

TRADING ENGINE (Alpaca paper trading — fake money for now):
- Use propose_trade to execute trades IMMEDIATELY and automatically — no approval needed
- ALWAYS check get_market_status first — only trade during open market hours
- ALWAYS check get_portfolio first — max 3 open positions at once
- Default: $200 per trade, stop loss -3%, take profit +7%
- Only trade when you have real data backing the setup: earnings beat, sentiment, sector rotation
- Never trade on speculation alone
- After executing, notify user with full details including stop/target prices

Keep responses concise but actionable. This is Telegram — not a report. Get to the point.`;

// ─── Trade Proposal + Approval Flow ──────────────────────────────────────────

let _currentChatId = CHAT_ID;  // set when a message arrives

// Default trade parameters
const DEFAULT_STOP_LOSS_PCT   = 3;   // -3%
const DEFAULT_TAKE_PROFIT_PCT = 7;   // +7%
const DEFAULT_TRADE_DOLLARS   = 200; // $200 per trade

function nowBothTimezones() {
  const et  = new Date().toLocaleString('en-US', { timeZone: 'America/New_York',    hour: '2-digit', minute: '2-digit', hour12: true });
  const sgt = new Date().toLocaleString('en-SG', { timeZone: 'Asia/Singapore',      hour: '2-digit', minute: '2-digit', hour12: true });
  return `${et} ET (${sgt} SGT)`;
}

async function handleProposeTrade(input, chatId) {
  const stopPct   = input.stop_loss_pct   || DEFAULT_STOP_LOSS_PCT;
  const targetPct = input.take_profit_pct || DEFAULT_TAKE_PROFIT_PCT;
  const dollars   = input.dollars         || DEFAULT_TRADE_DOLLARS;

  try {
    const result = await placeTrade({
      symbol:          input.symbol,
      side:            input.side,
      dollars,
      stop_loss_pct:   stopPct,
      take_profit_pct: targetPct,
      note:            input.reasoning,
    });

    await send(chatId,
      `✅ *Trade Executed Automatically*\n` +
      `🕐 ${nowBothTimezones()}\n\n` +
      `${input.side === 'buy' ? '📈 BOUGHT' : '📉 SOLD'} *${result.symbol}* — ${result.qty} shares\n` +
      `💵 $${result.dollars_invested} @ ~$${result.estimated_price}\n` +
      `⛔ Stop loss: $${result.stop_loss} (-${stopPct}%)\n` +
      `🎯 Take profit: $${result.take_profit} (+${targetPct}%)\n\n` +
      `💡 *Reason:* ${input.reasoning}\n\n` +
      `🆔 Order: \`${result.order_id.slice(0, 8)}...\`\n` +
      `_Paper trading — no real money used_\n\n` +
      `Reply /close\\_${input.symbol} to exit early.`
    );

    return { status: 'executed', ...result };
  } catch (err) {
    await send(chatId, `❌ Trade failed for ${input.symbol}: ${err.message}`);
    return { status: 'failed', error: err.message };
  }
}

// ─── AI Chat Handler ──────────────────────────────────────────────────────────

async function handleAIMessage(chatId, userMessage) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const history = chatHistory.get(chatId);

  // Add user message to history
  history.push({ role: 'user', content: userMessage });

  // Keep last 20 messages to avoid token overflow
  if (history.length > 20) history.splice(0, history.length - 20);

  let messages = [...history];

  // Agentic loop — Claude can call multiple tools before responding
  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    trackUsage(response);

    // If Claude wants to use tools, execute them and continue
    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');

      // Add Claude's response (with tool calls) to messages
      messages.push({ role: 'assistant', content: response.content });

      // Execute all tool calls in parallel
      const toolResults = await Promise.all(
        toolUses.map(async (tu) => ({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(await executeTool(tu.name, tu.input)),
        }))
      );

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Final text response
    const text = response.content.find(b => b.type === 'text')?.text || 'No response';

    // Save final exchange to history
    history.push({ role: 'assistant', content: text });

    return text;
  }
}

// ─── Telegram Message Handler ─────────────────────────────────────────────────

async function send(chatId, text) {
  // Split long messages (Telegram limit is 4096 chars)
  const chunks = [];
  while (text.length > 4000) {
    const split = text.lastIndexOf('\n', 4000);
    chunks.push(text.slice(0, split));
    text = text.slice(split + 1);
  }
  chunks.push(text);

  for (const chunk of chunks) {
    try {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    } catch {
      try { await bot.sendMessage(chatId, chunk); } catch (_) {}
    }
  }
}

async function sendTyping(chatId) {
  try { await bot.sendChatAction(chatId, 'typing'); } catch (_) {}
}

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  await send(msg.chat.id, `👋 *AI Trading Analyst is live!*

Just chat naturally with me. Examples:

💬 _"What's the impact of the US-China trade war on semiconductors?"_
💬 _"Should I buy MRVL before earnings?"_
💬 _"What defense stocks benefit from current geopolitical tensions?"_
💬 _"Scan my watchlist for opportunities this week"_
💬 _"NVDA is down 5% today — buying opportunity or avoid?"_
💬 _"What's reporting earnings tomorrow and what's the setup?"_

I fetch real live data (news, earnings, financials) and give you specific trade ideas with entry, target, and stop loss.

_Powered by Claude AI + SEC EDGAR + Nasdaq_

/stats — API usage & cost dashboard
/clear — reset conversation
/watchlist — show tracked stocks`);
});

bot.onText(/\/clear/, async (msg) => {
  chatHistory.delete(msg.chat.id);
  await send(msg.chat.id, '🧹 Conversation cleared. Fresh start!');
});

bot.onText(/\/watchlist/, async (msg) => {
  await send(msg.chat.id, `📋 Default watchlist:\n${DEFAULT_WATCHLIST.join(', ')}\n\nJust ask me anything about these or any other stocks.`);
});

bot.onText(/\/stats/, async (msg) => {
  resetDailyIfNeeded();
  const totalCost  = calcCost(stats.inputTokens, stats.outputTokens);
  const dailyCost  = calcCost(stats.dailyInputTokens, stats.dailyOutputTokens);
  const totalTok   = stats.inputTokens + stats.outputTokens;
  const dailyTok   = stats.dailyInputTokens + stats.dailyOutputTokens;

  const text = `📊 *Usage Dashboard*

🤖 *Bot*
⏱ Uptime: ${uptimeStr()}
💬 Total messages: ${stats.totalMessages}
🔧 Tool calls made: ${stats.totalToolCalls}
📅 Today's messages: ${stats.dailyMessages}

🧠 *Claude API (Haiku)*
📥 Input tokens — today: ${stats.dailyInputTokens.toLocaleString()} | total: ${stats.inputTokens.toLocaleString()}
📤 Output tokens — today: ${stats.dailyOutputTokens.toLocaleString()} | total: ${stats.outputTokens.toLocaleString()}
🔢 Total tokens — today: ${dailyTok.toLocaleString()} | total: ${totalTok.toLocaleString()}

💰 *Cost Estimate*
📅 Today: $${dailyCost.toFixed(4)}
📦 This session: $${totalCost.toFixed(4)}
💳 Pricing: $0.80/M input · $4.00/M output

_Resets daily at midnight. Session data lost on restart._`;

  await send(msg.chat.id, text);
});

// Close a position early
bot.onText(/\/close_(\S+)/, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  await sendTyping(msg.chat.id);
  try {
    const result = await closePosition(symbol);
    await send(msg.chat.id, `✅ Closed *${symbol}* position (${result.qty} shares)`);
  } catch (err) {
    await send(msg.chat.id, `❌ Could not close ${symbol}: ${err.message}`);
  }
});

// All other messages → AI (including unrecognised slash commands)
bot.on('message', async (msg) => {
  if (!msg.text) return;
  const knownCmds = ['/start', '/clear', '/watchlist', '/stats', '/close_'];
  if (knownCmds.some(cmd => msg.text.startsWith(cmd))) return;

  const chatId = msg.chat.id;
  _currentChatId = chatId;
  const userText = msg.text.trim();

  resetDailyIfNeeded();
  stats.totalMessages++;
  stats.dailyMessages++;

  // Show typing indicator
  await sendTyping(chatId);

  // Keep typing indicator alive for long requests
  const typingInterval = setInterval(() => sendTyping(chatId), 4000);

  try {
    const reply = await handleAIMessage(chatId, userText);
    clearInterval(typingInterval);
    await send(chatId, reply);
  } catch (err) {
    clearInterval(typingInterval);
    console.error('AI error:', err.message);
    await send(chatId, `⚠️ Error: ${err.message}`);
  }
});

// ─── Scheduled: Morning Briefing (9 AM ET, Mon–Fri) ──────────────────────────

async function sendMorningBriefing() {
  if (!CHAT_ID) return;
  console.log('Sending morning briefing...');

  const today = new Date().toISOString().split('T')[0];
  const prompt = `Good morning! Please give me:
1. Today's most important earnings (${today}) — who's reporting and what's the setup
2. Any major macro/geopolitical news from the last 24 hours that could move markets
3. Top 1-2 trade ideas from my watchlist for this week
Keep it brief and actionable.`;

  try {
    await sendTyping(CHAT_ID);
    const briefing = await handleAIMessage(CHAT_ID, prompt);
    await send(CHAT_ID, `☀️ *Morning Briefing — ${today}*\n🕐 9:00 AM ET (9:00 PM SGT)\n\n${briefing}`);
  } catch (err) {
    await send(CHAT_ID, `⚠️ Morning briefing failed: ${err.message}`);
  }
}

// 9:00 AM ET (9:00 PM SGT) = 13:00 UTC — morning briefing
cron.schedule('0 13 * * 1-5', sendMorningBriefing);

// Auto-scanner: every hour 10 AM–3 PM ET (10 PM–3 AM SGT) = 14:00–19:00 UTC Mon–Fri
cron.schedule('0 14-19 * * 1-5', async () => {
  if (!CHAT_ID) return;
  console.log('Running auto-scan for trade opportunities...');
  try {
    const prompt = `AUTOMATED TRADE SCAN — take these steps in order:

1. Call get_market_status → if market is closed, STOP (send nothing)
2. Call get_portfolio → if already 3+ open positions, STOP (send nothing)
3. Call get_market_sentiment → note VIX. If VIX > 30, STOP (too volatile)
4. Call get_sector_performance → identify leading sectors
5. Call scan_watchlist for the default watchlist (30-day window)
6. Pick the SINGLE best setup from the scan results — earnings beat, leading sector, positive sentiment all help
7. If a valid setup exists: CALL propose_trade immediately with that symbol. Do NOT describe the trade in text first — just execute it.
8. If no setup meets the bar, send nothing at all.

IMPORTANT: Your job in this scan is to EXECUTE, not to recommend. If you find a good setup, call propose_trade. If you write a recommendation without calling propose_trade, you have failed the task.`;
    _currentChatId = CHAT_ID;
    await handleAIMessage(CHAT_ID, prompt);
  } catch (err) {
    console.error('Auto-scan error:', err.message);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

console.log('🤖 AI Trading Analyst Bot started');
console.log('💬 Chat naturally — ask anything about markets, geopolitics, earnings');
console.log('📋 Watchlist:', DEFAULT_WATCHLIST.join(', '));
console.log('🕐 Schedule (ET → SGT):');
console.log('   Morning briefing : 9:00 AM ET  → 9:00 PM SGT');
console.log('   Auto-scan hourly : 10 AM–3 PM ET  → 10 PM–3 AM SGT');
