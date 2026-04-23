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
  getEarningsSurprise,
  getPreEarningsDrift,
  getInsiderBuying,
} from '../core/news.js';
import { getConvictionScore, checkSectorConcentration } from '../core/scoring.js';
import {
  isTradingViewAvailable,
  getChartTechnicals,
  getPriceLevels,
  getOHLCVSummary,
} from '../core/tradingview-bridge.js';
import {
  getMarketSentiment,
  getSectorPerformance,
  getTrendingStocks,
  getDayTradingDashboard,
  getMarketMovers,
} from '../core/sentiment.js';
import {
  getAccount,
  getPositions,
  getOrders,
  placeTrade,
  closePosition,
  getMarketStatus,
  getDailyPnL,
  DAILY_PROFIT_TARGET,
  DAILY_LOSS_LIMIT,
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

// Per-chat conversation history — persisted to disk, survives restarts
const chatHistory = new Map();

function loadHistory() {
  try {
    if (existsSync(HISTORY_FILE)) {
      const raw = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
      for (const [chatId, messages] of Object.entries(raw)) {
        chatHistory.set(Number(chatId), messages);
      }
      console.log(`📖 Loaded history for ${chatHistory.size} chat(s)`);
    }
  } catch { /* corrupted file — start fresh */ }
}

let _saveTimer = null;
function saveHistory() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const obj = {};
      for (const [chatId, messages] of chatHistory) obj[chatId] = messages;
      writeFileSync(HISTORY_FILE, JSON.stringify(obj), 'utf8');
    } catch (e) { console.error('Failed to save history:', e.message); }
  }, 2000);
}

function pushHistory(chatId, message) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const msgs = chatHistory.get(chatId);
  msgs.push(message);
  if (msgs.length > MAX_HISTORY_PER_CHAT) msgs.splice(0, msgs.length - MAX_HISTORY_PER_CHAT);
  saveHistory();
}

loadHistory();

// ─── Usage Tracker (persisted to disk) ───────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import net from 'net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATS_FILE   = join(__dirname, '../../.bot-stats.json');
const HISTORY_FILE = join(__dirname, '../../.bot-history.json');

const MAX_HISTORY_PER_CHAT = 40; // 20 turns

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
    name: 'get_market_movers',
    description: 'Get today\'s top gainers, most-active, and unusual-volume stocks from the entire market (not just watchlist). Returns stocks with highest % moves and 1.5×+ relative volume. Use this as the primary candidate source for auto-scans — follow the market, not a fixed list.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
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
  {
    name: 'get_daily_pnl',
    description: `Check today's realized P&L against the daily profit target ($${DAILY_PROFIT_TARGET}) and daily loss limit (-$${DAILY_LOSS_LIMIT}). Call this before any auto-scan. If target_reached is true, stop trading for the day. If loss_limit_reached is true, stop trading immediately.`,
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_chart_technicals',
    description: 'Read live technical indicator values from the TradingView chart: RSI, MACD, EMAs (20/50), Bollinger Bands, and current price. Returns available: false if TradingView Desktop is not running. Use this to confirm entries — never buy when RSI > 70 or price is above upper Bollinger Band.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Expected ticker — used to detect if chart symbol matches' },
      },
    },
  },
  {
    name: 'get_price_levels',
    description: 'Read key price levels drawn by Pine Script indicators on the TradingView chart: support and resistance zones, labeled levels (PDH, PDL, VWAP, etc.). Returns nearest support and resistance with distance %. Use this to assess risk/reward — avoid entries within 2% of major resistance.',
    input_schema: {
      type: 'object',
      properties: {
        symbol:       { type: 'string', description: 'Expected ticker' },
        study_filter: { type: 'string', description: 'Filter by indicator name substring (optional)' },
      },
    },
  },
  {
    name: 'get_ohlcv_summary',
    description: 'Get a compact OHLCV summary from TradingView chart (high, low, range, change%, avg volume, last 5 bars). Returns { available: false } if TradingView is not running.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Expected ticker' },
      },
    },
  },
  {
    name: 'get_conviction_score',
    description: 'Get a multi-factor conviction score (0-100) for a trade setup. Checks earnings quality, pre-earnings drift, relative strength, insider activity, TradingView technicals, and sector concentration. Pass current open positions to enable sector concentration check (-25 pts if already in same sector). Always call this before propose_trade.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol e.g. "NVDA"' },
        positions: {
          type: 'array',
          description: 'Current open positions from get_portfolio — used for sector concentration check',
          items: { type: 'object', properties: { symbol: { type: 'string' } } },
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_earnings_surprise',
    description: 'Get upcoming earnings date, EPS estimate from Nasdaq, and historical YoY beat streak from SEC EDGAR. Use to assess consistency of earnings beats before a trade.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol e.g. "MRVL"' },
      },
      required: ['symbol'],
    },
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
      case 'get_market_movers':
        return await getMarketMovers({ limit: input.limit || 20 });
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
      case 'get_daily_pnl':
        return await getDailyPnL();
      case 'get_chart_technicals':
        return await getChartTechnicals({ symbol: input.symbol });
      case 'get_price_levels':
        return await getPriceLevels({ symbol: input.symbol, study_filter: input.study_filter });
      case 'get_ohlcv_summary':
        return await getOHLCVSummary({ symbol: input.symbol });
      case 'get_conviction_score':
        return await getConvictionScore({ symbol: input.symbol, positions: input.positions || [] });
      case 'get_earnings_surprise':
        return await getEarningsSurprise({ symbol: input.symbol });
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

