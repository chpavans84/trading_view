/**
 * src/core/bot-advance/executor.js — picks up would_buy decisions and places paper orders.
 *
 * Runs every minute during market hours (when BOT_CRON_OWNER=true).
 *
 * Flow per active advance bot:
 *   1. If bot is in shadow mode → skip entirely (engine.js already logged the decision)
 *   2. If bot has an open trade → manage it (check hard stop, trail, time stop)
 *   3. Otherwise → look for freshest would_buy decision in last 6 min,
 *      place the order on the bot's broker, record the trade.
 *
 * Broker-specific: each bot's `broker` column drives which credentials to load
 * and which SDK to call (alpaca | tiger_demo). The user's creds come from the
 * `users` table via bot.user_id.
 */

import cron from 'node-cron';
import { query, isDbAvailable } from '../db.js';
import { decryptCredential } from '../crypto.js';
import { placeQuickTrade, closePosition, getLatestPrice, getUserPositions } from '../trader.js';
import { placeTigerOrder, closeTigerPosition, getTigerQuote } from '../tiger.js';
import { sendTelegram } from '../telegram.js';
import { getRule } from './entry-rules.js';

const ADVANCE_PREFIX = '🧪';
const DECISION_FRESHNESS_MIN = 6;
const _runningBots = new Set();

// ─── Active bots ─────────────────────────────────────────────────────────────
async function getActiveAdvanceBots() {
  const { rows } = await query(`
    SELECT id, name, user_id, broker, status, shadow_mode,
           capital_usd, cumulative_pnl_usd, current_trade_id, rules
      FROM bots_advance
     WHERE status='active' AND deleted_at IS NULL
  `);
  return rows;
}

// ─── Broker credential loaders ───────────────────────────────────────────────
async function _loadUserCreds(userId, broker) {
  const { rows } = await query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const u = rows[0];
  if (!u) throw new Error(`user ${userId} not found`);
  if (broker === 'alpaca') {
    if (!u.alpaca_api_key) throw new Error(`user ${userId} has no alpaca credentials`);
    return {
      apiKey:    u.alpaca_api_key,
      secretKey: u.alpaca_secret_key,
      baseUrl:   u.alpaca_base_url || 'https://paper-api.alpaca.markets',
    };
  }
  if (broker === 'tiger_demo') {
    const pkey = u.tiger_demo_private_key;
    if (!u.tiger_demo_id || !u.tiger_demo_account || !pkey) {
      throw new Error(`user ${userId} has no tiger_demo credentials`);
    }
    return {
      tiger_id:    u.tiger_demo_id,
      account:     u.tiger_demo_account,
      private_key: decryptCredential(pkey),
    };
  }
  throw new Error(`broker '${broker}' not supported by bot-advance executor`);
}

// ─── Position-sizing helpers ─────────────────────────────────────────────────
function _planQty(bot, rule, price) {
  const cap          = Number(bot.capital_usd) || 0;
  const sizePctRule  = Number(bot.rules?.sizing?.position_size_pct) || 95;
  const maxPosUsd    = Number(bot.rules?.sizing?.max_position_usd) || 1000;
  const mul          = Number(rule.position_size_multiplier) || 1.0;

  const rawBudget    = Math.floor(cap * (sizePctRule / 100));
  const capped       = Math.min(rawBudget, maxPosUsd);
  const ruleBudget   = Math.floor(capped * mul);
  const qty          = Math.floor(ruleBudget / Number(price));
  return { qty, dollarsInvested: +(qty * Number(price)).toFixed(2), ruleBudget };
}

// ─── Order placement ─────────────────────────────────────────────────────────
async function _placeBuyOrder(bot, creds, symbol, qty) {
  if (bot.broker === 'alpaca') {
    return await placeQuickTrade({
      symbol, qty, side: 'buy',
      order_type: 'market',
      extended_hours: false,
    }, creds);
  }
  if (bot.broker === 'tiger_demo') {
    return await placeTigerOrder(creds, { symbol, side: 'buy', qty, outsideRth: false });
  }
  throw new Error(`unsupported broker ${bot.broker}`);
}

async function _placeSellOrder(bot, creds, symbol, qty) {
  if (bot.broker === 'alpaca') {
    return await closePosition(symbol, creds);
  }
  if (bot.broker === 'tiger_demo') {
    return await closeTigerPosition(creds, symbol);
  }
  throw new Error(`unsupported broker ${bot.broker}`);
}

