/**
 * Shared AI chat engine — used by both the Telegram bot and the web dashboard.
 * Exports: TOOLS, SYSTEM_PROMPT, executeTool, chat()
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  getEarningsCalendar, scanEarnings, getEarnings, getSymbolNews, getMarketNews,
  getFinancials, getEarningsSurprise, getPreEarningsDrift, getInsiderBuying,
} from './news.js';
import { getConvictionScore } from './scoring.js';
import {
  loadConversationHistory, appendConversationMessage, clearConversationHistory,
  isDbAvailable,
} from './db.js';
import { getChartTechnicals, getPriceLevels, getOHLCVSummary } from './tradingview-bridge.js';
import {
  getMarketSentiment, getSectorPerformance, getTrendingStocks,
  getDayTradingDashboard, getMarketMovers,
} from './sentiment.js';
import {
  getAccount, getPositions, getOrders, placeTrade, closePosition,
  getMarketStatus, getDailyPnL, getMarketRegime, closeStalePositions,
  cancelOrder, cancelAllOrders, moveStopToBreakeven,
  DAILY_PROFIT_TARGET, DAILY_LOSS_LIMIT,
} from './trader.js';
import { recordTrade, recordApiCall, upsertUsageStats, setUserBotConfig, getUserBotConfig, BOT_CONFIG_DEFAULTS, getTrades } from './db.js';

const PRICE_INPUT_PER_M  = 0.80;
const PRICE_OUTPUT_PER_M = 4.00;
function calcCost(inp, out) { return (inp / 1e6) * PRICE_INPUT_PER_M + (out / 1e6) * PRICE_OUTPUT_PER_M; }

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DEFAULT_WATCHLIST = [
  'MRVL','NVDA','AMD','AAPL','MSFT','GOOGL','META','AMZN',
  'TSLA','NFLX','INTC','QCOM','MU','AVGO','TSM','SMCI','RTX','LMT','XOM','JPM',
];

// In-memory history cache (shared across sessions keyed by chatId)
export const chatHistory = new Map();

export async function loadHistoryForChat(chatId) {
  if (chatHistory.has(chatId)) return;
  const rows = await loadConversationHistory(chatId, 40);
  chatHistory.set(chatId, rows ?? []);
}

export function pushHistory(chatId, message) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const h = chatHistory.get(chatId);
  h.push(message);
  if (h.length > 40) h.splice(0, h.length - 40);
  if (isDbAvailable()) appendConversationMessage(chatId, message).catch(() => {});
}

export function clearHistory(chatId) {
  chatHistory.delete(chatId);
  if (isDbAvailable()) clearConversationHistory(chatId).catch(() => {});
}

export function buildSystemPrompt(userCfg = null) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true });

  const target   = userCfg?.daily_profit_target  ?? 150;
  const lossLim  = userCfg?.daily_loss_limit      ?? 200;
  const maxPos   = userCfg?.max_open_positions     ?? 2;
  const minConv  = userCfg?.min_conviction_score   ?? 50;
  const autoExec = userCfg?.auto_execute           ?? true;
  const sizing   = userCfg?.position_sizing        || {};
  const minDol   = sizing.min_dollars              ?? 1500;
  const maxDol   = sizing.max_dollars              ?? 5000;
  const tgtProf  = sizing.target_profit_per_trade  ?? 150;
  const stopMult = sizing.stop_multiplier          ?? 1.5;
  const tgtMult  = sizing.target_multiplier        ?? 3.0;
  const vixT     = userCfg?.vix_thresholds         || {};
  const vixDef   = vixT.defensive                  ?? 25;
  const vixCris  = vixT.crisis                     ?? 35;
  const maxVix   = userCfg?.max_vix_for_scan       ?? 30;
  const blocked  = (userCfg?.sectors_blocklist     || []).join(', ') || 'none';
  const profile  = userCfg?.profile                ?? 'moderate';

  return `You are an expert AI Trading Analyst. The user relies on you to find trades, manage risk, and protect capital. Accuracy and discipline are non-negotiable.

TODAY: ${dateStr} | Current ET time: ${timeStr}
Default watchlist: ${DEFAULT_WATCHLIST.join(', ')}

━━━ USER PROFILE [${profile.toUpperCase()}] ━━━
• Daily profit target : $${target} → stop ALL trading once hit
• Daily loss limit    : -$${lossLim} → stop ALL trading once hit
• Max open positions  : ${maxPos}
• Min conviction score: ${minConv}/100
• Auto-execute        : ${autoExec ? 'YES — execute trades when conviction is met' : 'NO — confirm with user before every trade'}
• Max VIX to scan     : ${maxVix}
• Blocked sectors     : ${blocked}
• Position sizing     : target $${tgtProf}/trade | range $${minDol}–$${maxDol}
• Stop multiplier     : ${stopMult}× ATR | Target multiplier: ${tgtMult}× ATR
• VIX defensive       : >${vixDef} → half position size
• VIX crisis          : >${vixCris} → no new longs

━━━ ACCURACY RULES (non-negotiable) ━━━
1. ALWAYS fetch live data before any recommendation — never guess prices, scores, or news.
2. News older than 48 hours is stale — say so explicitly and do not trade on it.
3. If a tool returns an error or empty data, say "data unavailable" — do not fill in guesses.
4. When signals conflict, explain the conflict — do not cherry-pick the bullish ones.
5. Every trade recommendation must state: confidence level, the one key risk, and the exit trigger.
6. Markets are probabilistic — use "likely", "suggests", "could" — never present a trade as certain.

━━━ PROACTIVE SCAN WORKFLOW ━━━
When user says "find a trade", "scan", "what's good?", "should I buy anything?", follow this exact sequence:
1. get_market_status          → stop here if market is CLOSED
2. get_market_regime          → stop here if regime is "crisis"
3. get_daily_pnl              → stop here if target hit or loss limit hit
4. get_portfolio              → stop here if already at max positions (${maxPos})
5. scan_for_trades            → get ranked candidates scored by conviction engine
6. get_trade_history (limit=10, status='closed') → check if any top candidates stopped out today
7. For the top candidate that: (a) scores >= ${minConv}, (b) did NOT stop out in last 60 min → propose_trade
8. If nothing qualifies: "Best score today was X/100 for SYMBOL — below your ${minConv} threshold. Sitting out."

NEVER manually score random stocks one by one. Always use scan_for_trades first.

━━━ TIME-OF-DAY STRATEGY ━━━
9:45–11:30 AM ET  → MORNING MOMENTUM: favor high-RVOL breakouts, gap-ups with fresh news catalyst. Most aggressive entries.
2:00–3:15 PM ET   → AFTERNOON TREND: favor confirmed multi-timeframe trends. More selective — only A+ setups.
11:30 AM–2:00 PM  → MIDDAY CHOP: do NOT open new positions. Monitor existing, offer to close losers or move stops.
After 3:15 PM     → NO new positions. Manage existing only. EOD flatten happens at 3:50 PM automatically.

━━━ RE-ENTRY BLOCK ━━━
Before proposing any trade, check get_trade_history for today's closed trades.
If a symbol stopped out (pnl_usd < 0) within the last 60 minutes → block re-entry and say:
"[SYMBOL] stopped out [N] minutes ago — blocked for re-entry for 60 minutes."
This prevents buying the same falling stock twice in a row.

━━━ POSITION MONITORING ━━━
When user asks "how are my positions?", "check my trades", or "what's my portfolio?":
1. get_portfolio → fetch live data for every open position
2. For each position evaluate and report:
   ✅ Up > 80% of target → "Near target — consider taking profit"
   🔒 Up > 50% of target → "Offer to move stop to breakeven: move_stop_to_breakeven"
   ⚠️  Down > 60% toward stop → "Approaching stop — watch closely"
   ❌ Down > 80% toward stop → "Consider cutting early to limit damage"
3. Always show per position: entry | current price | unrealized P&L $ and % | distance to stop | distance to target

When a position crosses 50% of its target profit, proactively say:
"[SYMBOL] is up $X — halfway to target. Want me to move the stop to breakeven to guarantee zero loss?"

━━━ MANDATORY PRE-TRADE CHECKLIST ━━━
Before calling propose_trade, confirm ALL of these — if any fail, do not trade:
□ Market is OPEN (get_market_status)
□ VIX regime is not "crisis" (get_market_regime)
□ Daily P&L within limits — not hit $${target} target or -$${lossLim} loss limit (get_daily_pnl)
□ Open positions < ${maxPos} AND buying power sufficient (get_portfolio)
□ No existing position in this symbol already (get_portfolio)
□ Conviction score >= ${minConv} (from scan_for_trades or get_conviction_score)
□ Symbol did NOT stop out in the last 60 minutes (get_trade_history)
□ Sector not in blocklist: [${blocked}]
□ Strong technical signal OR fresh news catalyst — not just "it's trending"

━━━ CLOSING POSITIONS — REQUIRED PROTOCOL ━━━
If close_position returns "insufficient qty" or similar:
1. Call cancel_all_orders immediately — bracket legs are locking the shares
2. Retry close_position for the symbol
3. To close everything: cancel_all_orders first, then close each position one by one
Never tell the user you cannot cancel orders — you have cancel_all_orders and cancel_order.

━━━ NEWS & CATALYST ANALYSIS ━━━
- Always show publication date on every headline you reference.
- Political/macro topics: use get_news with keywords= (not a fake ticker symbol).
- Breaking news < 4h old from FinancialJuice gets highest weight.
- No relevant news in last 48h → say "no recent news as of ${dateStr}" — do not reference old headlines.

Macro catalyst → ticker mapping:
- US tariffs / trade war → ✅ CAT, DE, LMT, RTX | ❌ AAPL, QCOM, NVDA
- Wars / conflicts       → ✅ RTX, LMT, NOC, XOM, CVX | ❌ airlines, travel
- Fed rate decisions     → rate-sensitive: banks, REITs, utilities, bonds
- Sector-specific events → identify both beneficiaries AND victims

━━━ BOT CONFIGURATION ━━━
- get_my_config → always read before suggesting config changes
- update_my_config → apply changes, confirm what changed and the effect

Natural language → config:
  "be conservative" → profile='conservative'
  "go aggressive"   → profile='aggressive'
  "raise threshold" → min_conviction_score: N
  "block energy"    → sectors_blocklist: ['XLE']
  "bigger targets"  → daily_profit_target: N

━━━ AUTONOMOUS BEHAVIOUR ━━━
You are always working in the background. You automatically:
• Send a morning briefing at market open (9:30 AM ET)
• Scan for the best trade setup every 10 minutes during market hours
• Monitor open positions every 2 minutes — move stops, trail targets
• Alert when positions approach their target (80%) or stop (85%)
• Close all positions at 3:50 PM ET automatically
• Check for market regime changes every 15 minutes
• Send an end-of-day P&L summary at 4:00 PM ET

CONTEXTUAL GREETINGS — greet based on current ET time (${timeStr}):
• Before 9:30 AM  → "Good morning. Market opens in X minutes. Today looks like a [regime] day — [one sentence plan]."
• 9:30–11:30 AM   → "Market is [open/trending/choppy]. [State open positions or 'No positions yet — scanning every 10 min.']"
• 11:30 AM–2 PM   → "Midday — monitoring only. [Position status or 'No positions. Looking for afternoon setups after 2 PM.']"
• 2:00–3:15 PM    → "Afternoon session — only A+ setups now. [Position status.]"
• After 3:15 PM   → "Market closes soon. No new positions. [Today's P&L]. Flatten at 3:50 PM."
• After 4:00 PM   → "Market closed. [Today's P&L]. [One thing to watch tomorrow.]"

WHEN ASKED "what are you doing?" OR "status update?" — be specific, never vague:
✅ "I just ran a scan 3 minutes ago — no high-conviction setups. Regime is trending but RSI on candidates is overbought."
✅ "I'm monitoring NVDA — it's 60% toward target. Stop is at breakeven."
✅ "Waiting for midday chop to clear before looking for entries."
✅ "Market closed 20 min ago. Today: +$124 on 2 trades (1 win, 1 scratch). NVDA earnings tomorrow — watching it."
❌ Never say "I'm working on it" or "I'm monitoring the market" without specifics.

To answer a status question:
1. Call get_market_status → open or closed, hours remaining
2. Call get_portfolio → list each open position with entry, current price, % to target, % to stop
3. Call get_daily_pnl → today's P&L and trade count
4. State what the last scan found and when the next scan runs

━━━ RESPONSE FORMAT ━━━
Trade recommendation: SYMBOL | setup type | conviction score | catalyst + date | entry | target (+X%) | stop (-Y%) | est. profit $Z | key risk
Position status:      SYMBOL | entry $X → now $Y | P&L: +/-$Z (N%) | stop $A (N% away) | target $B (N% away) | action
News impact:          Headline (date) | direction | sectors affected | trade implication | confidence`;
}

export const SYSTEM_PROMPT = buildSystemPrompt();

export const TOOLS = [
  { name: 'get_news',            description: 'Get latest news. Pass symbol for stock-specific news (e.g. "AAPL"). For macro/political topics (wars, tariffs, Fed, Iran, geopolitics) pass keywords instead (e.g. "iran war ceasefire"). Never use a fake ticker for topic searches.', input_schema: { type: 'object', properties: { symbol: { type: 'string', description: 'Stock ticker, e.g. AAPL' }, keywords: { type: 'string', description: 'Keyword search for macro/political topics, e.g. "iran war ceasefire"' }, limit: { type: 'number' } } } },
  { name: 'get_earnings',        description: 'Get last 4 quarters of EPS actuals, revenue, and next earnings date.',                input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
  { name: 'get_financials',      description: 'Get income statement: revenue, net income, EPS, margins, YoY growth.',               input_schema: { type: 'object', properties: { symbol: { type: 'string' }, period: { type: 'string', enum: ['quarterly','annual'] } }, required: ['symbol'] } },
  { name: 'get_earnings_calendar', description: 'Get companies reporting earnings on a specific date.',                             input_schema: { type: 'object', properties: { date: { type: 'string' } } } },
  { name: 'scan_watchlist',      description: 'Scan stocks for upcoming earnings in the next N days.',                              input_schema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } }, days_ahead: { type: 'number' } } } },
  { name: 'get_market_sentiment', description: 'Get VIX, fear/greed, S&P500/Nasdaq/Dow performance, futures direction.',           input_schema: { type: 'object', properties: {} } },
  { name: 'get_sector_performance', description: 'Get today\'s performance for all 11 S&P sectors plus gold, bonds, dollar.',      input_schema: { type: 'object', properties: {} } },
  { name: 'get_trending_stocks', description: 'Get most searched/trending stocks on Yahoo Finance right now.',                      input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'get_day_trading_dashboard', description: 'Full day trading dashboard: sentiment, sectors, trending stocks.',            input_schema: { type: 'object', properties: {} } },
  { name: 'get_market_movers',   description: 'Get top gainers and biggest movers today across 88 liquid US stocks.',               input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'get_portfolio',       description: 'Get current paper trading portfolio: balance, buying power, open positions.',        input_schema: { type: 'object', properties: {} } },
  { name: 'propose_trade',       description: 'Execute a paper trade immediately. Requires conviction score >= 70. Use trailing_stop=true for momentum stocks to let winners run.',                          input_schema: { type: 'object', properties: { symbol: { type: 'string' }, side: { type: 'string', enum: ['buy','sell'] }, reasoning: { type: 'string' }, trailing_stop: { type: 'boolean' } }, required: ['symbol','side','reasoning'] } },
  { name: 'close_position',      description: 'Close an open position at market price.',                                           input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
  { name: 'get_market_status',   description: 'Check if the US market is currently open or closed.',                               input_schema: { type: 'object', properties: {} } },
  { name: 'get_market_regime',   description: 'Check VIX-based market regime: normal (full size), defensive (VIX>25, half size), or crisis (VIX>35, no new longs).',  input_schema: { type: 'object', properties: {} } },
  { name: 'close_stale_positions', description: 'Close positions open > N days that are still unprofitable. Default: 3 days, threshold -1% P&L.', input_schema: { type: 'object', properties: { max_days: { type: 'number' }, threshold_pct: { type: 'number' } } } },
  { name: 'get_open_orders',      description: 'List all open/pending orders on Alpaca. Call this before cancelling to see order IDs and which symbols have pending orders locking shares.', input_schema: { type: 'object', properties: {} } },
  { name: 'cancel_order',         description: 'Cancel a specific open order by its order ID. Use get_open_orders first to get the ID. Required before closing a position when Alpaca says "insufficient qty available".', input_schema: { type: 'object', properties: { order_id: { type: 'string', description: 'The Alpaca order ID to cancel' } }, required: ['order_id'] } },
  { name: 'cancel_all_orders',    description: 'Cancel ALL open/pending orders on Alpaca at once. Use this when you need to close positions but get "insufficient qty available" — stale limit orders lock shares and must be cancelled first.', input_schema: { type: 'object', properties: {} } },
  { name: 'scan_for_trades',      description: 'Scan the market right now for the best intraday trade setups. Gets top market movers, scores each with the full conviction engine (RVOL, ATR, technicals, news, sentiment), and returns a ranked list. Always call this instead of manually scoring random stocks one by one. Use this whenever the user asks "find a trade", "scan", or "what should I buy?".',
    input_schema: { type: 'object', properties: { max_candidates: { type: 'number', description: 'How many movers to score (default 5, max 8). More = slower but more thorough.' } } } },
  { name: 'get_trade_history',    description: "Get the bot's own trade history from the database. Use this to: (1) check if a symbol stopped out today before re-entering it, (2) review today's win/loss record, (3) understand what's been traded. Always check this before proposing a trade in a symbol that may have stopped out recently.",
    input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['open','closed'], description: 'Filter: open trades or closed trades. Omit for all.' }, limit: { type: 'number', description: 'Number of trades to return (default 20)' } } } },
  { name: 'move_stop_to_breakeven', description: 'Move the stop-loss order for an open position to the entry price (breakeven). Locks in a zero-loss floor — use when a position is up more than 50% of its take-profit target. Requires an active stop order (not trailing stop).',
    input_schema: { type: 'object', properties: { symbol: { type: 'string', description: 'The stock ticker whose stop to move' } }, required: ['symbol'] } },
  { name: 'get_daily_pnl',       description: `Check today's P&L against the $${DAILY_PROFIT_TARGET} target and -$${DAILY_LOSS_LIMIT} loss limit.`, input_schema: { type: 'object', properties: {} } },
  { name: 'get_chart_technicals', description: 'Read RSI, MACD, EMAs, Bollinger Bands from TradingView.',                         input_schema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'get_price_levels',    description: 'Read support/resistance levels from TradingView Pine Script indicators.',            input_schema: { type: 'object', properties: { symbol: { type: 'string' }, study_filter: { type: 'string' } } } },
  { name: 'get_ohlcv_summary',   description: 'Get compact OHLCV summary from TradingView.',                                       input_schema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'get_conviction_score', description: 'Get multi-factor conviction score (0–100). Always call before propose_trade.',     input_schema: { type: 'object', properties: { symbol: { type: 'string' }, positions: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' } } } } }, required: ['symbol'] } },
  { name: 'get_earnings_surprise', description: 'Get earnings date, EPS estimate, and historical beat streak.',                    input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
  { name: 'get_my_config',        description: "Read the user's current bot configuration (risk profile, daily limits, position sizing, VIX thresholds, conviction threshold, blocked sectors). Call this before suggesting or applying any config changes so you know the current state.", input_schema: { type: 'object', properties: {} } },
  { name: 'update_my_config',     description: "Update the user's bot configuration. Only include fields you want to change — omitted fields keep their current values. Use profile='conservative'|'moderate'|'aggressive' to apply a full preset, or set individual fields. Always confirm the change out loud after applying.",
    input_schema: {
      type: 'object',
      properties: {
        profile:              { type: 'string',  enum: ['conservative','moderate','aggressive','custom'], description: 'Apply a risk profile preset' },
        daily_profit_target:  { type: 'number',  description: 'Stop trading when daily P&L reaches this (dollars)' },
        daily_loss_limit:     { type: 'number',  description: 'Stop trading when daily loss reaches this (dollars)' },
        max_open_positions:   { type: 'integer', description: 'Maximum simultaneous open positions (1–10)' },
        min_conviction_score: { type: 'number',  description: 'Minimum conviction score to enter a trade (0–100)' },
        auto_execute:         { type: 'boolean', description: 'Whether trades fire automatically after 5-min countdown' },
        max_vix_for_scan:     { type: 'number',  description: 'Skip scanner run if VIX is above this level' },
        position_sizing: {
          type: 'object',
          properties: {
            target_profit_per_trade: { type: 'number' },
            min_dollars:             { type: 'number' },
            max_dollars:             { type: 'number' },
            stop_multiplier:         { type: 'number' },
            target_multiplier:       { type: 'number' },
            min_atr_pct:            { type: 'number' },
          },
        },
        vix_thresholds: {
          type: 'object',
          properties: {
            defensive: { type: 'number', description: 'VIX above this halves position size' },
            crisis:    { type: 'number', description: 'VIX above this blocks all new longs' },
          },
        },
        sectors_blocklist: { type: 'array', items: { type: 'string' }, description: 'ETF sector codes to never trade, e.g. ["XLE","XLF"]' },
      },
    },
  },
];

const _CHAT_PROFILE_PRESETS = {
  conservative: { profile:'conservative', daily_profit_target:75,  daily_loss_limit:100, max_open_positions:1, min_conviction_score:65, auto_execute:false, max_vix_for_scan:22, position_sizing:{ target_profit_per_trade:75,  min_dollars:500,  max_dollars:2000,  stop_multiplier:1.5, target_multiplier:3.0, min_atr_pct:1.0 }, vix_thresholds:{ defensive:20, crisis:30 }, sectors_blocklist:[] },
  moderate:     { profile:'moderate',     daily_profit_target:150, daily_loss_limit:200, max_open_positions:2, min_conviction_score:50, auto_execute:true,  max_vix_for_scan:30, position_sizing:{ target_profit_per_trade:150, min_dollars:1500, max_dollars:5000,  stop_multiplier:1.5, target_multiplier:3.0, min_atr_pct:1.0 }, vix_thresholds:{ defensive:25, crisis:35 }, sectors_blocklist:[] },
  aggressive:   { profile:'aggressive',   daily_profit_target:300, daily_loss_limit:500, max_open_positions:3, min_conviction_score:35, auto_execute:true,  max_vix_for_scan:40, position_sizing:{ target_profit_per_trade:300, min_dollars:3000, max_dollars:10000, stop_multiplier:1.5, target_multiplier:3.0, min_atr_pct:0.8 }, vix_thresholds:{ defensive:30, crisis:45 }, sectors_blocklist:[] },
};

export async function executeTool(name, input, { onTrade, userCfg, username } = {}) {
  try {
    switch (name) {
      case 'get_news': {
        const addAge = items => items.map(a => {
          const pub = a.published ? new Date(a.published) : null;
          const hoursAgo = pub ? Math.round((Date.now() - pub.getTime()) / 3600000) : null;
          return { ...a, hours_ago: hoursAgo, age_label: hoursAgo == null ? 'unknown date' : hoursAgo < 1 ? 'just now' : hoursAgo < 24 ? `${hoursAgo}h ago` : `${Math.floor(hoursAgo/24)}d ago`, stale: hoursAgo != null && hoursAgo > 48 };
        });
        const todayStr = new Date().toISOString().split('T')[0];
        if (input.keywords && !input.symbol) {
          const all = await getMarketNews({ limit: 60, keywords: input.keywords });
          const kws = input.keywords.toLowerCase().split(/[\s,+]+/).filter(k => k.length > 2);
          const fresh = all.filter(a => {
            const hoursAgo = a.published ? (Date.now() - new Date(a.published).getTime()) / 3600000 : 999;
            return hoursAgo <= 48;
          });
          const pool = fresh.length >= 3 ? fresh : all;
          const matched = pool.filter(a => kws.some(k => a.title?.toLowerCase().includes(k) || a.summary?.toLowerCase().includes(k)));
          const output = addAge((matched.length > 0 ? matched : pool).slice(0, input.limit || 15));
          if (output.length === 0) {
            return { no_results: true, message: `No articles found matching "${input.keywords}" as of ${todayStr}. All news sources returned empty. Do not reference old headlines — state that no current news is available on this topic.` };
          }
          if (matched.length === 0) {
            return { partial_match: true, message: `No exact match for "${input.keywords}" in recent news as of ${todayStr}. Showing most recent headlines instead:`, items: output };
          }
          return output;
        }
        const items = await getSymbolNews({ symbol: input.symbol, limit: input.limit || 10 });
        return addAge(Array.isArray(items) ? items : []);
      }
      case 'get_earnings':           return await getEarnings({ symbol: input.symbol });
      case 'get_financials':         return await getFinancials({ symbol: input.symbol, period: input.period || 'quarterly' });
      case 'get_earnings_calendar':  return await getEarningsCalendar({ date: input.date, limit: 50 });
      case 'scan_watchlist':         return await scanEarnings({ symbols: input.symbols || DEFAULT_WATCHLIST, days_ahead: input.days_ahead || 14 });
      case 'get_market_sentiment':   return await getMarketSentiment();
      case 'get_sector_performance': return await getSectorPerformance();
      case 'get_trending_stocks':    return await getTrendingStocks({ limit: input.limit || 15 });
      case 'get_day_trading_dashboard': return await getDayTradingDashboard();
      case 'get_market_movers':      return await getMarketMovers({ limit: input.limit || 20 });
      case 'get_portfolio': {
        const [account, positions, orders] = await Promise.all([getAccount(), getPositions(), getOrders()]);
        return { account, positions, open_orders: orders };
      }
      case 'propose_trade': {
        const result = await placeTrade({ symbol: input.symbol, side: input.side, use_atr: true, trailing_stop: input.trailing_stop ?? false, note: input.reasoning, userCfg: userCfg ?? null });
        recordTrade({ order_id: result.order_id, symbol: result.symbol, side: result.side, qty: result.qty, entry_price: result.estimated_price, stop_loss: result.stop_loss, take_profit: result.take_profit, dollars_invested: result.dollars_invested, stop_loss_pct: result.stop_loss_pct, take_profit_pct: result.take_profit_pct, atr_pct: result.atr_pct }).catch(() => {});
        if (onTrade) onTrade(result);
        return { status: 'executed', ...result };
      }
      case 'close_position':         return await closePosition(input.symbol);
      case 'get_market_status':      return await getMarketStatus();
      case 'get_market_regime':      return await getMarketRegime({ defensive_vix: userCfg?.vix_thresholds?.defensive ?? 25, crisis_vix: userCfg?.vix_thresholds?.crisis ?? 35 });
      case 'close_stale_positions':  return await closeStalePositions({ maxDays: input.max_days || 3, threshold_pct: input.threshold_pct ?? -1 });
      case 'get_open_orders':        return await getOrders();
      case 'cancel_order':           return await cancelOrder(input.order_id);
      case 'cancel_all_orders':      return await cancelAllOrders();
      case 'scan_for_trades': {
        const maxCandidates = Math.min(input.max_candidates || 5, 8);
        const [movers, positions] = await Promise.all([
          getMarketMovers({ limit: 30 }),
          getPositions(),
        ]);
        const heldSymbols = new Set(positions.map(p => p.symbol));
        const symbols = [
          ...(movers?.gainers?.map(m => m.symbol) ?? []),
          ...(movers?.actives?.map(m => m.symbol) ?? []),
        ].filter((s, i, arr) => arr.indexOf(s) === i)  // deduplicate
         .filter(s => !heldSymbols.has(s))             // skip already-held
         .slice(0, maxCandidates);
        if (!symbols.length) return { no_candidates: true, reason: 'No movers found or all top movers already in portfolio' };
        const scored = await Promise.allSettled(
          symbols.map(sym => getConvictionScore({ symbol: sym, positions }))
        );
        const results = scored
          .filter(r => r.status === 'fulfilled' && r.value?.score != null)
          .map(r => ({ symbol: r.value.symbol ?? r.value.ticker ?? symbols[scored.indexOf(scored.find(x => x === r))], score: r.value.score, grade: r.value.grade, summary: r.value.summary }))
          .sort((a, b) => b.score - a.score);
        return { scanned: symbols.length, positions_held: [...heldSymbols], candidates: results };
      }
      case 'get_trade_history': {
        const trades = await getTrades({ status: input.status, limit: input.limit || 20 });
        if (!trades) return { error: 'Trade history unavailable — database not connected' };
        return { trades, count: trades.length };
      }
      case 'move_stop_to_breakeven': return await moveStopToBreakeven(input.symbol);
      case 'get_daily_pnl':          return await getDailyPnL();
      case 'get_chart_technicals':   return await getChartTechnicals({ symbol: input.symbol });
      case 'get_price_levels':       return await getPriceLevels({ symbol: input.symbol, study_filter: input.study_filter });
      case 'get_ohlcv_summary':      return await getOHLCVSummary({ symbol: input.symbol });
      case 'get_conviction_score':   return await getConvictionScore({ symbol: input.symbol, positions: input.positions || [] });
      case 'get_earnings_surprise':  return await getEarningsSurprise({ symbol: input.symbol });
      case 'get_my_config': {
        const cfg = userCfg ?? { ...BOT_CONFIG_DEFAULTS };
        return { current_config: cfg, note: 'Use update_my_config to change any of these values.' };
      }
      case 'update_my_config': {
        if (!username) return { error: 'Cannot save config — username not available in this session.' };
        // Start from current config and apply changes
        const current = await getUserBotConfig(username);
        let updated = { ...current };
        // Profile preset takes precedence and overrides everything
        if (input.profile && _CHAT_PROFILE_PRESETS[input.profile]) {
          updated = { ..._CHAT_PROFILE_PRESETS[input.profile] };
        } else {
          // Merge individual fields
          const topLevel = ['daily_profit_target','daily_loss_limit','max_open_positions','min_conviction_score','auto_execute','max_vix_for_scan','sectors_blocklist'];
          for (const k of topLevel) { if (input[k] !== undefined) updated[k] = input[k]; }
          if (input.position_sizing) updated.position_sizing = { ...updated.position_sizing, ...input.position_sizing };
          if (input.vix_thresholds)  updated.vix_thresholds  = { ...updated.vix_thresholds,  ...input.vix_thresholds };
          updated.profile = 'custom';
        }
        await setUserBotConfig(username, updated);
        return { ok: true, applied: updated, message: 'Configuration saved. Changes are live immediately.' };
      }
      default:                       return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Send a message and get a response.
 * onChunk(text) — called as each text token arrives (for SSE streaming)
 * onTool(name)  — called when a tool starts executing (for UI "thinking" indicator)
 * Returns the full response text.
 */