The user has a reference watchlist: ${DEFAULT_WATCHLIST.join(', ')} — but auto-scans should follow the market (use get_market_movers), not be limited to this list. Any liquid US stock is fair game.
Today's date: ${new Date().toISOString().split('T')[0]}

DAILY TARGET: Goal is $100–200 profit per day.
- Call get_daily_pnl before every scan
- If target_reached (P&L >= $150): stop ALL trading for the day — goal achieved, protect gains
- If loss_limit_reached (P&L <= -$200): stop ALL trading — protect capital
- Report remaining_to_target in your response so the user knows progress

POSITION SIZING: Positions are auto-sized by ATR to target $150 profit per winning trade.
- Do NOT pass a dollars amount to propose_trade — let ATR auto-size it
- The engine calculates: position = $150 ÷ (3 × ATR%) → typically $1,500–$5,000
- Each trade risks ~$75 (1:2 R/R), targets ~$150 profit
- 1–2 winning trades per day hits the $100–200 goal
- Stocks with ATR < 1% are rejected automatically (don't move enough)

TRADING ENGINE (Alpaca paper trading — fake money for now):
- Use propose_trade to execute trades IMMEDIATELY and automatically — no approval needed
- ALWAYS check get_market_status first — only trade during open market hours
- ALWAYS check get_portfolio first — max 2 open positions at once (reduced from 3)
- Stop loss and take profit are automatically sized by ATR — no need to set them manually
- Best trading windows: 9:45–11:30 AM ET (prime momentum) and 2:00–3:30 PM ET (afternoon trend)
- Only trade when you have real data backing the setup: earnings beat, sentiment, sector rotation
- Never trade on speculation alone
- After executing, notify user: include estimated_profit, estimated_risk, risk_reward from the result

SECTOR RULE: Never open 2 positions in the same sector (e.g., no NVDA + AMD simultaneously — both are XLK). The conviction score already penalises this (-25 pts) but verify via get_portfolio before executing. Pass the positions array from get_portfolio into get_conviction_score.

CONVICTION REQUIREMENT: Before calling propose_trade, ALWAYS call get_conviction_score first.
- Score >= 50 (grade B or higher): proceed — position sized automatically via ATR
- Score < 50: skip the trade and explain which factors were missing
- Quality over quantity: 1 great trade beats 3 mediocre trades

TECHNICAL CONFIRMATION (when TradingView is running):
Before propose_trade, call get_chart_technicals:
- SKIP if RSI > 70 (overbought — wait for pullback)
- SKIP if price > upper Bollinger Band (extended)
- SKIP if price < EMA20 AND price < EMA50 (downtrend)
- PREFER entries where RSI < 50 and price > EMA20
Also call get_price_levels to check risk/reward:
- SKIP if price is within 2% of major resistance
- NOTE the nearest support level — use it to validate the stop loss
If TradingView is not running, proceed on fundamentals alone but mention 'TradingView offline — technical confirmation skipped' in your response.
Note: get_conviction_score already calls TradingView internally — the tv_available and technical_summary fields in the score result tell you if chart data was used in scoring.

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
  pushHistory(chatId, { role: 'user', content: userMessage });
  const history = chatHistory.get(chatId);

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
    pushHistory(chatId, { role: 'assistant', content: text });

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

/pnl — today's P&L vs daily target ($150) and loss limit ($200)
/status — service health dashboard (all APIs)
/stats — API usage & cost dashboard
/tvstatus — TradingView Desktop connection + live chart data
/clear — reset conversation
/watchlist — show tracked stocks`);
});

bot.onText(/\/clear/, async (msg) => {
  chatHistory.delete(msg.chat.id);
  saveHistory();
  await send(msg.chat.id, '🧹 Conversation cleared. Fresh start!');
});

// ─── /status — full service health dashboard ──────────────────────────────────

async function checkService(name, fn) {
  const start = Date.now();
  try {
    const detail = await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    return { name, ok: true, ms: Date.now() - start, detail };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - start, detail: err.message };
  }
}

bot.onText(/\/status/, async (msg) => {
  await sendTyping(msg.chat.id);
  await send(msg.chat.id, '🔍 Checking all services...');

  const checks = await Promise.all([

    checkService('Telegram Bot', async () => 'Polling active'),

    checkService('Claude AI (Anthropic)', async () => {
      const key = process.env.ANTHROPIC_API_KEY || '';
      if (!key.startsWith('sk-ant-')) throw new Error('API key missing or invalid');
      return `Key configured · Model: claude-haiku-4-5`;
    }),

    checkService('Alpaca Trading', async () => {
      const acc = await getAccount();
      return `$${acc.portfolio_value?.toLocaleString()} portfolio · ${acc.paper ? 'Paper' : 'Live'}`;
    }),

    checkService('Alpaca News API', async () => {
      const r = await fetch(
        'https://data.alpaca.markets/v1beta1/news?symbols=AAPL&limit=1&sort=desc',
        { headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY } }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const age = d.news?.[0]?.created_at
        ? Math.round((Date.now() - new Date(d.news[0].created_at)) / 60000) + ' min ago'
        : 'no articles';
      return `Latest: ${age}`;
    }),

    checkService('Yahoo Finance', async () => {
      const r = await fetch(
        'https://query2.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d',
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const vix = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
      return vix ? `VIX: ${vix}` : 'Connected';
    }),

    checkService('SEC EDGAR', async () => {
      const r = await fetch('https://data.sec.gov/submissions/CIK0000320193.json',
        { headers: { 'User-Agent': 'tradingview-mcp research-tool contact@example.com' } }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      return `API reachable · ${d.name ?? 'EDGAR'} filings: ${d.filings?.recent?.form?.length ?? '?'} recent`;
    }),

    checkService('Nasdaq Earnings Calendar', async () => {
      const today = new Date().toISOString().split('T')[0];
      const r = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${today}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Origin': 'https://www.nasdaq.com', 'Referer': 'https://www.nasdaq.com/' }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const count = d?.data?.rows?.length ?? 0;
      return `${count} companies reporting today`;
    }),

    checkService('TradingView Desktop', async () => {
      const avail = await isTradingViewAvailable();
      if (!avail) throw new Error('CDP port 9222 not reachable — launch TradingView with --remote-debugging-port=9222');
      const t = await getChartTechnicals({});
      return t.available ? `${t.symbol} · ${t.timeframe} · $${t.current_price}` : 'Connected (no chart data)';
    }),

    checkService('Moomoo OpenD', async () => {
      await new Promise((resolve, reject) => {
        const sock = new net.Socket();
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('Port 11111 not open — start Moomoo OpenD')); }, 2000);
        sock.connect(11111, '127.0.0.1', () => { clearTimeout(timer); sock.destroy(); resolve(); });
        sock.on('error', (e) => { clearTimeout(timer); reject(new Error(`Port 11111 error: ${e.message}`)); });
      });
      return 'OpenD reachable on port 11111';
    }),

  ]);

  const icon = (ok) => ok ? '✅' : '🔴';
  const pad  = (ms) => ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(1)}s`;

  let text = `🖥️ *Service Status Dashboard*\n`;
  text += `🕐 ${nowBothTimezones()}\n\n`;

  for (const c of checks) {
    text += `${icon(c.ok)} *${c.name}*`;
    text += ` _(${pad(c.ms)})_\n`;
    text += `   ${c.ok ? c.detail : '⚠️ ' + c.detail}\n\n`;
  }

  const allOk = checks.every(c => c.ok);
  const okCount = checks.filter(c => c.ok).length;
  text += allOk
    ? `_All ${checks.length} services operational_`
    : `_${okCount}/${checks.length} services operational_`;

  await send(msg.chat.id, text);
});