async function _getLivePrice(bot, creds, symbol) {
  if (bot.broker === 'tiger_demo') {
    const q = await getTigerQuote(creds, symbol);
    return q?.latestPrice ?? q?.last ?? q?.bidPrice ?? q?.askPrice ?? null;
  }
  const q = await getLatestPrice(symbol);
  return q?.ask ?? q?.mid ?? q?.bid ?? null;
}

function _normalizeOrder(raw, fallbackPrice) {
  return {
    order_id:   String(raw?.order_id ?? raw?.id ?? raw?.client_order_id ?? `bot_adv_${Date.now()}`),
    fill_price: Number(raw?.fill_price ?? raw?.filled_avg_price ?? raw?.avg_fill_price ?? fallbackPrice),
    fill_qty:   Number(raw?.fill_qty   ?? raw?.filled_qty       ?? raw?.qty             ?? 0),
  };
}

// ─── Open new position from a would_buy decision ─────────────────────────────
async function _tryOpenPosition(bot) {
  // 1. Find freshest would_buy decision for this bot
  const cutoffMin = DECISION_FRESHNESS_MIN;
  const { rows: decisions } = await query(`
    SELECT id, symbol, entry_rule, rule_metadata, composite_score
      FROM bot_advance_decisions
     WHERE bot_id=$1 AND action='would_buy'
       AND scanned_at > NOW() - ($2 * INTERVAL '1 minute')
     ORDER BY scanned_at DESC LIMIT 1
  `, [bot.id, cutoffMin]);
  if (!decisions.length) return { action: 'no_fresh_decision' };
  const d = decisions[0];

  // 2. Guard against re-entering same symbol if bot somehow holds it already
  const { rows: alreadyOpen } = await query(
    `SELECT id FROM bot_advance_trades WHERE bot_id=$1 AND symbol=$2 AND status='open' LIMIT 1`,
    [bot.id, d.symbol.toUpperCase()]
  );
  if (alreadyOpen.length) return { action: 'skip_already_open', symbol: d.symbol };

  // 3. Load broker creds (will throw clearly if user has wrong broker assigned)
  let creds;
  try { creds = await _loadUserCreds(bot.user_id, bot.broker); }
  catch (e) {
    console.error(`[bot-advance/exec] bot ${bot.id}: ${e.message}`);
    return { action: 'error', error: e.message };
  }

  // 4. Get live price for sizing
  const price = await _getLivePrice(bot, creds, d.symbol).catch(() => null);
  if (!price || price <= 0) return { action: 'skip_no_price', symbol: d.symbol };

  // 5. Look up the rule for its size multiplier + exit config
  const rule = getRule(d.entry_rule);
  if (!rule) return { action: 'error', error: `unknown rule ${d.entry_rule}` };

  // 6. Size the position
  const { qty, dollarsInvested } = _planQty(bot, rule, price);
  if (qty < 1) return { action: 'skip_insufficient_capital', symbol: d.symbol, price };

  // 7. Place the order
  let rawOrder;
  try { rawOrder = await _placeBuyOrder(bot, creds, d.symbol, qty); }
  catch (e) {
    console.error(`[bot-advance/exec] bot ${bot.id} ${d.symbol}: order placement failed:`, e.message);
    return { action: 'error', error: e.message };
  }
  if (rawOrder?.action?.startsWith?.('skip_')) return rawOrder;
  const order = _normalizeOrder(rawOrder, price);
  if (!(order.fill_price > 0)) {
    return { action: 'error', error: 'order returned no fill price' };
  }

  // 8. Compute stop price from rule exits
  const stopLossPrice = +(order.fill_price * (1 - rule.exits.hard_sl_pct)).toFixed(2);

  // 9. Insert into bot_advance_trades + set bot.current_trade_id
  const { rows: tRows } = await query(`
    INSERT INTO bot_advance_trades
      (bot_id, decision_id, order_id, symbol, side, qty, entry_price, dollars_invested,
       entry_rule, hard_sl_pct, trail_pct, time_stop_days, stop_loss_price,
       status, shadow_mode, account_source)
    VALUES ($1, $2, $3, $4, 'buy', $5, $6, $7, $8, $9, $10, $11, $12, 'open', $13, $14)
    RETURNING id
  `, [
    bot.id, d.id, order.order_id, d.symbol.toUpperCase(),
    qty, order.fill_price, dollarsInvested,
    d.entry_rule, rule.exits.hard_sl_pct, rule.exits.trail_pct, rule.exits.time_stop_days, stopLossPrice,
    false,  // shadow_mode=false because this is a real-paper trade
    bot.broker === 'alpaca' ? 'alpaca_paper' : bot.broker,
  ]);
  const tradeId = tRows[0]?.id ?? null;

  await query(`UPDATE bots_advance SET current_trade_id=$1, updated_at=NOW() WHERE id=$2`, [tradeId, bot.id]);

  console.log(`[bot-advance/exec] bot ${bot.id} OPENED ${d.symbol} x${qty} @ $${order.fill_price} rule=${d.entry_rule} trade=${tradeId}`);
  sendTelegram(
    `${ADVANCE_PREFIX} 🟢 <b>OPENED</b> ${d.symbol} x${qty} @ $${Number(order.fill_price).toFixed(2)}\n` +
    `Bot ${bot.id} ${bot.name} • rule=<code>${d.entry_rule}</code>\n` +
    `Stop: $${stopLossPrice} • $${dollarsInvested} deployed • broker=${bot.broker}`
  ).catch(() => {});

  return { action: 'opened', symbol: d.symbol, trade_id: tradeId, qty, fill_price: order.fill_price };
}