export async function chat({ chatId, message, onChunk, onTool, signal, userConfig = null, username = null }) {
  if (!chatHistory.has(chatId)) await loadHistoryForChat(chatId);
  pushHistory(chatId, { role: 'user', content: message });

  let messages = [...chatHistory.get(chatId)];
  let fullText = '';

  while (true) {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

    const t0 = Date.now();
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: buildSystemPrompt(userConfig),
      tools: TOOLS,
      messages,
    });

    // Wire AbortSignal → stream cancel
    const onAbort = () => { try { stream.controller.abort(); } catch {} };
    signal?.addEventListener('abort', onAbort, { once: true });

    let currentText = '';

    try {
      for await (const event of stream) {
        if (signal?.aborted) break;
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            currentText += event.delta.text;
            fullText    += event.delta.text;
            if (onChunk) onChunk(event.delta.text);
          }
        } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          if (onTool) onTool(event.content_block.name);
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

    const finalMsg = await stream.finalMessage();
    const u = finalMsg.usage || {};
    const inp = u.input_tokens || 0, out = u.output_tokens || 0;
    const tools = finalMsg.content.filter(b => b.type === 'tool_use').length;
    recordApiCall({ source: 'dashboard_chat', inputTokens: inp, outputTokens: out, toolCalls: tools, costUsd: calcCost(inp, out), durationMs: Date.now() - t0, model: finalMsg.model }).catch(() => {});
    upsertUsageStats({ inputTokens: inp, outputTokens: out, toolCalls: tools, costUsd: calcCost(inp, out) }).catch(() => {});

    if (finalMsg.stop_reason === 'tool_use') {
      const toolBlocks = finalMsg.content.filter(b => b.type === 'tool_use');
      messages.push({ role: 'assistant', content: finalMsg.content });

      const toolResults = await Promise.all(
        toolBlocks.map(async (tu) => ({
          type:        'tool_result',
          tool_use_id: tu.id,
          content:     JSON.stringify(await executeTool(tu.name, tu.input, { onTrade: null, userCfg: userConfig, username })),
        }))
      );
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Final response
    pushHistory(chatId, { role: 'assistant', content: fullText });
    return fullText;
  }
}
