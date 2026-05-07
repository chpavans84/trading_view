/**
 * Shared AI chat engine — used by both the Telegram bot and the web dashboard.
 * Exports: TOOLS, SYSTEM_PROMPT, executeTool, chat()
 *
 * Cost estimate after optimisations:
 * - Market context:     $0  (deterministic logic)
 * - Stock selection:    $0  (deterministic scoring)
 * - Conviction scores:  $0  (5-min cache)
 * - Morning briefing:   $0  (Ollama) or $0.01/day (Haiku fallback)
 * - EOD summary:        $0  (Ollama) or $0.01/day (Haiku fallback)
 * - User chat:          ~$0.001/message (Haiku)
 * - Estimated total:    $2-8/month depending on chat volume
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
import { recordTrade, recordApiCall, upsertUsageStats, setUserBotConfig, getUserBotConfig, BOT_CONFIG_DEFAULTS, getTrades, logRejection, getRecentLessons, getPerformancePatterns, getDbUser, getDbUserByEmail, setDisabledSources, logActivity } from './db.js';
import { getFunds, getPositions as getMoomooPositions, getQuote as moomooGetQuote, placeMoomooTrade, cancelMoomooOrder, cancelAllMoomooOrders, closeMoomooPosition, MOOMOO_IS_SIMULATE } from './moomoo-tcp.js';
import { placeTigerOrder, closeTigerPosition, cancelTigerOrder, cancelAllTigerOrders, getTigerPositions, getTigerFunds, getTigerQuote, getTigerOrders } from './tiger.js';
import { isKnowledgeQuestion, answerKnowledgeQuestion, isTradeHistoryQuestion, answerTradeHistoryQuestion } from './knowledge.js';
import { getStockPrediction } from './predictor.js';
import { applyCalibration } from './prediction-calibration.js';
import { isFundamentalScreeningQuestion, screenFundamentals, formatScreenerAnswer } from './fundamental-screener.js';
import { runCatalystScan } from './catalyst-scanner.js';

// ─── Live quote — Yahoo Finance, no TradingView dependency ───────────────────

async function getLiveQuote(symbol) {
  if (!symbol) return { error: 'Symbol required' };

  // Tier 1: Moomoo (real-time)
  try {
    const q = await moomooGetQuote(symbol);
    if (q?.success && q.price != null) {
      return {
        symbol:     q.symbol ?? symbol.toUpperCase(),
        name:       q.name   ?? null,
        price:      +q.price.toFixed(2),
        change_pct: q.change_pct ?? null,
        prev_close: q.prev_close ?? null,
        day_high:   q.high  ?? null,
        day_low:    q.low   ?? null,
        volume:     q.volume ?? null,
        source:     'moomoo',
      };
    }
  } catch { /* fall through */ }

  // Tier 2: Yahoo Finance fallback
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return { error: `Yahoo Finance returned ${r.status}` };
    const d   = await r.json();
    const res = d?.chart?.result?.[0];
    if (!res) return { error: 'No data returned' };
    const meta   = res.meta ?? {};
    const q      = res.indicators?.quote?.[0] ?? {};
    const closes = (q.close ?? []).filter(v => v != null);
    const vols   = (q.volume ?? []).filter(v => v != null);
    const prev   = closes.at(-2) ?? null;
    const curr   = closes.at(-1) ?? meta.regularMarketPrice ?? null;
    const chgPct = prev && curr ? +((curr - prev) / prev * 100).toFixed(2) : null;
    return {
      symbol:     symbol.toUpperCase(),
      name:       meta.longName ?? meta.shortName ?? null,
      price:      curr != null ? +curr.toFixed(2) : null,
      change_pct: chgPct,
      prev_close: prev != null ? +prev.toFixed(2) : null,
      day_high:   meta.regularMarketDayHigh ?? null,
      day_low:    meta.regularMarketDayLow  ?? null,
      volume:     vols.at(-1) ?? null,
      source:     'yahoo',
    };
  } catch (err) {
    return { error: `Price fetch failed: ${err.message}` };
  }
}

const PRICE_INPUT_PER_M  = 3.00;   // claude-sonnet-4-6 input  $3.00/M tokens
const PRICE_OUTPUT_PER_M = 15.00;  // claude-sonnet-4-6 output $15.00/M tokens
function calcCost(inp, out) { return (inp / 1e6) * PRICE_INPUT_PER_M + (out / 1e6) * PRICE_OUTPUT_PER_M; }

// ─── Lessons cache (5-min TTL, per-user) ─────────────────────────────────────
const _lessonsCache = new Map(); // username (or '__system__') → { block, ts }
const LESSONS_TTL = 5 * 60 * 1000;

// ─── Earnings cache for held positions (30-min TTL per symbol) ───────────────
const _posEarningsCache = new Map(); // symbol → { date, confirmed, ts }
const POS_EARNINGS_TTL = 30 * 60 * 1000;

async function buildPositionEarningsBlock() {
  try {
    const posRes = await getMoomooPositions().catch(() => null);
    const positions = posRes?.positions ?? [];
    if (!positions.length) return '';

    const symbols = [...new Set(positions.map(p => p.symbol).filter(Boolean))];

    const results = await Promise.allSettled(
      symbols.map(async sym => {
        const cached = _posEarningsCache.get(sym);
        if (cached && Date.now() - cached.ts < POS_EARNINGS_TTL) return { sym, ...cached };
        const e = await getEarnings({ symbol: sym }).catch(() => null);
        const dates = e?.next_earnings_dates ?? [];
        const date = dates[0] ?? null;
        // Yahoo Finance calendarEvents dates are confirmed when present
        const confirmed = date !== null;
        _posEarningsCache.set(sym, { date, confirmed, ts: Date.now() });
        return { sym, date, confirmed };
      })
    );

    const lines = results
      .filter(r => r.status === 'fulfilled' && r.value?.date)
      .map(r => {
        const { sym, date, confirmed } = r.value;
        return `• ${sym}: ${date} (${confirmed ? 'confirmed' : 'estimated'})`;
      });

    if (!lines.length) return '';
    return (
      '\n\n━━━ HELD POSITIONS — NEXT EARNINGS (fetched live right now) ━━━\n' +
      lines.join('\n') +
      '\nIMPORTANT: These dates are authoritative. Do NOT contradict them with training-data guesses. State them exactly as shown.\n'
    );
  } catch {
    return '';
  }
}