// ─── Manage open position ────────────────────────────────────────────────────
async function _manageOpenPosition(bot) {
  const { rows } = await query(`SELECT * FROM bot_advance_trades WHERE id=$1`, [bot.current_trade_id]);
  const trade = rows[0];
  if (!trade) {
    // Stale pointer — self-heal
    console.warn(`[bot-advance/exec] bot ${bot.id}: current_trade_id=${bot.current_trade_id} not found, clearing`);
    await query(`UPDATE bots_advance SET current_trade_id=NULL WHERE id=$1`, [bot.id]);
    return { action: 'cleared_stale_pointer' };
  }
  if (trade.status !== 'open') {
    // Trade already closed — clear pointer
    await query(`UPDATE bots_advance SET current_trade_id=NULL WHERE id=$1`, [bot.id]);
    return { action: 'cleared_closed_pointer' };
  }

  // Load creds for price + sell
  let creds;
  try { creds = await _loadUserCreds(bot.user_id, bot.broker); }
  catch (e) { return { action: 'error', error: e.message }; }

  // Get current price
  const px = await _getLivePrice(bot, creds, trade.symbol).catch(() => null);
  if (!px || px <= 0) return { action: 'skip_no_price', symbol: trade.symbol };

  const entry        = Number(trade.entry_price);
  const qty          = Number(trade.qty);
  const dollarsInv   = Number(trade.dollars_invested);
  const currentPnl   = (px - entry) * qty;
  const peakPnl      = Math.max(Number(trade.peak_pnl_usd) || 0, currentPnl);

  // Update peak
  if (peakPnl > (Number(trade.peak_pnl_usd) || 0)) {
    await query(`UPDATE bot_advance_trades SET peak_pnl_usd=$1 WHERE id=$2`, [peakPnl, trade.id]);
  }

  // Exit checks
  const hardSlUsd = dollarsInv * Number(trade.hard_sl_pct);
  const trailFraction = Number(trade.trail_pct) / 100;
  const trailMinPeak = dollarsInv * 0.01;  // 1% peak gate before trail engages

  let exitReason = null;
  if (currentPnl <= -hardSlUsd) {
    exitReason = 'hard_stop';
  } else if (peakPnl > trailMinPeak && currentPnl < peakPnl * (1 - trailFraction)) {
    exitReason = 'trail_stop';
  } else {
    const heldDays = (Date.now() - new Date(trade.opened_at).getTime()) / 86_400_000;
    if (heldDays >= Number(trade.time_stop_days)) exitReason = 'time_stop';
  }

  if (!exitReason) return { action: 'hold', symbol: trade.symbol, pnl: currentPnl };

  // Place sell
  let rawOrder;
  try { rawOrder = await _placeSellOrder(bot, creds, trade.symbol, qty); }
  catch (e) {
    console.error(`[bot-advance/exec] bot ${bot.id} ${trade.symbol}: sell failed:`, e.message);
    return { action: 'error', error: e.message };
  }
  const order = _normalizeOrder(rawOrder, px);
  const exitPrice = order.fill_price > 0 ? order.fill_price : px;
  const pnlUsd = +((exitPrice - entry) * qty).toFixed(2);
  const pnlPct = +(((exitPrice - entry) / entry) * 100).toFixed(3);

  await query(`
    UPDATE bot_advance_trades
       SET status='closed', exit_price=$1, exit_reason=$2,
           pnl_usd=$3, pnl_pct=$4, peak_pnl_usd=$5, closed_at=NOW()
     WHERE id=$6
  `, [exitPrice, exitReason, pnlUsd, pnlPct, peakPnl, trade.id]);

  await query(`
    UPDATE bots_advance
       SET current_trade_id=NULL, cumulative_pnl_usd=cumulative_pnl_usd + $1, updated_at=NOW()
     WHERE id=$2
  `, [pnlUsd, bot.id]);

  console.log(`[bot-advance/exec] bot ${bot.id} CLOSED ${trade.symbol} @ $${exitPrice} reason=${exitReason} pnl=$${pnlUsd}`);
  const icon = pnlUsd > 0 ? '🟢' : pnlUsd < 0 ? '🔴' : '⚪';
  const reasonIcon = exitReason === 'hard_stop' ? '🛑' : exitReason === 'trail_stop' ? '📉' : '⏰';
  sendTelegram(
    `${ADVANCE_PREFIX} ${icon} <b>CLOSED</b> ${trade.symbol} @ $${Number(exitPrice).toFixed(2)} ${reasonIcon} ${exitReason}\n` +
    `PnL: <b>${pnlUsd >= 0 ? '+' : ''}$${pnlUsd} (${pnlPct >= 0 ? '+' : ''}${pnlPct}%)</b>\n` +
    `Bot ${bot.id} ${bot.name} • rule=<code>${trade.entry_rule}</code>`
  ).catch(() => {});

  return { action: 'closed', symbol: trade.symbol, reason: exitReason, pnl: pnlUsd, pct: pnlPct };
}

