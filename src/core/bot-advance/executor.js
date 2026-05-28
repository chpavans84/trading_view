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
// Admin users (role='admin') fall back to process.env creds — matches the existing
// dashboard's isAdmin pattern in src/web/server.js (line ~688).
async function _loadUserCreds(userId, broker) {
  const { rows } = await query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const u = rows[0];
  if (!u) throw new Error(`user ${userId} not found`);
  const isAdmin = u.role === 'admin';

  if (broker === 'alpaca') {
    if (u.alpaca_api_key && u.alpaca_secret_key) {
      return {
        apiKey:    u.alpaca_api_key,
        secretKey: u.alpaca_secret_key,
        baseUrl:   u.alpaca_base_url || 'https://paper-api.alpaca.markets',
      };
    }
    if (isAdmin && process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY) {
      return {
        apiKey:    process.env.ALPACA_API_KEY,
        secretKey: process.env.ALPACA_SECRET_KEY,
        baseUrl:   process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
      };
    }
    throw new Error(`user ${userId} (${u.username}) has no alpaca credentials (no user row, no admin env)`);
  }

  if (broker === 'tiger_demo') {
    const pkey = u.tiger_demo_private_key;
    if (!u.tiger_demo_id || !u.tiger_demo_account || !pkey) {
      throw new Error(`user ${userId} (${u.username}) has no tiger_demo credentials`);
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

// Try live quote first; fall back to last close from backtest_prices.
// The fallback is only for SIZING — the actual stop_loss is computed from the
// broker's real fill price, not from this estimate. Off-by-a-few-percent on
// sizing is bounded by max_position_usd=$1K anyway.
async function _getLivePrice(bot, creds, symbol) {
  let live = null;
  try {
    if (bot.broker === 'tiger_demo') {
      const q = await getTigerQuote(creds, symbol);
      live = q?.latestPrice ?? q?.last ?? q?.bidPrice ?? q?.askPrice ?? null;
    } else {
      const q = await getLatestPrice(symbol);
      live = q?.ask ?? q?.mid ?? q?.bid ?? null;
    }
  } catch (_) {
    live = null;
  }
  if (live && live > 0) return live;

  // Fallback — last close (Alpaca refresh-prices cron keeps this fresh daily)
  try {
    const { rows } = await query(
      `SELECT close FROM backtest_prices WHERE symbol=$1 ORDER BY price_date DESC LIMIT 1`,
      [symbol.toUpperCase()]
    );
    const fallback = Number(rows[0]?.close);
    if (Number.isFinite(fallback) && fallback > 0) {
      console.log(`[bot-advance/exec] ${symbol}: live quote unavailable, using last close $${fallback.toFixed(2)} for sizing`);
      return fallback;
    }
  } catch (_) {}
  return null;
}

function _normalizeOrder(raw, fallbackPrice) {
  return {
    order_id:   String(raw?.order_id ?? raw?.id ?? raw?.client_order_id ?? `bot_adv_${Date.now()}`),
    fill_price: Number(raw?.fill_price ?? raw?.filled_avg_price ?? raw?.avg_fill_price ?? fallbackPrice),
    fill_qty:   Number(raw?.fill_qty   ?? raw?.filled_qty       ?? raw?.qty             ?? 0),
  };
}

// ─── Multi-position open logic ───────────────────────────────────────────────
// User config: bot.rules.sizing.max_concurrent_positions (default 5).
// Per-symbol dedup uses status IN ('open', 'pending') so an in-flight order
// blocks a duplicate buy from a parallel tick. The 'pending' row is inserted
// BEFORE calling the broker and updated to 'open' on success / 'failed' on err.
const DEFAULT_MAX_POSITIONS = 5;

async function _tryOpenPosition(bot) {
  const maxPositions = Number(bot.rules?.sizing?.max_concurrent_positions) || DEFAULT_MAX_POSITIONS;

  // 1. How many positions does this bot currently hold (open OR pending)?
  const { rows: openCountRows } = await query(`
    SELECT COUNT(*)::int AS n
      FROM bot_advance_trades
     WHERE bot_id=$1 AND status IN ('open', 'pending')
  `, [bot.id]);
  const openCount = openCountRows[0]?.n ?? 0;
  if (openCount >= maxPositions) {
    return { action: 'skip_max_positions', open: openCount, cap: maxPositions };
  }

  // 2. Pull the freshest would_buy decisions for this bot that aren't already
  //    held / pending. We grab up to (max - open) so we can fill multiple slots
  //    on one executor tick if multiple rules fired.
  const slotsAvailable = maxPositions - openCount;
  const { rows: decisions } = await query(`
    SELECT d.id, d.symbol, d.entry_rule, d.rule_metadata, d.composite_score
      FROM bot_advance_decisions d
     WHERE d.bot_id=$1 AND d.action='would_buy'
       AND d.scanned_at > NOW() - ($2 * INTERVAL '1 minute')
       AND NOT EXISTS (
         SELECT 1 FROM bot_advance_trades t
          WHERE t.bot_id = d.bot_id
            AND t.symbol = UPPER(d.symbol)
            AND t.status IN ('open', 'pending')
       )
     ORDER BY d.scanned_at DESC
     LIMIT $3
  `, [bot.id, DECISION_FRESHNESS_MIN, slotsAvailable]);

  if (!decisions.length) return { action: 'no_fresh_decision', open: openCount, cap: maxPositions };

  // 3. Load broker creds once for the bot
  let creds;
  try { creds = await _loadUserCreds(bot.user_id, bot.broker); }
  catch (e) {
    console.error(`[bot-advance/exec] bot ${bot.id}: ${e.message}`);
    return { action: 'error', error: e.message };
  }

  const results = [];
  for (const d of decisions) {
    const r = await _openOneSymbol(bot, creds, d);
    results.push(r);
    if (r?.action === 'opened') {
      // Refresh count — protect against accidentally over-opening if loop races
      const { rows: countNow } = await query(`
        SELECT COUNT(*)::int AS n FROM bot_advance_trades
         WHERE bot_id=$1 AND status IN ('open', 'pending')
      `, [bot.id]);
      if ((countNow[0]?.n ?? 0) >= maxPositions) break;
    }
  }

  return { action: 'multi_open', count: results.filter(r => r.action === 'opened').length, results };
}

// Open a single symbol — pre-inserts 'pending' row for dedup safety,
// then upgrades to 'open' after the broker confirms, or marks 'failed' on error.
async function _openOneSymbol(bot, creds, d) {
  const symbol = d.symbol.toUpperCase();
  const rule = getRule(d.entry_rule);
  if (!rule) return { action: 'error', error: `unknown rule ${d.entry_rule}` };

  // PRE-INSERT pending row to claim the symbol slot. If this conflicts (because
  // another tick beat us to it), we silently skip — the OTHER tick owns the trade.
  let pendingId;
  try {
    const { rows } = await query(`
      INSERT INTO bot_advance_trades
        (bot_id, decision_id, symbol, side, qty, entry_price, dollars_invested,
         entry_rule, hard_sl_pct, trail_pct, time_stop_days,
         status, shadow_mode, account_source)
      SELECT $1::int, $2::bigint, $3::varchar, 'buy', 0, 0, 0,
             $4::varchar, $5::numeric, $6::numeric, $7::int,
             'pending', FALSE, $8::varchar
       WHERE NOT EXISTS (
         SELECT 1 FROM bot_advance_trades
          WHERE bot_id=$1::int AND symbol=$3::varchar AND status IN ('open','pending')
       )
      RETURNING id
    `, [
      bot.id, d.id, symbol, d.entry_rule,
      rule.exits.hard_sl_pct, rule.exits.trail_pct, rule.exits.time_stop_days,
      bot.broker === 'alpaca' ? 'alpaca_paper' : bot.broker,
    ]);
    if (!rows.length) {
      // Lost the race — another tick claimed this symbol first. Bail silently.
      return { action: 'skip_already_pending', symbol };
    }
    pendingId = rows[0].id;
  } catch (e) {
    console.error(`[bot-advance/exec] bot ${bot.id} ${symbol}: pending insert failed:`, e.message);
    return { action: 'error', error: e.message };
  }

  // From here on, ALWAYS clean up the pending row on failure (mark 'failed').
  try {
    const price = await _getLivePrice(bot, creds, symbol).catch(() => null);
    if (!price || price <= 0) {
      await query(`UPDATE bot_advance_trades SET status='failed', exit_reason='no_price' WHERE id=$1`, [pendingId]);
      return { action: 'skip_no_price', symbol };
    }

    const { qty, dollarsInvested } = _planQty(bot, rule, price);
    if (qty < 1) {
      await query(`UPDATE bot_advance_trades SET status='failed', exit_reason='insufficient_capital' WHERE id=$1`, [pendingId]);
      return { action: 'skip_insufficient_capital', symbol, price };
    }

    let rawOrder;
    try { rawOrder = await _placeBuyOrder(bot, creds, symbol, qty); }
    catch (e) {
      console.error(`[bot-advance/exec] bot ${bot.id} ${symbol}: order placement failed:`, e.message);
      await query(`UPDATE bot_advance_trades SET status='failed', exit_reason=$1 WHERE id=$2`, [String(e.message).slice(0, 60), pendingId]);
      return { action: 'error', error: e.message };
    }
    if (rawOrder?.action?.startsWith?.('skip_')) {
      await query(`UPDATE bot_advance_trades SET status='failed', exit_reason='broker_skip' WHERE id=$1`, [pendingId]);
      return rawOrder;
    }
    const order = _normalizeOrder(rawOrder, price);
    if (!(order.fill_price > 0)) {
      await query(`UPDATE bot_advance_trades SET status='failed', exit_reason='no_fill_price' WHERE id=$1`, [pendingId]);
      return { action: 'error', error: 'order returned no fill price' };
    }

    const stopLossPrice = +(order.fill_price * (1 - rule.exits.hard_sl_pct)).toFixed(2);

    // Promote pending → open with full fill data
    await query(`
      UPDATE bot_advance_trades
         SET status='open',
             order_id=$1,
             qty=$2, entry_price=$3, dollars_invested=$4,
             stop_loss_price=$5,
             opened_at=NOW()
       WHERE id=$6
    `, [order.order_id, qty, order.fill_price, +(qty * order.fill_price).toFixed(2), stopLossPrice, pendingId]);

    // For backwards compat / display, set current_trade_id to most-recent open trade
    await query(`UPDATE bots_advance SET current_trade_id=$1, updated_at=NOW() WHERE id=$2`, [pendingId, bot.id]);

    console.log(`[bot-advance/exec] bot ${bot.id} OPENED ${symbol} x${qty} @ $${order.fill_price} rule=${d.entry_rule} trade=${pendingId}`);
    sendTelegram(
      `${ADVANCE_PREFIX} 🟢 <b>OPENED</b> ${symbol} x${qty} @ $${Number(order.fill_price).toFixed(2)}\n` +
      `Bot ${bot.id} ${bot.name} • rule=<code>${d.entry_rule}</code>\n` +
      `Stop: $${stopLossPrice} • $${(qty * order.fill_price).toFixed(0)} deployed • broker=${bot.broker}`
    ).catch(() => {});

    return { action: 'opened', symbol, trade_id: pendingId, qty, fill_price: order.fill_price };
  } catch (e) {
    // Catch-all safety net — never leave a 'pending' row stuck.
    await query(`UPDATE bot_advance_trades SET status='failed', exit_reason=$1 WHERE id=$2 AND status='pending'`,
      [String(e.message).slice(0, 60), pendingId]).catch(() => {});
    return { action: 'error', error: e.message };
  }
}

// ─── Manage one open position ────────────────────────────────────────────────
// Called for each open trade on every executor tick.
async function _manageOnePosition(bot, trade) {
  if (!trade || trade.status !== 'open') return { action: 'noop' };

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

  // Clear current_trade_id if it pointed at this trade; recompute cumulative PnL
  await query(`
    UPDATE bots_advance
       SET current_trade_id = (
         SELECT id FROM bot_advance_trades
          WHERE bot_id=$2 AND status='open' AND id != $3
          ORDER BY id DESC LIMIT 1
       ),
       cumulative_pnl_usd = cumulative_pnl_usd + $1,
       updated_at = NOW()
     WHERE id=$2
  `, [pnlUsd, bot.id, trade.id]);

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
// Multi-position model: every tick we (1) manage ALL existing open positions,
// then (2) try to open new positions if there's room under max_concurrent_positions.
// The "1 position" model has been retired (current_trade_id is now just a
// display hint pointing at the most recent open trade).
export async function processBotAdvance(bot) {
  if (_runningBots.has(bot.id)) return { skipped: true, reason: 'inflight' };
  _runningBots.add(bot.id);
  try {
    if (bot.shadow_mode) return { skipped: true, reason: 'shadow_mode' };

    // 1. Manage all currently open positions (exit checks)
    const { rows: openTrades } = await query(
      `SELECT * FROM bot_advance_trades WHERE bot_id=$1 AND status='open' ORDER BY id`,
      [bot.id]
    );
    const manageResults = [];
    for (const trade of openTrades) {
      const r = await _manageOnePosition(bot, trade).catch(e => ({ action: 'error', error: e.message }));
      manageResults.push({ trade_id: trade.id, ...r });
    }

    // 2. After managing, see if there's room to open new positions
    const openR = await _tryOpenPosition(bot);

    return { manage: manageResults, open: openR };
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