async function buildLessonsBlock(username = null) {
  const key = username ?? '__system__';
  const cached = _lessonsCache.get(key);
  if (cached && Date.now() - cached.ts < LESSONS_TTL) return cached.block;

  const [lessons, patterns] = await Promise.all([
    getRecentLessons({ limit: 15, username }).catch(() => []),
    getPerformancePatterns({ username }).catch(() => []),
  ]);

  let block = '';

  if (lessons.length > 0) {
    block += '\n\nYOUR RECENT TRADING LESSONS (from actual closed trades — apply these):\n';
    for (const l of lessons) {
      const sign = l.outcome === 'win' ? '+' : '-';
      const pnl  = l.pnl_usd != null ? ` ($${sign}${Math.abs(l.pnl_usd).toFixed(0)})` : '';
      block += `• ${l.date} ${l.symbol ?? ''}${pnl}: ${l.lesson}\n`;
    }
  }

  if (patterns.length > 0) {
    block += '\nHISTORICAL WIN RATES BY REGIME (from your own trade history):\n';
    for (const p of patterns) {
      const rr = p.avg_pnl >= 0 ? `+$${p.avg_pnl}` : `-$${Math.abs(p.avg_pnl)}`;
      block += `• ${p.regime}: ${p.win_rate}% win rate over ${p.trades} trades (avg ${rr}/trade)\n`;
    }
    block += 'Favour regimes with >60% win rate. Be cautious in regimes below 40%.\n';
  }

  _lessonsCache.set(key, { block, ts: Date.now() });
  return block;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DEFAULT_WATCHLIST = [
  'MRVL','NVDA','AMD','AAPL','MSFT','GOOGL','META','AMZN',
  'TSLA','NFLX','INTC','QCOM','MU','AVGO','TSM','SMCI','RTX','LMT','XOM','JPM',
];

// In-memory history cache (shared across sessions keyed by chatId)
export const chatHistory = new Map();

// Tool results that are time-sensitive must never be replayed from history.
// Strip them so Claude always calls the tool fresh instead of using stale data.
const EPHEMERAL_TOOLS = new Set(['get_daily_pnl', 'get_market_status', 'get_market_regime']);

function _stripEphemeralToolResults(rows) {
  if (!rows?.length) return rows;
  // Collect tool_use_ids that belong to ephemeral tools (from assistant messages)
  const ephemeralIds = new Set();
  for (const msg of rows) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && EPHEMERAL_TOOLS.has(block.name)) {
        ephemeralIds.add(block.id);
      }
    }
  }
  if (!ephemeralIds.size) return rows;
  // Remove tool_use blocks and their matching tool_result blocks
  return rows
    .map(msg => {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const filtered = msg.content.filter(b => !(b.type === 'tool_use' && ephemeralIds.has(b.id)));
        if (!filtered.length) return null;
        return { ...msg, content: filtered };
      }
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const filtered = msg.content.filter(b => !(b.type === 'tool_result' && ephemeralIds.has(b.tool_use_id)));
        if (!filtered.length) return null;
        return { ...msg, content: filtered };
      }
      return msg;
    })
    .filter(Boolean);
}

// Patterns in assistant text that are time-sensitive and must not be replayed.
// These stale blocking messages cause Claude to refuse trades based on old data.
const _STALE_TEXT_PATTERNS = [
  /daily loss limit\s+(hit|reached|breached)/i,
  /trade blocked.*loss limit/i,
  /blocked.*daily loss/i,
  /P&L.*-\$[\d,.]+.*limit/i,
  /loss limit.*P&L/i,
  /loss limit.*-\$[\d,.]+.*blocked/i,
  /you.re at.*-\$[\d,.]+.*trading is stopped/i,
  /at -\$[\d,.]+ vs -\$[\d,.]+ ?(limit)?\.? ?blocked/i,
];

function _stripStaleBlockingText(rows) {
  if (!rows?.length) return rows;
  return rows.map(msg => {
    if (msg.role !== 'assistant') return msg;
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (text && _STALE_TEXT_PATTERNS.some(p => p.test(text))) return null;
    return msg;
  }).filter(Boolean);
}

export async function loadHistoryForChat(chatId) {
  if (chatHistory.has(chatId)) return;
  const rows = await loadConversationHistory(chatId, 20);
  const stripped = _stripEphemeralToolResults(rows ?? []);
  chatHistory.set(chatId, _stripStaleBlockingText(stripped));
}

export function pushHistory(chatId, message) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const h = chatHistory.get(chatId);
  h.push(message);
  if (h.length > 20) h.splice(0, h.length - 20);
  if (isDbAvailable()) appendConversationMessage(chatId, message).catch(() => {});
}

export function clearHistory(chatId) {
  chatHistory.delete(chatId);
  if (isDbAvailable()) clearConversationHistory(chatId).catch(() => {});
}