// ─── Per-bot dispatcher ──────────────────────────────────────────────────────
export async function processBotAdvance(bot) {
  if (_runningBots.has(bot.id)) return { skipped: true, reason: 'inflight' };
  _runningBots.add(bot.id);
  try {
    if (bot.shadow_mode) return { skipped: true, reason: 'shadow_mode' };
    if (bot.current_trade_id) return await _manageOpenPosition(bot);
    return await _tryOpenPosition(bot);
  } finally {
    _runningBots.delete(bot.id);
  }
}

// ─── Run for all active ──────────────────────────────────────────────────────
export async function runAdvanceExecutorForAllActive() {
  if (!isDbAvailable()) return { skipped: true, reason: 'no_db' };
  try {
    const bots = await getActiveAdvanceBots();
    const out = [];
    for (const bot of bots) {
      try {
        const r = await processBotAdvance(bot);
        out.push({ bot_id: bot.id, ...r });
      } catch (e) {
        console.error(`[bot-advance/exec] bot ${bot.id} error:`, e.message);
        out.push({ bot_id: bot.id, action: 'error', error: e.message });
      }
    }
    return { processed: out.length, out };
  } catch (e) {
    console.error('[bot-advance/exec] fatal:', e.message);
    return { error: e.message };
  }
}

// ─── Cron ────────────────────────────────────────────────────────────────────
export function startBotAdvanceExecutorCron() {
  if (process.env.BOT_CRON_OWNER !== 'true') {
    console.log('[bot-advance/exec] cron NOT scheduled (BOT_CRON_OWNER != true)');
    return;
  }
  const TZ = { timezone: 'America/New_York' };
  // Every minute during regular hours, just like the main executor
  cron.schedule('30-59 9 * * 1-5', () => runAdvanceExecutorForAllActive(), TZ);
  cron.schedule('* 10-15 * * 1-5',  () => runAdvanceExecutorForAllActive(), TZ);
  console.log('[bot-advance/exec] cron scheduled — every minute during market hours');
}