bot.onText(/\/pnl/, async (msg) => {
  await sendTyping(msg.chat.id);
  const pnl = await getDailyPnL();
  if (!pnl.available) {
    await send(msg.chat.id, '⚠️ P&L data unavailable — market may be closed or Alpaca API issue.');
    return;
  }
  const sign   = pnl.pnl >= 0 ? '+' : '';
  const status = pnl.target_reached     ? '✅ Daily target REACHED — no more trades today!'
               : pnl.loss_limit_reached ? '🛑 Daily loss limit hit — protecting capital'
               : `📈 ${pnl.remaining_to_target > 0 ? `$${pnl.remaining_to_target} to target` : 'Target reached'}`;

  await send(msg.chat.id,
    `💰 *Today's P&L*\n` +
    `${sign}$${pnl.pnl} (${sign}${pnl.pnl_pct.toFixed(2)}%)\n\n` +
    `🎯 Daily target: $${pnl.daily_target}\n` +
    `🛑 Loss limit: -$${DAILY_LOSS_LIMIT}\n\n` +
    status
  );
});

bot.onText(/\/tvstatus/, async (msg) => {
  await sendTyping(msg.chat.id);
  const available = await isTradingViewAvailable();

  if (!available) {
    await send(msg.chat.id,
      `📺 *TradingView Status*\n\n` +
      `🔴 *Not connected*\n\n` +
      `TradingView Desktop is not running or CDP port 9222 is not open.\n\n` +
      `*To connect:*\n` +
      `\`\`\`\npkill -f TradingView && sleep 2\n/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222 &\n\`\`\`\n\n` +
      `_Chart technicals (RSI, MACD, EMA, levels) will not be available until connected._`
    );
    return;
  }

  // TV is available — fetch full chart state
  const technicals = await getChartTechnicals({});
  const levels     = await getPriceLevels({});
  const ohlcv      = await getOHLCVSummary({});

  let msg2 = `📺 *TradingView Status*\n\n🟢 *Connected* — CDP port 9222\n\n`;

  if (technicals.available) {
    msg2 += `📊 *Chart:* ${technicals.symbol || '?'} · ${technicals.timeframe || '?'}\n`;
    msg2 += `💰 *Price:* $${technicals.current_price ?? 'n/a'}\n\n`;
    msg2 += `*Indicators:*\n`;
    msg2 += technicals.rsi       != null ? `• RSI: ${technicals.rsi}\n`             : '';
    msg2 += technicals.macd_hist != null ? `• MACD Hist: ${technicals.macd_hist}\n` : '';
    msg2 += technicals.ema20     != null ? `• EMA 20: ${technicals.ema20}\n`        : '';
    msg2 += technicals.ema50     != null ? `• EMA 50: ${technicals.ema50}\n`        : '';
    msg2 += technicals.bb_upper  != null ? `• BB Upper: ${technicals.bb_upper}\n`   : '';
    msg2 += technicals.bb_lower  != null ? `• BB Lower: ${technicals.bb_lower}\n`   : '';
    if (!technicals.rsi && !technicals.macd_hist && !technicals.ema20) {
      msg2 += `_No indicator values found — add RSI/MACD/EMA to chart_\n`;
    }
    msg2 += '\n';
  }

  if (levels.available && levels.level_count > 0) {
    msg2 += `*Key Levels (${levels.level_count} total):*\n`;
    if (levels.nearest_resistance) msg2 += `• 🔴 Resistance: $${levels.nearest_resistance.price} (+${levels.distance_to_resistance_pct}%)\n`;
    if (levels.nearest_support)    msg2 += `• 🟢 Support: $${levels.nearest_support.price} (-${levels.distance_to_support_pct}%)\n`;
    msg2 += '\n';
  }

  if (ohlcv.available) {
    msg2 += `*Recent Price Action (20 bars):*\n`;
    msg2 += `• Range: $${ohlcv.low} – $${ohlcv.high}\n`;
    msg2 += `• Change: ${ohlcv.change_pct}\n`;
    msg2 += `• Avg Volume: ${ohlcv.avg_volume?.toLocaleString()}\n`;
  }

  await send(msg.chat.id, msg2);
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
  const knownCmds = ['/start', '/clear', '/watchlist', '/stats', '/tvstatus', '/status', '/pnl', '/close_'];
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

// Auto-scanner: every 10 min, 9:45 AM–3:30 PM ET (9:45 PM–3:30 AM SGT) = 13:45–19:30 UTC Mon–Fri
cron.schedule('*/10 * * * 1-5', async () => {
  // Only run during ET market hours: 9:45 AM – 3:30 PM = 13:45 – 19:30 UTC
  const utcH = new Date().getUTCHours(), utcM = new Date().getUTCMinutes();
  const utcT = utcH * 60 + utcM;
  if (utcT < 13 * 60 + 45 || utcT >= 19 * 60 + 30) return;
  if (!CHAT_ID) return;
  console.log('Running auto-scan for trade opportunities...');
  try {
    const prompt = `AUTOMATED TRADE SCAN — daily target $100–200 profit. Steps in order:

1. Call get_daily_pnl → if target_reached ($150+) or loss_limit_reached (-$200), STOP and send 1 line: "✅ Daily target reached — no more trades today" or "🛑 Daily loss limit hit — protecting capital"
2. Call get_market_status → if market is closed, STOP silently
3. Call get_portfolio → if already 2+ open positions, STOP silently
4. Call get_market_sentiment → note VIX. If VIX > 30, STOP silently

5. BUILD CANDIDATE LIST (do these in parallel):
   a. Call get_market_movers → top gainers and high-volume stocks from the ENTIRE market today
   b. Call get_earnings_calendar for today's date → stocks reporting today (pre/post market)
   c. Call get_sector_performance → identify the 1-2 strongest sectors right now

6. FILTER candidates to 4-6 best:
   - Prefer stocks in the leading sectors from step 5c
   - Prefer stocks with a catalyst (earnings today, news, unusual volume rel_volume > 2×)
   - Prefer price $10–$500 (liquid, not penny stocks)
   - Skip ETFs, indices, anything with ^ or = in symbol

7. For EACH filtered candidate: call get_conviction_score (pass portfolio positions) — skip if score < 50

8. Take the SINGLE highest-scoring candidate with score >= 50

9. CALL propose_trade for that symbol. Do NOT pass a dollars amount — ATR auto-sizes it.

10. Send result: "📈 TRADE EXECUTED: [SYMBOL] | Est. profit: +$[X] | Risk: -$[Y] | R/R: [Z]:1 | Today's P&L: $[pnl] / $150 target"

11. ALWAYS send one message every scan — either a trade alert or a heartbeat:
    - Trade → "📈 TRADE: [SYMBOL] | +$[profit] target | -$[risk] stop | R/R [x]:1 | P&L today: $[pnl]/$150"
    - No trade → "🔍 [TIME ET / SGT] | Top mover: [SYMBOL] [+X%] | No trade — [reason: best score [X]/50, or positions full, or VIX [x], or daily target hit]"

Never be silent. The user needs to see the scanner is alive every 10 minutes.

IMPORTANT: Follow the market — go where volume and momentum are. Do not limit to any fixed list.`;
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
console.log('   Auto-scan every 10min : 9:45 AM–3:30 PM ET  → 9:45 PM–3:30 AM SGT');