export function buildSystemPrompt(userCfg = null, username = null) {
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
7. NEVER state specific positions, prices, quantities, or P&L figures without first calling get_portfolio in the same response. If you have not called get_portfolio this turn, you do not know what positions exist. Say "Let me check your positions" and call the tool — never guess or recall from memory.
8. Conversation history is NOT a reliable source of position data. Positions change between messages (fills, stops hit, manual closes). Always fetch fresh data before stating any position details.

━━━ WHEN THE USER IS FRUSTRATED ━━━
If the user says you are too restrictive, blocking trades, or not useful:
- Acknowledge the frustration in ONE sentence.
- Briefly explain the specific rule that triggered (e.g. "VIX is 38 — that's your crisis threshold, not mine").
- Offer a path forward: "Want me to lower your min conviction to 45 or raise your VIX threshold? I can update your config now."
- NEVER agree to bypass safety rules entirely.
- NEVER say "when you say buy I will buy" — that removes all capital protection and is not what the bot is designed to do.
- NEVER apologise by inventing trade data or position details.

The safety rules (VIX limits, conviction floor, daily loss limit, time blocks) exist to protect the user's capital — they are not negotiable based on frustration. The config thresholds ARE adjustable if the user wants to change their own strategy — guide them there instead.

Example correct response to frustration:
"Fair point — I blocked that because RSI was 78 and overbought for your moderate profile. If you want to trade more aggressively, I can raise your conviction floor from 50 to 40 and set your profile to aggressive. Want me to do that?"

Example wrong response (never do this):
"You're right, I'll just execute whatever you say from now on."

━━━ PROACTIVE SCAN WORKFLOW ━━━
The scanner evaluates a dynamic universe of up to 120 stocks every scan — day gainers, most active by volume, trending, and day losers pulled live from Yahoo Finance every 15 minutes. Any liquid US stock that is moving today will appear automatically. There is no fixed preset list — BE, FSLR, HOOD, or any active mover will be found if it qualifies.

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
□ Daily P&L within limits — CALL get_daily_pnl NOW (do NOT use any P&L value from earlier in conversation — always fetch fresh)
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
  "be conservative"               → profile='conservative'
  "go aggressive"                 → profile='aggressive'
  "raise threshold"               → min_conviction_score: N
  "block energy"                  → sectors_blocklist: ['XLE']
  "bigger targets"                → daily_profit_target: N
  "trade with Tiger / real account" → trade_source='tiger'
  "trade with Moomoo"             → trade_source='moomoo'
  "switch back to paper"          → trade_source='paper'

trade_source controls where the bot EXECUTES trades:
  paper  = Alpaca paper account (safe, simulated)
  tiger  = Tiger Brokers real account (REAL MONEY — confirm with user before switching)
  moomoo = Moomoo real account (REAL MONEY — confirm with user before switching)

When switching to tiger or moomoo: ALWAYS warn the user this uses real money and ask them to confirm.

CRITICAL: If propose_trade returns status: 'error' with broker: 'tiger' — do NOT call moomoo_place_trade as a fallback. Instead, explain the specific error (use the hint field), and ask the user if they want to execute as a paper trade on Alpaca instead by switching trade_source to 'paper'.

━━━ HOW THE SCANNER WORKS (be accurate when asked) ━━━
When a user asks "how do you pick trades?", "what did you use?",
"do you use ML?", or "how does your analysis work?", answer accurately:

The scanner uses a 3-layer pipeline:

Layer 1 — Market Context (fully deterministic, no AI):
  • VIX level and trend
  • Sector performance (11 sectors vs SPY)
  • Market regime detection: trending / volatile / news-driven / choppy
  • Earnings catalysts today

Layer 2 — ML Conviction Scoring (backtested, no AI cost):
  • RSI, MACD, EMA trend, Bollinger Bands — computed locally
  • Relative strength vs sector
  • Pre-earnings drift analysis
  • 3-year backtest adjustment: grade A/B/C/F signals are weighted by
    their actual historical win rate and alpha vs SPY
  • Performance pattern boost: if this regime historically wins >65%,
    score gets +8; if <40% win rate, score gets -10
  • Conviction score 0–100 produced per candidate

Layer 3 — Claude Haiku final judgment:
  • Receives top 6 candidates with ML scores and backtest adjustments
  • Picks the single best trade based on news catalyst + ML signal
  • Final conviction = 60% ML score + 40% Claude judgment (blended)

So YES — the scanner uses machine learning and 3 years of backtested data.
The ML model adjusts every conviction score based on what historically
worked in the same market regime with the same indicator combinations.

NEVER say you don't use ML or backtest data when asked.
ALWAYS describe the 3-layer pipeline when asked how the scanner works.

━━━ AUTONOMOUS BEHAVIOUR ━━━
You are always working in the background. You automatically:
• Send a morning briefing at market open (9:30 AM ET)
• Scan for the best trade setup every 10 minutes during market hours
• Monitor open positions every 2 minutes — move stops, trail targets
• Alert when positions approach their target (80%) or stop (85%)
• Close all positions at 3:50 PM ET automatically
• Check for market regime changes every 15 minutes
• Send an end-of-day P&L summary at 4:00 PM ET

━━━ RESPONSE LENGTH — MATCH THE QUESTION ━━━
• "hello" / "hi" / "hey" / "gm" / any casual greeting → ONE sentence max. e.g. "Hey — 2 positions open, market's running. What do you need?" Do NOT volunteer tables, bullet lists, P&L summaries, or market snapshots.
• "how are my positions?" / "check trades" → brief table, skip the preamble
• "scan" / "find a trade" → follow scan workflow above
• "status" / "what's going on?" → 3–5 lines max: open positions (one line each), today's P&L, regime. No headers.
• Simple questions → one sentence answers
• Config changes → one sentence confirmation

NEVER open a response to a casual greeting with a market snapshot, table, or emoji-heavy briefing.
NEVER add section headers or bullet lists to conversational replies.
A greeting is not a status request. Only give detail when the user explicitly asks for it.

WHEN ASKED "what are you doing?" OR "status?" — be specific and brief:
✅ "Scan ran 3 min ago — nothing above 70. NVDA is 60% toward target."
✅ "Monitoring SBUX — stop moved to breakeven. Up $74 today."
❌ Never say "I'm monitoring the market" without a specific number or symbol.

━━━ RESPONSE FORMAT ━━━
Default to plain conversational sentences. Avoid bullet lists and headers unless the user is explicitly requesting data or a list.

Use a compact table ONLY when the user asks for position status, trade history, or a ranked list of stocks. Keep tables to ≤5 rows — drop columns if needed to stay readable.

Trade recommendation (table only when proposing a specific trade):
SYMBOL | score | entry | target (+X%) | stop (-Y%) | why

For everything else — analysis, market color, explanations, casual questions — write 1–3 sentences like you're talking to the user, not filing a report.

━━━ SESSION IDENTITY ━━━
Trading on behalf of: ${username ?? 'unknown'}
Your lessons, win-rate patterns, and trade history are specific to this user.${userCfg?.role === 'admin' ? `

━━━ ADMIN TOOLS (you are logged in as admin) ━━━
You have two extra tools for managing user broker access:

get_user_info — look up any user by username OR email address.
  Use this first whenever the request mentions an email address — it returns the username you need.

set_broker_access — enable or disable specific broker accounts for a user.
  Valid sources: alpaca (paper), alpaca_live, moomoo, tiger.
  "disable" = sources to turn off. "enable" = sources to turn back on.
  You CAN disable paper (alpaca) — no forced fallback. Admin has full control.

Example flows:
  "disable paper, keep Tiger for pavan_acct2" →
    set_broker_access(username="pavan_acct2", disable=["alpaca","alpaca_live","moomoo"])

  "only allow Tiger for pavanch.bmw@gmail.com" →
    1. get_user_info(identifier="pavanch.bmw@gmail.com")  → get username
    2. set_broker_access(username=<result>, disable=["alpaca","alpaca_live","moomoo"])

  "re-enable Alpaca for pavan_acct2" →
    set_broker_access(username="pavan_acct2", enable=["alpaca","alpaca_live"])

NEVER say you cannot manage broker access — you have set_broker_access for this.` : ''}`;
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
  { name: 'get_portfolio',       description: 'Get current portfolio for the active trading account: balance, buying power, open positions. Routes to whichever broker is configured (Alpaca paper, Tiger, or Moomoo).', input_schema: { type: 'object', properties: {} } },
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
  { name: 'get_daily_pnl',       description: `ALWAYS call this live — never use a cached value from earlier in conversation. Returns today's realized P&L from this user's own trade history (not global Alpaca account). Checks against their daily_profit_target and daily_loss_limit from bot config.`, input_schema: { type: 'object', properties: {} } },
  { name: 'get_live_quote',       description: 'Get current price, change%, volume, and day range for any stock via Yahoo Finance — always works, no TradingView needed. Use this first when you need a current price.',
                                                input_schema: { type: 'object', properties: { symbol: { type: 'string', description: 'Ticker, e.g. BAND' } }, required: ['symbol'] } },
  { name: 'get_chart_technicals', description: 'Read RSI, MACD, EMAs, Bollinger Bands from TradingView. If it returns available:false, fall back to get_live_quote for price.',
                                                input_schema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'get_price_levels',    description: 'Read support/resistance levels from TradingView Pine Script indicators.',            input_schema: { type: 'object', properties: { symbol: { type: 'string' }, study_filter: { type: 'string' } } } },
  { name: 'get_ohlcv_summary',   description: 'Get compact OHLCV summary from TradingView. If it returns available:false, use get_live_quote instead.',
                                                input_schema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'get_conviction_score', description: 'Get multi-factor conviction score (0–100). Always call before propose_trade.',     input_schema: { type: 'object', properties: { symbol: { type: 'string' }, positions: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' } } } } }, required: ['symbol'] } },
  { name: 'get_earnings_surprise', description: 'Get earnings date, EPS estimate, and historical beat streak.',                    input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
  { name: 'get_my_config',        description: "Read the user's current bot configuration (risk profile, daily limits, position sizing, VIX thresholds, conviction threshold, blocked sectors). Call this before suggesting or applying any config changes so you know the current state.", input_schema: { type: 'object', properties: {} } },
  { name: 'update_my_config',     description: "Update the user's bot configuration. Only include fields you want to change — omitted fields keep their current values. Use profile='conservative'|'moderate'|'aggressive' to apply a full preset, or set individual fields. Always confirm the change out loud after applying.",
    input_schema: {
      type: 'object',
      properties: {
        profile:              { type: 'string',  enum: ['conservative','moderate','aggressive','custom'], description: 'Apply a risk profile preset' },
        trade_source:         { type: 'string',  enum: ['paper','tiger','moomoo'], description: 'Which broker to execute bot trades on: paper (Alpaca), tiger (Tiger Brokers real account), moomoo (Moomoo real account)' },
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

  {
    name: 'get_stock_prediction',
    description: 'Run all 5 prediction algorithms for a stock: (1) linear regression trend with day5/day10 price projections, (2) ATR-based expected move ranges for 1/5/10 days, (3) momentum score 0-100 from RSI/EMA/MACD/volume, (4) personal trade pattern analysis from your own trade history for this symbol, (5) earnings catalyst model with next earnings date and momentum. Returns an overall signal score 0-100. Use this when the user asks for a price prediction, price target, outlook, or "where is X headed".',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Stock ticker e.g. NVDA, AAPL, TSLA' },
      },
      required: ['symbol'],
    },
  },

  // ── Moomoo trading tools ──────────────────────────────────────────────────
  {
    name: 'moomoo_portfolio',
    description: 'Get Moomoo account balance, buying power, and all open positions with unrealized P&L. Call this when the user asks about their Moomoo account or real positions (not Alpaca paper trades).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'moomoo_place_trade',
    description: 'Place a market order on Moomoo with optional stop-loss and take-profit. Runs in PAPER (simulate) mode unless MOOMOO_TRADE_ENV=1 is set. Always show the user the simulate/live status before confirming. Require conviction >= min_conviction_score before calling.',
    input_schema: {
      type: 'object',
      properties: {
        symbol:            { type: 'string',  description: 'Stock ticker, e.g. AAPL' },
        side:              { type: 'string',  enum: ['buy','sell'], description: 'Trade direction' },
        qty:               { type: 'number',  description: 'Number of shares' },
        stop_price:        { type: 'number',  description: 'Stop-loss price (stop-market sell). Omit to skip.' },
        take_profit_price: { type: 'number',  description: 'Take-profit price (market-if-touched sell). Omit to skip.' },
        trailing_pct:      { type: 'number',  description: 'Trailing stop percentage (e.g. 3 = 3%). Overrides take_profit_price if both set.' },
      },
      required: ['symbol', 'side', 'qty'],
    },
  },
  {
    name: 'moomoo_close_position',
    description: 'Close an entire Moomoo position at market price. Looks up the current qty automatically — just pass the symbol.',
    input_schema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'Stock ticker to close' } },
      required: ['symbol'],
    },
  },
  {
    name: 'moomoo_cancel_all_orders',
    description: 'Cancel ALL open/pending Moomoo orders (stop-loss and take-profit bracket legs). Call this before closing a position if it has pending orders that may block the fill.',
    input_schema: { type: 'object', properties: {} },
  },

  // ── Admin: broker access control ─────────────────────────────────────────
  {
    name: 'set_broker_access',
    description: 'Admin only. Enable or disable specific broker accounts for a user. Use this to restrict a user to certain brokers (e.g. Tiger only). ALL sources including paper (alpaca) can be disabled. Find the username from email if needed using get_user_info first.',
    input_schema: {
      type: 'object',
      properties: {
        username:    { type: 'string', description: 'Username to modify (e.g. pavan_acct2). If you only have an email, call get_user_info first.' },
        disable:     { type: 'array',  items: { type: 'string', enum: ['alpaca','alpaca_live','moomoo','tiger'] }, description: 'Broker sources to disable for this user. Use "alpaca" for paper trading.' },
        enable:      { type: 'array',  items: { type: 'string', enum: ['alpaca','alpaca_live','moomoo','tiger'] }, description: 'Broker sources to re-enable (remove from disabled list).' },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_user_info',
    description: 'Admin only. Look up a user by username or email address. Returns username, email, role, and current broker access settings.',
    input_schema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Username or email address to look up.' },
      },
      required: ['identifier'],
    },
  },

  {
    name: 'scan_catalyst_movers',
    description: 'Scan for pre-market explosive movers and catalysts — CNSP/SKK/GBTG-type setups. Runs 4 detectors in parallel: (1) pre-market gap screener (≥5% gap, >100K volume), (2) SEC 8-K filings from last few hours (acquisitions, press releases, material events), (3) low-float setups (<20M float + RVOL>1.5), (4) biotech/pharma catalyst news (FDA/PDUFA/clinical trial headlines from last 72h). Use this before market open or when looking for high-momentum small-cap plays. Results are cached 10 minutes.',
    input_schema: { type: 'object', properties: {} },
  },
];

const _CHAT_PROFILE_PRESETS = {
  conservative: { profile:'conservative', daily_profit_target:75,  daily_loss_limit:100, max_open_positions:1, min_conviction_score:65, auto_execute:false, max_vix_for_scan:22, position_sizing:{ target_profit_per_trade:75,  min_dollars:500,  max_dollars:2000,  stop_multiplier:1.5, target_multiplier:3.0, min_atr_pct:1.0 }, vix_thresholds:{ defensive:20, crisis:30 }, sectors_blocklist:[] },
  moderate:     { profile:'moderate',     daily_profit_target:150, daily_loss_limit:200, max_open_positions:2, min_conviction_score:50, auto_execute:true,  max_vix_for_scan:30, position_sizing:{ target_profit_per_trade:150, min_dollars:1500, max_dollars:5000,  stop_multiplier:1.5, target_multiplier:3.0, min_atr_pct:1.0 }, vix_thresholds:{ defensive:25, crisis:35 }, sectors_blocklist:[] },
  aggressive:   { profile:'aggressive',   daily_profit_target:300, daily_loss_limit:500, max_open_positions:3, min_conviction_score:35, auto_execute:true,  max_vix_for_scan:40, position_sizing:{ target_profit_per_trade:300, min_dollars:3000, max_dollars:10000, stop_multiplier:1.5, target_multiplier:3.0, min_atr_pct:0.8 }, vix_thresholds:{ defensive:30, crisis:45 }, sectors_blocklist:[] },
};

// Map each tool to the broker source it accesses
const _TOOL_SOURCE_MAP = {
  moomoo_portfolio:       'moomoo',
  moomoo_place_trade:     'moomoo',
  moomoo_close_position:  'moomoo',
  moomoo_cancel_all_orders: 'moomoo',
};

// Maps trade_source config values → disabled_sources DB keys (they use different naming)
const _TRADE_SOURCE_TO_DISABLED_KEY = { paper: 'alpaca', alpaca_live: 'alpaca_live', tiger: 'tiger', moomoo: 'moomoo' };

// Maps trade_source → account_source value stored in the trades table
function _tradeSourceToAccountSource(src) {
  return { paper: 'alpaca_paper', alpaca_live: 'alpaca_live', tiger: 'tiger', moomoo: 'moomoo' }[src] ?? 'alpaca_paper';
}

// Returns the effective trade source for a user, routing around disabled sources.
// Preference order when blocked: tiger → moomoo → paper (Alpaca always last resort).
function _resolveTradeSource(rawSrc, disabledSources) {
  const dis = Array.isArray(disabledSources) ? disabledSources : [];
  const isDisabled = src => dis.includes(_TRADE_SOURCE_TO_DISABLED_KEY[src] ?? src);
  if (!isDisabled(rawSrc)) return rawSrc;
  return ['tiger', 'moomoo', 'paper'].find(s => !isDisabled(s)) ?? 'paper';
}

export async function executeTool(name, input, { onTrade, userCfg, username } = {}) {
  try {
    // ── Broker access enforcement ──────────────────────────────────────────
    // disabled_sources is set by admin per-user and must be respected by the bot,
    // just as it is by the dashboard UI. Never let a tool bypass this gate.
    if (username && _TOOL_SOURCE_MAP[name]) {
      const _dbU = await getDbUser(username).catch(() => null);
      const _dis = Array.isArray(_dbU?.disabled_sources) ? _dbU.disabled_sources : [];
      if (_dis.includes(_TOOL_SOURCE_MAP[name])) {
        return { error: `Access denied: the ${_TOOL_SOURCE_MAP[name]} broker is not enabled for your account. Contact the admin.` };
      }
    }
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
        // Check disabled_sources — route around any source the admin has disabled
        const _pDbU  = username ? await getDbUser(username).catch(() => null) : null;
        const _pDis  = Array.isArray(_pDbU?.disabled_sources) ? _pDbU.disabled_sources : [];
        const _rawTs = userCfg?.trade_source ?? 'paper';
        const tradeSource = _resolveTradeSource(_rawTs, _pDis);
        if (tradeSource === 'tiger' && username) {
          const dbU = await getDbUser(username).catch(() => null);
          if (dbU?.tiger_id && dbU?.tiger_account && dbU?.tiger_private_key) {
            const creds = { tiger_id: dbU.tiger_id, account: dbU.tiger_account, private_key: dbU.tiger_private_key };
            const [funds, positions] = await Promise.allSettled([getTigerFunds(creds), getTigerPositions(creds)]);
            const f = funds.status === 'fulfilled' ? funds.value : null;
            const p = positions.status === 'fulfilled' ? positions.value : [];
            return {
              account: f ? { source: 'tiger', portfolio_value: f.net_liquidation_value, buying_power: f.buying_power, cash: f.cash, unrealized_pl: f.unrealized_pl } : null,
              positions: p.map(pos => ({
                symbol: pos.symbol ?? pos.contract?.symbol, qty: pos.quantity ?? pos.qty,
                avg_entry_price: pos.averageCost ?? pos.avg_cost, current_price: pos.latestPrice ?? pos.market_price,
                unrealized_pl: pos.unrealizedPnl ?? pos.unrealized_pl,
              })),
              open_orders: [], trade_source: 'tiger',
            };
          }
        }
        if (tradeSource === 'moomoo') {
          const dbU = await getDbUser(username).catch(() => null);
          const [funds, positions] = await Promise.allSettled([getFunds({ acc_id: dbU?.moomoo_acc_id }), getMoomooPositions({ acc_id: dbU?.moomoo_acc_id })]);
          const f = funds.status === 'fulfilled' ? funds.value : null;
          const p = positions.status === 'fulfilled' ? positions.value : null;
          return {
            account: f ? { source: 'moomoo', portfolio_value: f.total_assets, buying_power: f.buying_power, cash: f.cash, unrealized_pl: p?.total_unrealized_pl ?? 0 } : null,
            positions: (p?.positions || []).map(pos => ({ symbol: pos.symbol, qty: pos.qty, avg_entry_price: pos.avg_cost, current_price: pos.current_price, unrealized_pl: pos.unrealized_pl })),
            open_orders: [], trade_source: 'moomoo',
          };
        }
        const [account, positions, orders] = await Promise.all([getAccount(), getPositions(), getOrders()]);
        return { account, positions, open_orders: orders, trade_source: 'paper' };
      }
      case 'propose_trade': {
        // SERVER-SIDE HARD GATE: always verify P&L fresh from DB before any trade.
        // Scoped to the active account_source so Moomoo P&L never blocks Alpaca trades and vice versa.
        if (username) {
          try {
            const _gTodayStr  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            const _gSrc       = _tradeSourceToAccountSource(userCfg?.trade_source ?? 'paper');
            const _gClosed    = await getTrades({ username, status: 'closed', account_source: _gSrc, limit: 500 });
            const _gPnl       = (_gClosed ?? [])
              .filter(t => t.closed_at && new Date(t.closed_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === _gTodayStr)
              .reduce((sum, t) => sum + (parseFloat(t.pnl_usd) || 0), 0);
            const _gLimit     = userCfg?.daily_loss_limit ?? DAILY_LOSS_LIMIT;
            if (_gPnl <= -_gLimit) {
              return {
                status:  'blocked_loss_limit',
                pnl:     +_gPnl.toFixed(2),
                limit:   -_gLimit,
                reason:  `Daily loss limit reached for ${username} on ${_gSrc}. Realized P&L today: $${_gPnl.toFixed(2)} (limit: -$${_gLimit}).`,
              };
            }
            // P&L is within limits — proceed regardless of what conversation history says
          } catch {
            // DB error → allow trade (never block on infrastructure failure)
          }
        }

        const _tDbU = username ? await getDbUser(username).catch(() => null) : null;
        const _tDis = Array.isArray(_tDbU?.disabled_sources) ? _tDbU.disabled_sources : [];
        const tradeSource = _resolveTradeSource(userCfg?.trade_source ?? 'paper', _tDis);

        // Fetch current positions from the right broker for duplicate check
        let curPositions = [];
        if (tradeSource === 'tiger' && username) {
          const dbU = await getDbUser(username).catch(() => null);
          if (dbU?.tiger_id) {
            const creds = { tiger_id: dbU.tiger_id, account: dbU.tiger_account, private_key: dbU.tiger_private_key };
            curPositions = await getTigerPositions(creds).catch(() => []);
          }
        } else if (tradeSource === 'moomoo') {
          const dbU = await getDbUser(username).catch(() => null);
          const p = await getMoomooPositions({ acc_id: dbU?.moomoo_acc_id }).catch(() => null);
          curPositions = p?.positions ?? [];
        } else {
          curPositions = await getPositions().catch(() => []);
        }

        const convictionResult = await getConvictionScore({ symbol: input.symbol, positions: curPositions }).catch(() => null);
        const convictionScore     = convictionResult?.score    ?? null;
        const convictionGrade     = convictionResult?.grade    ?? null;
        const convictionBreakdown = convictionResult?.breakdown ?? null;

        const minConv = userCfg?.min_conviction_score ?? 45;
        if (convictionScore !== null && convictionScore < minConv) {
          const reason = `Conviction score ${convictionScore}/100 is below your minimum of ${minConv} (grade: ${convictionGrade})`;
          logRejection({ symbol: input.symbol, reason, conviction_score: convictionScore }).catch(() => {});
          return { status: 'rejected', reason, conviction_score: convictionScore, conviction_grade: convictionGrade };
        }

        // Route execution to the user's chosen broker
        if (tradeSource === 'tiger' && username) {
          const dbU = await getDbUser(username).catch(() => null);
          if (!dbU?.tiger_id) return { status: 'error', reason: 'Tiger account not configured for this user.' };
          const creds = { tiger_id: dbU.tiger_id, account: dbU.tiger_account, private_key: dbU.tiger_private_key };
          // Get live price for position sizing — Tiger first, Yahoo Finance fallback
          const tigerQ = await getTigerQuote(creds, input.symbol).catch(() => ({ ask: null, last: null }));
          let price = tigerQ.ask ?? tigerQ.last ?? null;
          let priceSource = 'tiger';
          if (!price) {
            const yq = await getLiveQuote(input.symbol);
            price = yq.price ?? null;
            priceSource = 'yahoo';
          }
          if (!price) return { status: 'error', reason: `Could not get live price for ${input.symbol} from Tiger or Yahoo Finance.` };
          const sizing = userCfg?.position_sizing || {};
          const targetProfit = sizing.target_profit_per_trade ?? 150;
          const minDol = sizing.min_dollars ?? 1500;
          const maxDol = sizing.max_dollars ?? 5000;
          const dollars = Math.min(maxDol, Math.max(minDol, Math.round(targetProfit / 0.05)));
          const qty = Math.max(1, Math.floor(dollars / price));
          // Auto-convert MKT → LMT outside regular hours so pre/post-market works.
          // Only use outside_rth if the price came from Tiger itself — Yahoo Finance
          // prices can diverge from Tiger's reference and cause "price exceeds ±10%" rejections.
          let tigerLimitPrice = null;
          let tigerOutsideRth = false;
          const mktClock = await getMarketStatus().catch(() => null);
          if (!mktClock?.is_open) {
            if (priceSource !== 'tiger') {
              return { status: 'error', broker: 'tiger', do_not_fallback: true,
                symbol: input.symbol, side: input.side,
                reason: 'Market is closed and Tiger real-time quote is unavailable right now. Cannot safely set a limit price — Tiger rejects orders where the price is >10% from its own reference. Try again during market hours (9:30 AM – 4:00 PM ET).',
                hint: 'Wait for market open or switch to paper trading.' };
            }
            tigerLimitPrice = +price.toFixed(2);
            tigerOutsideRth = true;
          }
          let result;
          try {
            result = await placeTigerOrder(creds, { symbol: input.symbol, side: input.side, qty, limitPrice: tigerLimitPrice, outsideRth: tigerOutsideRth });
          } catch (tigerErr) {
            const msg = tigerErr.message ?? '';
            const isPriceError      = /price.*limit|exceed.*10|outside.*band|price.*band/i.test(msg);
            const isPermissionError = msg.includes('not support') || msg.includes('1000') || msg.includes('error 4:') || msg.includes('permission');
            const hint = isPermissionError
              ? 'Tiger OpenAPI trading permission is not enabled. Go to Tiger App → Profile → OpenAPI → enable Trading permissions, then regenerate your API key.'
              : isPriceError
              ? `Tiger rejected the order because the limit price $${tigerLimitPrice} is more than 10% from Tiger's reference price. This often happens outside regular hours when Tiger's reference differs from Yahoo Finance. Try during market hours or use paper trading.`
              : 'Check the server logs for the full Tiger API error code and message.';
            // do_not_fallback tells Claude not to retry with moomoo — offer paper trading instead
            return { status: 'error', broker: 'tiger', do_not_fallback: true, symbol: input.symbol, side: input.side, qty, estimated_price: price,
              reason: msg, hint };
          }
          recordTrade({ username, order_id: String(result.order_id), symbol: input.symbol, side: input.side, qty, entry_price: price, conviction_score: convictionScore, conviction_grade: convictionGrade, conviction_breakdown: convictionBreakdown, account_source: 'tiger' }).catch(() => {});
          if (onTrade) onTrade(result);
          const extNote = tigerOutsideRth ? ` (extended hours limit @ $${tigerLimitPrice})` : '';
          return { status: 'executed', broker: 'tiger', symbol: input.symbol, side: input.side, qty, estimated_price: price, price_source: priceSource, order_id: result.order_id, conviction_score: convictionScore, note: extNote };
        }

        if (tradeSource === 'moomoo') {
          const dbU = await getDbUser(username).catch(() => null);
          if (!dbU?.moomoo_acc_id && userCfg?.role !== 'admin')
            return { status: 'error', reason: 'Moomoo is not configured for your account.' };
          const mq = await moomooGetQuote(input.symbol).catch(() => null);
          let price = mq?.ask ?? mq?.last_price ?? null;
          let priceSource = 'moomoo';
          if (!price) {
            const yq = await getLiveQuote(input.symbol);
            price = yq.price ?? null;
            priceSource = 'yahoo';
          }
          if (!price) return { status: 'error', reason: `Could not get live price for ${input.symbol} from Moomoo or Yahoo Finance.` };
          const sizing = userCfg?.position_sizing || {};
          const dollars = Math.min(sizing.max_dollars ?? 5000, Math.max(sizing.min_dollars ?? 1500, Math.round((sizing.target_profit_per_trade ?? 150) / 0.05)));
          const qty = Math.max(1, Math.floor(dollars / price));
          const result = await placeMoomooTrade({ symbol: input.symbol, side: input.side, qty, acc_id: dbU?.moomoo_acc_id }).catch(e => { throw e; });
          recordTrade({ username, order_id: String(result.order_id ?? ''), symbol: input.symbol, side: input.side, qty, entry_price: price, conviction_score: convictionScore, conviction_grade: convictionGrade, conviction_breakdown: convictionBreakdown, account_source: 'moomoo' }).catch(() => {});
          if (onTrade) onTrade(result);
          return { status: 'executed', broker: 'moomoo', symbol: input.symbol, side: input.side, qty, estimated_price: price, conviction_score: convictionScore };
        }

        // Default: Alpaca paper
        const result = await placeTrade({
          symbol: input.symbol, side: input.side, use_atr: true,
          trailing_stop: input.trailing_stop ?? false, note: input.reasoning,
          userCfg: userCfg ?? null, conviction_score: convictionScore,
          conviction_grade: convictionGrade, conviction_breakdown: convictionBreakdown,
        });
        recordTrade({
          username,
          order_id: result.order_id, symbol: result.symbol, side: result.side,
          qty: result.qty, entry_price: result.estimated_price,
          stop_loss: result.stop_loss, take_profit: result.take_profit,
          dollars_invested: result.dollars_invested,
          stop_loss_pct: result.stop_loss_pct, take_profit_pct: result.take_profit_pct,
          atr_pct: result.atr_pct, conviction_score: convictionScore,
          conviction_grade: convictionGrade, conviction_breakdown: convictionBreakdown,
          account_source: 'alpaca_paper',
        }).catch(() => {});
        if (onTrade) onTrade(result);
        return { status: 'executed', broker: 'paper', ...result };
      }
      case 'close_position': {
        const tradeSource = userCfg?.trade_source ?? 'paper';
        if (tradeSource === 'tiger' && username) {
          const dbU = await getDbUser(username).catch(() => null);
          if (dbU?.tiger_id) {
            const creds = { tiger_id: dbU.tiger_id, account: dbU.tiger_account, private_key: dbU.tiger_private_key };
            return await closeTigerPosition(creds, input.symbol);
          }
        }
        if (tradeSource === 'moomoo') {
          return await closeMoomooPosition(input.symbol);
        }
        return await closePosition(input.symbol);
      }
      case 'get_market_status':      return await getMarketStatus();
      case 'get_market_regime':      return await getMarketRegime({ defensive_vix: userCfg?.vix_thresholds?.defensive ?? 25, crisis_vix: userCfg?.vix_thresholds?.crisis ?? 35 });
      case 'close_stale_positions':  return await closeStalePositions({ maxDays: input.max_days || 3, threshold_pct: input.threshold_pct ?? -1 });
      case 'get_open_orders': {
        const tradeSource = userCfg?.trade_source ?? 'paper';
        if (tradeSource === 'tiger' && username) {
          const dbU = await getDbUser(username).catch(() => null);
          if (dbU?.tiger_id) {
            const creds = { tiger_id: dbU.tiger_id, account: dbU.tiger_account, private_key: dbU.tiger_private_key };
            return await getTigerOrders(creds, { days: 1 });
          }
        }
        return await getOrders();
      }
      case 'cancel_order': {
        const _coSrc = userCfg?.trade_source ?? 'paper';
        if (_coSrc === 'tiger' && username) {
          const _coDbU = await getDbUser(username).catch(() => null);
          if (_coDbU?.tiger_id) {
            const _coCreds = { tiger_id: _coDbU.tiger_id, account: _coDbU.tiger_account, private_key: _coDbU.tiger_private_key };
            return await cancelTigerOrder(_coCreds, input.order_id);
          }
        }
        return await cancelOrder(input.order_id);
      }
      case 'cancel_all_orders': {
        const tradeSource = userCfg?.trade_source ?? 'paper';
        if (tradeSource === 'tiger' && username) {
          const dbU = await getDbUser(username).catch(() => null);
          if (dbU?.tiger_id) {
            const creds = { tiger_id: dbU.tiger_id, account: dbU.tiger_account, private_key: dbU.tiger_private_key };
            return await cancelAllTigerOrders(creds);
          }
        }
        if (tradeSource === 'moomoo') return await cancelAllMoomooOrders();
        return await cancelAllOrders();
      }
      case 'scan_for_trades': {
        const maxCandidates = Math.min(input.max_candidates || 5, 8);
        // Get current positions from the user's active broker (not always system paper)
        let scanPositions = [];
        const _sDbU   = username ? await getDbUser(username).catch(() => null) : null;
        const _sDis   = Array.isArray(_sDbU?.disabled_sources) ? _sDbU.disabled_sources : [];
        const _rawSrc = userCfg?.trade_source ?? 'paper';
        const scanSource = _resolveTradeSource(_rawSrc, _sDis);
        if (scanSource === 'tiger' && username) {
          const _dbU = await getDbUser(username).catch(() => null);
          if (_dbU?.tiger_id) {
            const _creds = { tiger_id: _dbU.tiger_id, account: _dbU.tiger_account, private_key: _dbU.tiger_private_key };
            scanPositions = await getTigerPositions(_creds).catch(() => []);
          }
        } else if (scanSource === 'moomoo' && username) {
          const _dbU = await getDbUser(username).catch(() => null);
          const _p = await getMoomooPositions({ acc_id: _dbU?.moomoo_acc_id }).catch(() => null);
          scanPositions = _p?.positions ?? [];
        } else {
          scanPositions = await getPositions().catch(() => []);
        }
        const [movers] = await Promise.all([getMarketMovers({ limit: 30 })]);
        const heldSymbols = new Set(scanPositions.map(p => (p.symbol ?? p.contract?.symbol ?? '').toUpperCase()));
        const symbols = [
          ...(movers?.gainers?.map(m => m.symbol) ?? []),
          ...(movers?.actives?.map(m => m.symbol) ?? []),
        ].filter((s, i, arr) => arr.indexOf(s) === i)
         .filter(s => !heldSymbols.has(s.toUpperCase()))
         .slice(0, maxCandidates);
        if (!symbols.length) return { no_candidates: true, reason: 'No movers found or all top movers already in portfolio' };
        const scored = await Promise.allSettled(
          symbols.map(sym => getConvictionScore({ symbol: sym, positions: scanPositions }))
        );
        const results = scored
          .filter(r => r.status === 'fulfilled' && r.value?.score != null)
          .map(r => ({ symbol: r.value.symbol ?? r.value.ticker ?? symbols[scored.indexOf(scored.find(x => x === r))], score: r.value.score, grade: r.value.grade, summary: r.value.summary }))
          .sort((a, b) => b.score - a.score);
        return { scanned: symbols.length, positions_held: [...heldSymbols], candidates: results };
      }
      case 'get_trade_history': {
        // Scoped to the calling user AND their active broker account
        const _thSrc = _tradeSourceToAccountSource(userCfg?.trade_source ?? 'paper');
        const trades = await getTrades({ status: input.status, limit: input.limit || 20, username, account_source: _thSrc });
        if (!trades) return { error: 'Trade history unavailable — database not connected' };
        return { trades, count: trades.length };
      }
      case 'move_stop_to_breakeven': {
        const _msSrc = userCfg?.trade_source ?? 'paper';
        if (_msSrc === 'tiger' || _msSrc === 'moomoo') {
          return { status: 'unsupported', reason: `Move-stop-to-breakeven is not supported for ${_msSrc} via API. Adjust your stop manually in the ${_msSrc === 'tiger' ? 'Tiger' : 'Moomoo'} app.` };
        }
        return await moveStopToBreakeven(input.symbol);
      }
      case 'get_daily_pnl': {
        const _pnlLimit  = userCfg?.daily_loss_limit  ?? DAILY_LOSS_LIMIT;
        const _pnlTarget = userCfg?.daily_profit_target ?? DAILY_PROFIT_TARGET;
        const _pnlSource = userCfg?.trade_source ?? 'paper';

        // Compute P&L scoped to the active broker account only.
        // Alpaca P&L must never bleed into Moomoo/Tiger sessions and vice versa.
        if (username) {
          try {
            const todayStr     = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            const accountSrc   = _tradeSourceToAccountSource(_pnlSource);
            const closedToday  = await getTrades({ username, status: 'closed', account_source: accountSrc, limit: 500 });
            const pnl = (closedToday ?? [])
              .filter(t => t.closed_at &&
                new Date(t.closed_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === todayStr)
              .reduce((sum, t) => sum + (parseFloat(t.pnl_usd) || 0), 0);
            return {
              pnl:                 +pnl.toFixed(2),
              pnl_pct:             0,
              available:           true,
              source:              accountSrc,
              daily_target:        _pnlTarget,
              daily_loss_limit:    -_pnlLimit,
              target_reached:      pnl >= _pnlTarget,
              loss_limit_reached:  pnl <= -_pnlLimit,
              remaining_to_target: +Math.max(0, _pnlTarget - pnl).toFixed(2),
            };
          } catch {
            // DB unavailable — return safe default (don't block on error)
            return { pnl: 0, available: false, source: _pnlSource,
              daily_target: _pnlTarget, daily_loss_limit: -_pnlLimit,
              target_reached: false, loss_limit_reached: false };
          }
        }

        // No username (admin/bot autonomous run) — use Alpaca portfolio history
        const _apnl = await getDailyPnL();
        return {
          ..._apnl,
          daily_loss_limit:    -_pnlLimit,
          daily_target:        _pnlTarget,
          target_reached:      _apnl.pnl >= _pnlTarget,
          loss_limit_reached:  _apnl.pnl <= -_pnlLimit,
        };
      }
      case 'get_live_quote':          return await getLiveQuote(input.symbol);
      case 'get_chart_technicals':   return await getChartTechnicals({ symbol: input.symbol });
      case 'get_price_levels':       return await getPriceLevels({ symbol: input.symbol, study_filter: input.study_filter });
      case 'get_ohlcv_summary':      return await getOHLCVSummary({ symbol: input.symbol });
      case 'get_conviction_score':   return await getConvictionScore({ symbol: input.symbol, positions: input.positions || [] });
      case 'get_earnings_surprise':  return await getEarningsSurprise({ symbol: input.symbol });
      case 'get_stock_prediction': {
        const pred = await getStockPrediction(input.symbol);
        // Enrich with calibration so Claude sees adjusted prediction + confidence
        try {
          const base   = pred.current_price;
          const day5   = pred.trend?.projected_day5;
          const rSq    = pred.trend?.r_squared ?? 0;
          if (base && day5) {
            const rawChg = (day5 - base) / base * 100;
            const cal = await applyCalibration(input.symbol, rawChg, rSq);
            if (cal && cal.confidence != null) {
              pred.calibration = {
                adjusted_change_pct: cal.adjusted_change_pct,
                confidence:          cal.confidence,
                expected_error_pct:  cal.expected_error_pct,
                notes:               cal.notes,
              };
            }
          }
        } catch { /* calibration is best-effort — never block predictions */ }
        return pred;
      }
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
          const topLevel = ['daily_profit_target','daily_loss_limit','max_open_positions','min_conviction_score','auto_execute','max_vix_for_scan','sectors_blocklist','trade_source','kb_enabled'];
          for (const k of topLevel) { if (input[k] !== undefined) updated[k] = input[k]; }
          if (input.position_sizing) updated.position_sizing = { ...updated.position_sizing, ...input.position_sizing };
          if (input.vix_thresholds)  updated.vix_thresholds  = { ...updated.vix_thresholds,  ...input.vix_thresholds };
          updated.profile = 'custom';
        }
        await setUserBotConfig(username, updated);
        return { ok: true, applied: updated, message: 'Configuration saved. Changes are live immediately.' };
      }
      // ── Moomoo tools ──────────────────────────────────────────────────────
      case 'moomoo_portfolio': {
        // Strict user scoping — never show another user's Moomoo account
        const _mmDbU = await getDbUser(username).catch(() => null);
        const _mmIsAdmin = userCfg?.role === 'admin';
        if (!_mmIsAdmin && !_mmDbU?.moomoo_acc_id)
          return { error: 'Moomoo is not configured for your account. Contact the admin to link your Moomoo account.' };
        const _mmAccId = _mmDbU?.moomoo_acc_id || undefined;
        const [fundsRes, posRes] = await Promise.allSettled([getFunds({ acc_id: _mmAccId }), getMoomooPositions({ acc_id: _mmAccId })]);
        const funds = fundsRes.status === 'fulfilled' ? fundsRes.value : null;
        const pos   = posRes.status   === 'fulfilled' ? posRes.value  : null;
        if (!funds && !pos) return { error: 'Moomoo OpenD not reachable — make sure OpenD is running.' };
        return {
          simulate:      MOOMOO_IS_SIMULATE,
          mode:          MOOMOO_IS_SIMULATE ? 'PAPER' : 'LIVE',
          cash:          funds?.cash ?? null,
          buying_power:  funds?.buying_power ?? null,
          total_assets:  funds?.total_assets ?? null,
          unrealized_pl: funds?.unrealized_pl ?? null,
          positions:     pos?.positions ?? [],
        };
      }
      case 'moomoo_place_trade': {
        const _mmDbU = await getDbUser(username).catch(() => null);
        const _mmIsAdmin = userCfg?.role === 'admin';
        if (!_mmIsAdmin && !_mmDbU?.moomoo_acc_id)
          return { error: 'Moomoo is not configured for your account.' };
        const _mmAccId = _mmDbU?.moomoo_acc_id || undefined;
        const mode = MOOMOO_IS_SIMULATE ? 'PAPER' : 'LIVE';
        const result = await placeMoomooTrade({
          symbol:            input.symbol,
          side:              input.side,
          qty:               input.qty,
          stop_price:        input.stop_price        ?? null,
          take_profit_price: input.take_profit_price ?? null,
          trailing_pct:      input.trailing_pct      ?? null,
          acc_id:            _mmAccId,
        });
        return { ...result, mode, note: MOOMOO_IS_SIMULATE ? 'Paper trade — no real money used.' : 'LIVE TRADE — real money was spent.' };
      }
      case 'moomoo_close_position': {
        const _mmDbU = await getDbUser(username).catch(() => null);
        const _mmIsAdmin = userCfg?.role === 'admin';
        if (!_mmIsAdmin && !_mmDbU?.moomoo_acc_id)
          return { error: 'Moomoo is not configured for your account.' };
        return await closeMoomooPosition({ symbol: input.symbol, acc_id: _mmDbU?.moomoo_acc_id || undefined });
      }
      case 'moomoo_cancel_all_orders': {
        const _mmDbU = await getDbUser(username).catch(() => null);
        const _mmIsAdmin = userCfg?.role === 'admin';
        if (!_mmIsAdmin && !_mmDbU?.moomoo_acc_id)
          return { error: 'Moomoo is not configured for your account.' };
        return await cancelAllMoomooOrders({ acc_id: _mmDbU?.moomoo_acc_id || undefined });
      }

      case 'get_user_info': {
        if (userCfg?.role !== 'admin') return { error: 'Admin only.' };
        const id = (input.identifier || '').trim().toLowerCase();
        const byEmail = id.includes('@') ? await getDbUserByEmail(id) : null;
        const byName  = byEmail ? null : await getDbUser(id);
        const u = byEmail || byName;
        if (!u) return { error: `No user found for "${input.identifier}"` };
        return {
          username:         u.username,
          email:            u.email || null,
          role:             u.role,
          disabled_sources: Array.isArray(u.disabled_sources) ? u.disabled_sources : [],
          has_moomoo:       !!u.moomoo_acc_id,
          has_tiger:        !!(u.tiger_id && u.tiger_account),
          has_alpaca:       !!u.alpaca_api_key,
        };
      }

      case 'set_broker_access': {
        if (userCfg?.role !== 'admin') return { error: 'Admin only.' };
        const target = (input.username || '').trim().toLowerCase();
        const u = await getDbUser(target);
        if (!u) return { error: `User "${input.username}" not found.` };
        let current = Array.isArray(u.disabled_sources) ? [...u.disabled_sources] : [];
        const toDisable = Array.isArray(input.disable) ? input.disable : [];
        const toEnable  = Array.isArray(input.enable)  ? input.enable  : [];
        current = [...new Set([...current, ...toDisable])];
        current = current.filter(s => !toEnable.includes(s));
        await setDisabledSources(target, current);
        logActivity(username, 'broker_access_changed', `AI: set disabled_sources=[${current}] for ${target}`, null);
        const enabled = ['alpaca', ...['alpaca_live','moomoo','tiger'].filter(s => !current.includes(s))];
        return { ok: true, username: target, disabled_sources: current, enabled_sources: enabled };
      }

      case 'scan_catalyst_movers':      return await runCatalystScan();

      default:                         return { error: `Unknown tool: ${name}` };
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
export async function chat({ chatId, message, onChunk, onTool, signal, userConfig = null, username = null, voiceMode = false }) {
  // Ollama / local-KB routing is disabled — all questions go to Claude Sonnet
  // which has the correct live date/time in the system prompt and access to
  // real-time tools (market status, trade history, etc.).
  // Previously routed knowledge and trade-history questions here; removed
  // because stale KB chunks were giving wrong answers (e.g. "market is closed").


  // Route fundamental screening questions to local PostgreSQL (zero Claude API cost).
  if (await isFundamentalScreeningQuestion(message)) {
    // Parse conditions from natural language
    const lower = message.toLowerCase();
    const conditions = {
      rev_qoq: /rev\w*.*qoq|quarter.*over.*quarter.*rev|revenue.*grew.*quarter/i.test(message),
      rev_yoy: /rev\w*.*yoy|year.*over.*year.*rev|revenue.*grew.*year/i.test(message),
      ni_qoq:  /net.income.*qoq|profit.*qoq|ni.*qoq|net.income.*quarter/i.test(message),
      ni_yoy:  /net.income.*yoy|profit.*yoy|ni.*yoy|net.income.*year/i.test(message),
      eps_qoq: /eps.*qoq|earnings.*qoq|eps.*quarter/i.test(message),
      eps_yoy: /eps.*yoy|earnings.*yoy|eps.*year/i.test(message),
    };
    // If no specific conditions parsed, use generic "all grew" interpretation
    const anySet = Object.values(conditions).some(Boolean);
    if (!anySet) {
      const wantsRevGrow  = /revenue.*grow|grow.*revenue/i.test(message);
      const wantsProfGrow = /profit.*grow|grow.*profit/i.test(message);
      const wantsEpsGrow  = /eps.*grow|earnings.*grow/i.test(message);
      if (wantsRevGrow || wantsProfGrow || wantsEpsGrow) {
        conditions.rev_qoq = wantsRevGrow;
        conditions.rev_yoy = wantsRevGrow;
        conditions.ni_qoq  = wantsProfGrow;
        conditions.ni_yoy  = wantsProfGrow;
        conditions.eps_qoq = wantsEpsGrow;
        conditions.eps_yoy = wantsEpsGrow;
      } else {
        // Generic screen — show all stocks with latest data, sorted by revenue
        // No filters; let results speak for themselves
      }
    }
    try {
      const { results } = await screenFundamentals(conditions);
      const formatted   = await formatScreenerAnswer(results, conditions, message);
      return {
        role:    'assistant',
        content: formatted.answer,
        source:  'local_db',
        model:   'PostgreSQL',
        screener_response: true,
        count:   formatted.count,
      };
    } catch (err) {
      // DB unavailable — fall through to Claude
    }
  }

  if (!chatHistory.has(chatId)) await loadHistoryForChat(chatId);
  pushHistory(chatId, { role: 'user', content: message });

  // Strip stale P&L blocking text on every turn — catches in-memory history too
  let messages = _stripStaleBlockingText([...chatHistory.get(chatId)]);
  let fullText = '';

  const [lessonsBlock, earningsBlock] = await Promise.all([
    buildLessonsBlock(username),
    buildPositionEarningsBlock(),
  ]);
  const voiceHint    = voiceMode ? '\n\n━━━ VOICE MODE ━━━\nUser is listening via audio — keep this reply under 3 sentences. No bullet lists, no tables, no markdown. Speak like a person, not a report.' : '';
  const fullSystem   = buildSystemPrompt(userConfig, username) + lessonsBlock + earningsBlock + voiceHint;

  while (true) {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

    const t0 = Date.now();
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: fullSystem,
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
    recordApiCall({ source: 'dashboard_chat', inputTokens: inp, outputTokens: out, toolCalls: tools, costUsd: calcCost(inp, out), durationMs: Date.now() - t0, model: finalMsg.model, username }).catch(() => {});
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
    return {
      role:    'assistant',
      content: fullText,
      source:  'claude',
      model:   'claude-sonnet-4-6',
    };
  }
}
