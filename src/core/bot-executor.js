/**
 * Bot Executor — Phase B-3
 *
 * Broker-aware execution engine. Reads fresh "buy" decisions from
 * bot_decisions, places market orders, manages open positions (stop-loss +
 * trailing-stop), and updates the trades + bots tables.
 *
 * Allowed brokers in B-3 (paper tier only):
 *   'alpaca'     — Alpaca paper account (env-level credentials)
 *   'tiger_demo' — Tiger Demo account   (per-user tiger_demo_* credentials)
 *
 * All live brokers (alpaca_live, tiger, moomoo) are gated until B-6.
 */

import cron from 'node-cron';
import { query, isDbAvailable, recordTrade, closeTrade } from './db.js';
import { decryptCredential } from './crypto.js';
import { placeTigerOrder, closeTigerPosition, getTigerQuote } from './tiger.js';
import { placeQuickTrade, closePosition, getLatestPrice } from './trader.js';

// ─── Quote helpers ────────────────────────────────────────────────────────────

async function _bestAskFor(broker, creds, symbol) {
  try {
    if (broker === 'tiger_demo') {
      const q = await getTigerQuote(creds, symbol);
      return q?.ask ?? q?.last ?? null;
    }
    if (broker === 'alpaca') {
      const q = await getLatestPrice(symbol);
      return q?.ask ?? q?.last ?? null;
    }
  } catch (e) {
    console.warn(`[bot-exec] broker quote failed for ${symbol}: ${e.message}`);
  }
  return null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PAPER_BROKERS          = new Set(['alpaca', 'tiger_demo']);
const DECISION_FRESHNESS_MIN = 6;
const _runningBots           = new Set();

// ─── RTH / order-type helpers ─────────────────────────────────────────────────

function _isRth(now = new Date()) {
  const et   = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day  = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960;  // 9:30–16:00 ET
}

// Returns { effectiveType, limitPrice } for a buy order given bot execution rules.
// limitPrice is null for MKT orders; set to ask*(1+bps/10000) for LMT buys.
async function _buyOrderParams(bot, creds, symbol) {
  const exec        = bot.rules?.execution ?? {};
  const orderType   = exec.order_type        ?? 'auto';
  const allowOutRth = exec.allow_outside_rth ?? true;
  const limitBps    = exec.limit_offset_bps  ?? 30;

  const inRth = _isRth();
  if (!inRth && !allowOutRth) return { skip: 'skip_outside_rth' };

  let effectiveType = orderType;
  if (orderType === 'auto') effectiveType = inRth ? 'mkt' : 'lmt';
  if (orderType === 'mkt' && !inRth) effectiveType = 'lmt';

  let limitPrice = null;
  if (effectiveType === 'lmt') {
    const ask = await _bestAskFor(bot.broker, creds, symbol);
    if (!ask) return { skip: 'skip_no_quote' };
    limitPrice = +(ask * (1 + limitBps / 10000)).toFixed(2);
  }

  return { effectiveType, limitPrice, inRth };
}

// Returns { effectiveType, limitPrice } for a sell/close order.
// limitPrice is bid*(1-bps/10000) for LMT sells to ensure fill.
function _sellOrderParams(bot, exitPrice) {
  const exec      = bot.rules?.execution ?? {};
  const orderType = exec.order_type       ?? 'auto';
  const limitBps  = exec.limit_offset_bps ?? 30;

  const inRth = _isRth();
  let effectiveType = orderType;
  if (orderType === 'auto') effectiveType = inRth ? 'mkt' : 'lmt';
  if (orderType === 'mkt' && !inRth) effectiveType = 'lmt';

  const limitPrice = effectiveType === 'lmt'
    ? +(exitPrice * (1 - limitBps / 10000)).toFixed(2)
    : null;

  return { effectiveType, limitPrice, inRth };
}

// ─── Public entry points ──────────────────────────────────────────────────────

export async function runExecutorForAllActive() {
  if (!isDbAvailable()) return { skipped: true, reason: 'no_db' };
  try {
    const { rows: bots } = await query(`SELECT * FROM bots WHERE status = 'active' AND deleted_at IS NULL`);
    const out = [];
    for (const bot of bots) {
      if (!PAPER_BROKERS.has(bot.broker)) {
        out.push({ bot_id: bot.id, action: 'skip_non_paper_broker' });
        continue;
      }
      try {
        const r = await processBot(bot);
        out.push({ bot_id: bot.id, ...r });
      } catch (e) {
        console.error(`[bot-executor] bot ${bot.id} error:`, e.message);
        out.push({ bot_id: bot.id, action: 'error', error: e.message });
      }
    }
    return { processed: out.length, out };
  } catch (e) {
    console.error('[bot-executor] fatal:', e.message);
    return { error: e.message };
  }
}

export async function processBot(bot) {
  if (_runningBots.has(bot.id)) return { skipped: true, reason: 'inflight' };
  _runningBots.add(bot.id);
  try {
    if (!PAPER_BROKERS.has(bot.broker)) {
      return { skipped: true, reason: `broker '${bot.broker}' not allowed in B-3` };
    }

    // Circuit breaker — stop bot if cumulative loss exceeds max
    const maxLoss = bot.rules?.risk?.max_loss_usd ?? 100;
    const cumPnl  = Number(bot.cumulative_pnl_usd) || 0;
    if (cumPnl <= -maxLoss && bot.status !== 'stopped') {
      await query(
        `UPDATE bots SET status='stopped', status_message=$1, status_changed_at=NOW(), updated_at=NOW() WHERE id=$2`,
        [`Cumulative loss reached max ($${maxLoss})`, bot.id]
      );
      return { skipped: true, reason: 'circuit_breaker_tripped' };
    }

    if (bot.current_trade_id) return await _manageOpenPosition(bot);
    return await _tryOpenPosition(bot);
  } finally {
    _runningBots.delete(bot.id);
  }
}

// ─── Broker dispatch ──────────────────────────────────────────────────────────

async function _tigerDemoCreds(userId) {
  const { rows } = await query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const u = rows[0];
  if (!u) throw new Error('user not found');
  const creds = {
    tiger_id:    u.tiger_demo_id,
    account:     u.tiger_demo_account,
    private_key: decryptCredential(u.tiger_demo_private_key),
  };
  if (!creds.tiger_id || !creds.account || !creds.private_key)
    throw new Error('Tiger Demo credentials not configured for this user');
  return creds;
}

async function _placeBuyForBot(bot, symbol, qty, creds = null) {
  if (bot.broker === 'tiger_demo' && !creds) creds = await _tigerDemoCreds(bot.user_id);

  const params = await _buyOrderParams(bot, creds, symbol);
  if (params.skip) return { action: params.skip, symbol };

  const { effectiveType, limitPrice, inRth } = params;
  const isLmt = effectiveType === 'lmt';

  if (bot.broker === 'alpaca') {
    return await placeQuickTrade({
      symbol, qty, side: 'buy',
      order_type:     isLmt ? 'limit' : 'market',
      limit_price:    limitPrice,
      extended_hours: !inRth,
    });
  }
  if (bot.broker === 'tiger_demo') {
    return await placeTigerOrder(creds, { symbol, side: 'buy', qty, limitPrice, outsideRth: !inRth });
  }
  throw new Error(`unsupported broker: ${bot.broker}`);
}

async function _closeForBot(bot, trade, effectiveType, limitPrice) {
  const symbol = trade.symbol;
  const qty    = parseFloat(trade.qty);
  const isLmt  = effectiveType === 'lmt';

  if (bot.broker === 'alpaca') {
    if (isLmt) {
      return await placeQuickTrade({
        symbol, qty, side: 'sell',
        order_type:     'limit',
        limit_price:    limitPrice,
        extended_hours: true,
      });
    }
    return await closePosition(symbol);
  }
  if (bot.broker === 'tiger_demo') {
    const creds = await _tigerDemoCreds(bot.user_id);
    if (isLmt) {
      return await placeTigerOrder(creds, { symbol, side: 'sell', qty, limitPrice, outsideRth: true });
    }
    return await closeTigerPosition(creds, symbol);
  }
  throw new Error(`unsupported broker: ${bot.broker}`);
}

// Normalize different broker order shapes to a common { order_id, fill_price, fill_qty }
function _normalizeOrder(raw, fallbackPrice) {
  return {
    order_id:   String(raw?.order_id ?? raw?.id ?? raw?.client_order_id ?? `bot_${Date.now()}`),
    fill_price: Number(raw?.fill_price ?? raw?.filled_avg_price ?? raw?.avg_fill_price ?? fallbackPrice),
    fill_qty:   Number(raw?.fill_qty   ?? raw?.filled_qty ?? raw?.qty ?? 0),
  };
}

// ─── Open / close logic ───────────────────────────────────────────────────────

async function _tryOpenPosition(bot) {
  // 1. Find freshest qualifying buy decision
  const { rows: decisions } = await query(
    `SELECT * FROM bot_decisions
     WHERE bot_id=$1
       AND action='buy'
       AND symbol IS NOT NULL
       AND scanned_at > NOW() - INTERVAL '${DECISION_FRESHNESS_MIN} minutes'
     ORDER BY composite_score DESC
     LIMIT 1`,
    [bot.id]
  );
  if (!decisions.length) return { action: 'no_fresh_decision' };
  const decision = decisions[0];
  const symbol   = decision.symbol;

  // 2. Guard: don't re-enter a symbol already open for this bot
  const { rows: openCheck } = await query(
    `SELECT id FROM trades WHERE symbol=$1 AND status='open' AND bot_id=$2 LIMIT 1`,
    [symbol.toUpperCase(), bot.id]
  );
  if (openCheck.length) return { action: 'skip_already_open', symbol };

  // Load broker creds early to reuse in _placeBuyForBot (avoids double fetch)
  let sizingCreds = null;
  if (bot.broker === 'tiger_demo') sizingCreds = await _tigerDemoCreds(bot.user_id);

  // 3. Get live price for sizing via Alpaca market data (best-effort, not broker-authoritative)
  const quote = await getLatestPrice(symbol).catch(() => null);
  if (!quote) return { action: 'skip_no_price', symbol };
  const price = quote.ask ?? quote.mid ?? quote.bid;
  if (!price || price <= 0) return { action: 'skip_bad_price', symbol };

  // 4. Size position
  const sizePct       = bot.rules?.sizing?.position_size_pct ?? 95;
  const dollarBudget  = Math.floor(Number(bot.capital_usd) * sizePct / 100);
  const qty           = Math.floor(dollarBudget / price);
  if (qty < 1) return { action: 'skip_insufficient_capital', symbol, price, budget: dollarBudget };

  // 5. Place buy
  const rawOrder = await _placeBuyForBot(bot, symbol, qty, sizingCreds);
  if (typeof rawOrder?.action === 'string' && rawOrder.action.startsWith('skip_')) return rawOrder;
  const order    = _normalizeOrder(rawOrder, price);
  if (!order.order_id || !(order.fill_price > 0)) {
    console.error(`[bot-executor] bot ${bot.id} order normalization failed for ${symbol}:`,
      JSON.stringify({ raw: rawOrder, normalized: order }).slice(0, 500));
    return { action: 'error', reason: 'order_normalization_failed', symbol, raw: rawOrder };
  }
  const fillPrice      = order.fill_price || price;
  const dollarsInvested = +(fillPrice * qty).toFixed(2);

  // 6. Derive stop-loss price from dollar risk rule
  const stopLossUsd = bot.rules?.exit_rules?.stop_loss_usd ?? 50;
  const stopPct     = qty > 0 ? +((stopLossUsd / dollarsInvested) * 100).toFixed(2) : 3;
  const stopPrice   = +(fillPrice * (1 - stopPct / 100)).toFixed(2);

  // 7. Record trade and tag with bot_id
  const tradeId = await recordTrade({
    order_id:    order.order_id,
    symbol,
    side:        'buy',
    qty,
    entry_price: fillPrice,
    stop_loss:   stopPrice,
    take_profit: null,
    dollars_invested:  dollarsInvested,
    stop_loss_pct:     stopPct,
    take_profit_pct:   null,
    atr_pct:           null,
    conviction_score:  decision.composite_score ? Number(decision.composite_score) : null,
    conviction_grade:  null,
    conviction_breakdown: decision.factor_breakdown ?? null,
    username:          null,
    account_source:    bot.broker,
  });
  if (!tradeId) {
    console.error(`[bot-executor] bot ${bot.id} recordTrade FAILED — order ${order.order_id} placed on broker but no DB row created!`,
      JSON.stringify({ symbol, order_id: order.order_id, fill_price: fillPrice, qty }).slice(0, 500));
    return { action: 'error', reason: 'db_write_failed', symbol, broker_order_id: order.order_id };
  }
  await query('UPDATE trades SET bot_id=$1 WHERE id=$2', [bot.id, tradeId]);

  // 8. Link trade to bot
  await query(
    'UPDATE bots SET current_trade_id=$1, updated_at=NOW() WHERE id=$2',
    [tradeId, bot.id]
  );

  console.log(`[bot-executor] bot ${bot.id} opened ${symbol} x${qty} @ $${fillPrice} via ${bot.broker} (trade ${tradeId})`);
  return { action: 'opened', symbol, trade_id: tradeId, fill_price: fillPrice, qty, broker: bot.broker };
}

async function _manageOpenPosition(bot) {
  // Load the tracked trade
  const { rows } = await query('SELECT * FROM trades WHERE id=$1', [bot.current_trade_id]);
  if (!rows.length) {
    // Trade record missing — clear the stale pointer
    await query('UPDATE bots SET current_trade_id=NULL, updated_at=NOW() WHERE id=$1', [bot.id]);
    return { action: 'cleared_stale_trade' };
  }
  const trade  = rows[0];
  const symbol = trade.symbol;

  // Get current price
  const quote = await getLatestPrice(symbol).catch(() => null);
  if (!quote) return { action: 'skip_no_price', symbol };
  const currentPrice = quote.bid ?? quote.mid ?? quote.ask;
  if (!currentPrice || currentPrice <= 0) return { action: 'skip_bad_price', symbol };

  // P&L calculation
  const entryPrice = parseFloat(trade.entry_price);
  const qty        = parseFloat(trade.qty);
  const currentPnl = +((currentPrice - entryPrice) * qty).toFixed(2);

  // Track peak P&L for trailing-stop
  const prevPeak = parseFloat(trade.peak_pnl_usd || 0);
  const peakPnl  = Math.max(prevPeak, currentPnl);
  if (peakPnl > prevPeak) {
    await query('UPDATE trades SET peak_pnl_usd=$1 WHERE id=$2', [peakPnl, trade.id]);
    trade.peak_pnl_usd = peakPnl;
  }

  // Check hard stop-loss (dollar threshold)
  const stopLossUsd = bot.rules?.exit_rules?.stop_loss_usd ?? 50;
  if (currentPnl <= -stopLossUsd) {
    return await _closeTrade(bot, trade, currentPrice, 'stop_loss');
  }

  // Check trailing stop: once in profit, close if we give back trail_pct% of peak gain
  const trailPct = bot.rules?.exit_rules?.trail_pct ?? 30;
  if (peakPnl > 0 && currentPnl < peakPnl * (1 - trailPct / 100)) {
    return await _closeTrade(bot, trade, currentPrice, 'trailing_stop');
  }

  return { action: 'hold', symbol, current_pnl: currentPnl, peak_pnl: peakPnl };
}

async function _closeTrade(bot, trade, exitPrice, reason) {
  const symbol     = trade.symbol;
  const entryPrice = parseFloat(trade.entry_price);
  const qty        = parseFloat(trade.qty);
  const pnlUsd     = +((exitPrice - entryPrice) * qty).toFixed(2);
  const pnlPct     = +((exitPrice - entryPrice) / entryPrice * 100).toFixed(2);

  // Close position via broker — apply order-type logic for extended hours
  const { effectiveType: sellType, limitPrice: sellLimit } = _sellOrderParams(bot, exitPrice);
  try {
    await _closeForBot(bot, trade, sellType, sellLimit);
  } catch (e) {
    console.warn(`[bot-executor] close order failed for ${symbol}:`, e.message);
    throw e;
  }

  // Mark trade closed in DB
  await closeTrade({
    order_id:   trade.order_id,
    symbol,
    exit_price: exitPrice,
    pnl_usd:    pnlUsd,
    pnl_pct:    pnlPct,
  });

  // Update bot stats
  const won = pnlUsd > 0 ? 1 : 0;
  await query(
    `UPDATE bots SET
       current_trade_id    = NULL,
       total_trades        = COALESCE(total_trades, 0) + 1,
       winning_trades      = COALESCE(winning_trades, 0) + $1,
       cumulative_pnl_usd  = COALESCE(cumulative_pnl_usd, 0) + $2,
       updated_at          = NOW()
     WHERE id=$3`,
    [won, pnlUsd, bot.id]
  );

  console.log(`[bot-executor] bot ${bot.id} CLOSED ${symbol} @ $${exitPrice} reason=${reason} pnl=$${pnlUsd}`);
  return { action: 'closed', symbol, reason, exit_price: exitPrice, pnl_usd: pnlUsd, pnl_pct: pnlPct };
}

// ─── Cron registration ────────────────────────────────────────────────────────

export function startBotExecutorCrons() {
  const TZ = { timezone: 'America/New_York' };
  // Last 30 min of 9 AM (9:30–9:59) and every minute of 10 AM–3 PM
  cron.schedule('30-59 9 * * 1-5', () => runExecutorForAllActive(), TZ);
  cron.schedule('* 10-15 * * 1-5', () => runExecutorForAllActive(), TZ);
  console.log('[bot-executor] cron scheduled — every minute during market hours');
}
