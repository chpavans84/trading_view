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
import { placeQuickTrade, closePosition, getLatestPrice, getUserPositions, pollOrderFill } from '../trader.js';
import { placeTigerOrder, closeTigerPosition, getTigerQuote } from '../tiger.js';
import { sendTelegram } from '../telegram.js';
import { getRule } from './entry-rules.js';
import { computeSlippageCents } from './slippage.js';
import { estimateRoundTripCost } from './costs.js';

const ADVANCE_PREFIX = '🧪';
const DECISION_FRESHNESS_MIN = 6;
const _runningBots = new Set();

/**
 * Minimum-hold floor decision (pure — exported for unit tests).
 *
 * Returns true when a would-be exit should be VETOED because the position is younger
 * than min_hold_hours. Catastrophic/risk exits (hard_stop, catastrophic, stop_loss)
 * always pass through, so downside is never trapped. See the 2026-07-07 retrospective:
 * bot-advance exits fired at a ~34-min average hold, so the 5–14d swing thesis behind
 * every entry rule never got time to develop and the bot bled the round-trip spread.
 */
export function shouldVetoExit({ exitReason, heldHours, minHoldHours }) {
  if (!exitReason) return false;
  if (!(minHoldHours > 0)) return false;
  if (/catastroph|hard_stop|stop_loss/i.test(exitReason)) return false;
  return heldHours < minHoldHours;
}

// Pure mechanical-exit decision (exported for unit tests). Returns the exit reason or null.
// CRITICAL invariant (2026-08-12): trailFraction <= 0 means NO trailing stop. The prior inline
// code used `currentPnl < peakPnl * (1 - trailFraction)`, which with trailFraction=0 exits on
// any tick below peak — a hair-trigger trail that defeated the insider rule's 20-day hold and
// churned positions daily. Only hard_stop and time_stop apply when the trail is disabled.
export function decideMechanicalExit({ currentPnl, peakPnl, hardSlUsd, trailFraction, trailMinPeak, heldDays, timeStopDays }) {
  if (currentPnl <= -hardSlUsd) return 'hard_stop';
  const trailEnabled = trailFraction > 0;
  if (trailEnabled && peakPnl > trailMinPeak && currentPnl < peakPnl * (1 - trailFraction)) return 'trail_stop';
  if (heldDays >= timeStopDays) return 'time_stop';
  return null;
}

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

// Fair-value price from a possibly-broken NBBO quote (exported for tests). IEX quotes on thin
// small-caps often have a 0 leg (e.g. PFE ask=0 → getLatestPrice's precomputed mid=$12.78 for a
// $25 stock) or a very wide spread. For MARK-TO-MARKET we want fair value, so:
//   both legs valid → mid (the fair mark, even when the spread is wide — bid and ask are both
//                     noise AROUND fair value; marking at the bid would fabricate false losses
//                     and trip hard-stops on flat positions, e.g. ARTV bid 9.54 / mid 11.7 ≈ entry)
//   one leg valid   → that leg (the only signal)
//   nothing valid   → null (caller uses the last-close fallback)
// NB: the EXIT-price estimate is a DIFFERENT question (where a market SELL actually fills) and is
// handled at the close site, which prefers the bid. Do not conflate the two.
export function _saneQuotePrice(q) {
  const bid = Number(q?.bid) > 0 ? Number(q.bid) : null;
  const ask = Number(q?.ask) > 0 ? Number(q.ask) : null;
  if (bid && ask) return (bid + ask) / 2;
  return bid ?? ask ?? (Number(q?.last) > 0 ? Number(q.last) : null);
}

// Try live quote first; fall back to last close from backtest_prices.
// The fallback is only for SIZING — the actual stop_loss is computed from the
// broker's real fill price, not from this estimate. Off-by-a-few-percent on
// sizing is bounded by max_position_usd=$1K anyway.
async function _getLivePrice(bot, creds, symbol) {
  let live = null;
  try {
    if (bot.broker === 'tiger_demo') {
      // Fix E-3 (2026-05-29): Tiger simulator accounts do not support
      // quote_real_time (returns error 1000).  Skip straight to the
      // backtest_prices fallback to avoid console.error spam on every tick.
      live = null;
    } else {
      // Value a LONG at what it can be SOLD for (2026-08-12). Using ask overvalued every open
      // long, inflating currentPnl/peakPnl on thin small-caps (part of the ask-bias that also
      // fabricated exit prices). But IEX quotes on these names are frequently BROKEN — one leg
      // is 0 (e.g. PFE ask=0 → getLatestPrice's precomputed mid=$12.78 for a $25 stock) or the
      // spread is absurd. So derive a SANE price from the raw legs: use mid only when BOTH legs
      // are valid, else the single valid leg, else fall through to the last-close fallback.
      const q = await getLatestPrice(symbol);
      live = _saneQuotePrice(q);
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
  // Fix E-2 (2026-05-29): also exclude decisions that already produced a 'failed'
  // trade row.  Without this, a broker rejection (e.g. Tiger code 1200 after market
  // close) is treated as a cleared slot and the next executor tick retries the same
  // decision, producing one failed row per minute for every open decision.
  // Matching on decision_id (not just symbol) is precise: a new decision for the
  // same symbol on the same day is still eligible if it passed the scanner dedup.
  //
  // Fix E-3 (2026-05-29): generalised the decision-consumption check to ANY status,
  // not just 'failed'. Previous behaviour let a `closed` trade re-fire its decision
  // (e.g. SRAD trade #276 opened 22:11:02, closed 22:15:08 on a quick stop-out, then
  // SAME decision #167 fired AGAIN at 22:15:08 producing malformed pending trade #278
  // with qty=0/entry=0). Rule is now strictly "one decision → at most one trade,
  // regardless of status." Concurrency dedup is still handled by the symbol+open/pending
  // NOT-EXISTS above; the upstream scanner's 15-min cross-process dedup is the other guard.
  const { rows: decisions } = await query(`
    SELECT d.id, d.symbol, d.entry_rule, d.rule_metadata, d.composite_score, d.signals
      FROM bot_advance_decisions d
     WHERE d.bot_id=$1 AND d.action='would_buy'
       AND d.scanned_at > NOW() - ($2 * INTERVAL '1 minute')
       AND NOT EXISTS (
         SELECT 1 FROM bot_advance_trades t
          WHERE t.bot_id = d.bot_id
            AND t.symbol = UPPER(d.symbol)
            AND t.status IN ('open', 'pending')
       )
       AND NOT EXISTS (
         SELECT 1 FROM bot_advance_trades t
          WHERE t.decision_id = d.id
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

    // 2026-06-03 (CLS/ELMT catastrophe): LIVE-QUOTE VALIDATION.
    // Compare broker live price vs the scan-time cached price stored in the
    // decision's signals JSON. If they diverge by > 5%, reject — the scan's
    // thesis was built on stale data. Saved $1000+ on 2026-06-02 if shipped earlier.
    const cachedPriceFromScan = Number(d.signals?.current_price ?? d.signals?.last_price);
    const maxQuoteDivergence  = Number(bot.rules?.entry_filters?.max_entry_quote_divergence_pct ?? 5);
    if (cachedPriceFromScan > 0 && maxQuoteDivergence > 0) {
      const divergence = ((price - cachedPriceFromScan) / cachedPriceFromScan) * 100;
      if (Math.abs(divergence) > maxQuoteDivergence) {
        const reason = `live_quote_diverged_${divergence > 0 ? 'up' : 'down'}_${Math.abs(divergence).toFixed(1)}pct`;
        console.warn(`[bot-advance/exec] bot ${bot.id} SKIP ${symbol}: live=${price} cache=${cachedPriceFromScan} divergence=${divergence.toFixed(1)}% (>${maxQuoteDivergence}%) — stale-cache catastrophe protection`);
        await query(`UPDATE bot_advance_trades SET status='failed', exit_reason=$1 WHERE id=$2`,
          [reason.slice(0, 30), pendingId]);
        return { action: 'skip_live_quote_diverged', symbol, live: price, cache: cachedPriceFromScan, divergence_pct: +divergence.toFixed(2) };
      }
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
    // ── ORDER-PATH FIX (BUGFIXES_ORDER_PATH.md BUG 1, applied 2026-06-12) ──
    // NO scan-price fallback for the open decision: only a REAL broker fill may
    // promote pending → open. The old fallback fabricated entries at stale scan
    // prices (HUT −$4,754 "1-minute" trade) that the broker never executed.
    const order = _normalizeOrder(rawOrder, null);
    // Persist order_id on the pending row NOW, so a crash/timeout leaves a
    // resolvable row (the stale-pending sweeper re-polls it next tick).
    if (order.order_id) {
      await query(`UPDATE bot_advance_trades SET order_id=$1 WHERE id=$2`, [order.order_id, pendingId]);
    }

    if (!(order.fill_price > 0) && bot.broker === 'alpaca' && order.order_id) {
      // Market orders fill async — poll the broker for the real outcome.
      const polled = await pollOrderFill(order.order_id, { timeoutMs: 8000 });
      if (polled.status === 'filled') {
        order.fill_price = polled.fill_price;
        order.fill_qty   = polled.fill_qty || qty;
      } else if (['rejected', 'canceled', 'expired', 'done_for_day'].includes(polled.status)) {
        await query(`UPDATE bot_advance_trades SET status='failed', exit_reason=$1 WHERE id=$2`,
          [`broker_${polled.status}`.slice(0, 30), pendingId]);
        return { action: 'broker_' + polled.status, symbol };
      } else {
        // Still working after timeout — leave the row PENDING (dedup blocks a
        // duplicate buy); the sweeper resolves it on a later tick. Never open blind.
        console.warn(`[bot-advance/exec] bot ${bot.id} ${symbol}: order ${order.order_id} unfilled after poll (${polled.status}) — leaving pending`);
        return { action: 'pending_unfilled', symbol, order_id: order.order_id };
      }
    }
    if (!(order.fill_price > 0)) {
      await query(`UPDATE bot_advance_trades SET status='failed', exit_reason='no_fill_price' WHERE id=$1`, [pendingId]);
      return { action: 'error', error: 'order returned no fill price' };
    }

    // BUG 3 + order-path #2 (2026-06-14): record TRUE execution slippage = fill
    // vs the live quote THIS executor fetched and sized the order against
    // (`price`, line ~290 — divergence-validated against the scan cache).
    //   Previously used rawOrder.estimated_price, a SEPARATE quote re-fetched deep
    // inside trader.js/placeQuickTrade. That value was stale/wrong for some names and
    // produced absurd "slippage" — NUVL −1750¢ (−14% of price), GLXY −204¢ (−6%) on
    // 2026-06-13 — i.e. it measured decision-anchor drift, not execution. The
    // executor's own `price` is the honest reference.
    //   Sanity-clamp: a liquid market order can't realistically slip >5%/share; beyond
    // that the reference is bad, so record null rather than a fictional number.
    const expectedPx = Number(price) > 0 ? Number(price) : (Number(rawOrder?.estimated_price) || null);
    const slippageCents = computeSlippageCents(order.fill_price, expectedPx);
    if (slippageCents == null && expectedPx) {
      console.warn(`[bot-advance/exec] ${symbol}: implausible slippage ref (fill ${order.fill_price} vs ${expectedPx}) — recording null`);
    }

    const stopLossPrice = +(order.fill_price * (1 - rule.exits.hard_sl_pct)).toFixed(2);

    // Capture entry_score for intelligent-exit re-scoring (2026-06-03).
    // For ml_v2_intelligence: composite_score in decisions is the model prob × 100.
    // For other rules: store composite_score / 100 as normalized 0..1 prob-like value.
    const rawScore = d.composite_score != null ? Number(d.composite_score) : null;
    const entryScore = rawScore != null
      ? (d.entry_rule === 'ml_v2_intelligence' ? rawScore : rawScore / 100)
      : null;

    // Promote pending → open with full REAL fill data
    await query(`
      UPDATE bot_advance_trades
         SET status='open',
             order_id=$1,
             qty=$2, entry_price=$3, dollars_invested=$4,
             stop_loss_price=$5,
             entry_score=$7,
             slippage_cents=$8,
             opened_at=NOW()
       WHERE id=$6
    `, [order.order_id, qty, order.fill_price, +(qty * order.fill_price).toFixed(2), stopLossPrice, pendingId, entryScore, slippageCents]);

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

  // ── Intelligent exit (opt-in per bot, 2026-06-03) ───────────────────────────
  // Backtest evidence: +5.18% per trade edge over mechanical (176 trades, 20d).
  // Replaces hard_sl_pct / trail_pct / time_stop_days with thesis-break check
  // + catastrophic floor (-15%). Opt-in via bot.rules.intelligent_exit_enabled.
  let exitReason = null;
  const { isIntelligentExitEnabled, decideIntelligentExit, rescoreForExit, getExitEventFlags } = await import('../intelligent-exit.js');
  if (isIntelligentExitEnabled(bot)) {
    try {
      const currentScore = await rescoreForExit({ symbol: trade.symbol, entryRule: trade.entry_rule });
      const eventFlags   = await getExitEventFlags(trade.symbol);
      const decision = decideIntelligentExit({
        bot,
        entryScore: trade.entry_score != null ? Number(trade.entry_score) : null,
        currentScore,
        currentPnl,
        dollarsInvested: dollarsInv,
        eventFlags,
      });
      if (decision.exit) exitReason = decision.reason;
    } catch (e) {
      console.warn(`[bot-advance/exec] intelligent_exit failed for ${trade.symbol}, falling back to mechanical:`, e.message);
    }
  }

  // ── Mechanical exit (fallback or when intelligent_exit not enabled) ─────────
  if (!exitReason) {
    const hardSlUsd = dollarsInv * Number(trade.hard_sl_pct);
    const trailFraction = Number(trade.trail_pct) / 100;
    // COST-AWARE trail arming (2026-06-19). The old 1% gate armed the trail almost
    // immediately, so a 30% give-back of a tiny +1% peak exited on intraday noise
    // within minutes (the retrospective's 42-min scalping — 53/56 exits, +0.4% avg
    // that loses money after fees). Now the trail only engages once peak profit has
    // cleared BOTH the round-trip platform cost (×3) AND a meaningful gain (default
    // +4% of notional) — letting winners run to the time stop. Tunable: rules.exits.trail_arm_pct.
    const rtCost   = estimateRoundTripCost(bot.broker, dollarsInv, bot);
    const armPct   = Number(bot.rules?.exits?.trail_arm_pct ?? 0.04);
    const trailMinPeak = Math.max(dollarsInv * armPct, rtCost * 3);
    const heldDays = (Date.now() - new Date(trade.opened_at).getTime()) / 86_400_000;

    // trail_pct <= 0 disables the trail (see decideMechanicalExit) — the position then runs to
    // the 15% hard stop or the 20-day time stop, as the insider rule intends.
    exitReason = decideMechanicalExit({
      currentPnl, peakPnl, hardSlUsd, trailFraction, trailMinPeak,
      heldDays, timeStopDays: Number(trade.time_stop_days),
    });
  }

  // ── Minimum-hold floor (2026-07-07) ─────────────────────────────────────────
  // Retrospective (Alpaca paper, 203 closed bot-advance trades): trail_stop and
  // thesis_broken fired at a ~34-min (0.57h) AVERAGE hold — even AFTER the 2026-06-19
  // trail-arm fix, which left hold time unchanged. The 5–14d swing thesis behind every
  // entry rule never got time to develop; the bot behaved as an intraday scalper and
  // bled the round-trip spread. Veto NON-catastrophic exits until the trade has aged
  // past min_hold_hours. hard_stop and any intelligent catastrophic/stop_loss exit
  // ALWAYS bypass (risk must never be trapped), and time_stop is naturally > floor.
  // Tunable per bot via rules.exits.min_hold_hours (0 disables). Default 24h.
  // NOTE: default is CONSERVATIVE, not yet sim-proven — calibrate in BOT_SIM before
  // promoting to live. Downside stays capped by hard_sl_pct + the catastrophic floor.
  if (exitReason) {
    // Default 6h — BOT_SIM-calibrated (2026-07-07 sweep, R1 window): a small floor kills
    // the sub-hour scalping the live bot showed (trail_stop 0.7h / thesis_broken 0.0h) at
    // negligible cost (−0.1pp), while LARGE floors (≥24h) monotonically HURT in calm bull
    // (−1.1pp at 72h — lengthening holds into R1 loses, matching the −5.6% learning lesson).
    // hard_stop/catastrophic always bypass so downside stays capped regardless.
    const minHoldHours = Number(bot.rules?.exits?.min_hold_hours ?? 6);
    const heldHours    = (Date.now() - new Date(trade.opened_at).getTime()) / 3_600_000;
    if (shouldVetoExit({ exitReason, heldHours, minHoldHours })) {
      return {
        action:      'hold',
        symbol:      trade.symbol,
        pnl:         currentPnl,
        held_hours:  Number(heldHours.toFixed(2)),
        vetoed_exit: exitReason,
        note:        `min_hold_floor: ${heldHours.toFixed(1)}h < ${minHoldHours}h`,
      };
    }
  }

  if (!exitReason) return { action: 'hold', symbol: trade.symbol, pnl: currentPnl };

  // Place sell
  let rawOrder;
  try { rawOrder = await _placeSellOrder(bot, creds, trade.symbol, qty); }
  catch (e) {
    console.error(`[bot-advance/exec] bot ${bot.id} ${trade.symbol}: sell failed:`, e.message);
    return { action: 'error', error: e.message };
  }
  const order = _normalizeOrder(rawOrder, null);
  // Book the REAL fill, not the quote (2026-08-12). Previously exitPrice fell back to `px`,
  // and `px` is getLatestPrice().ask — on a thin small-cap the ask sits far above where a
  // market SELL actually fills (ARTV booked at $12.32 ask while the real fill was $10.74),
  // fabricating +$185 phantom wins and making the DB ledger read +$2,721 while the broker was
  // −$173. closePosition is a market order that fills async, so poll it like the entry path.
  if (!(order.fill_price > 0) && bot.broker === 'alpaca' && order.order_id) {
    try {
      const polled = await pollOrderFill(order.order_id, { timeoutMs: 8000 });
      if (polled?.fill_price > 0) order.fill_price = polled.fill_price;
    } catch { /* fall through to conservative estimate below */ }
  }
  // If the fill still can't be read, estimate from a SANE quote (guards the broken-IEX-leg
  // case), preferring the bid where a sell realistically lands; last resort is px.
  let exitPrice = order.fill_price;
  if (!(exitPrice > 0)) {
    try {
      const q = await getLatestPrice(trade.symbol);
      exitPrice = Number(q?.bid) > 0 ? Number(q.bid) : (_saneQuotePrice(q) ?? px);
    } catch { exitPrice = px; }
  }
  // NET P&L = gross − estimated round-trip platform charge (2026-06-19). The bot now
  // books costs, so pnl_usd / cumulative / the daily-loss breaker all reflect reality.
  const grossPnl = (exitPrice - entry) * qty;
  const estCost  = estimateRoundTripCost(bot.broker, dollarsInv, bot);
  const pnlUsd   = +(grossPnl - estCost).toFixed(2);
  const pnlPct   = +((pnlUsd / dollarsInv) * 100).toFixed(3);

  await query(`
    UPDATE bot_advance_trades
       SET status='closed', exit_price=$1, exit_reason=$2,
           pnl_usd=$3, pnl_pct=$4, peak_pnl_usd=$5, est_cost_usd=$7, closed_at=NOW()
     WHERE id=$6
  `, [exitPrice, exitReason, pnlUsd, pnlPct, peakPnl, trade.id, estCost]);

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
/**
 * Resolve 'pending' rows that have a broker order_id but never promoted —
 * the poll timed out (or the process died) mid-open. Re-polls the broker:
 * filled → open with the REAL fill; terminal-failed → failed; still working → leave.
 * Part of the BUG-1 order-path fix: a pending row is a question for the broker,
 * never something to guess about.
 */
async function _resolveStalePendings(bot) {
  if (bot.broker !== 'alpaca') return;
  // Safe without a freshness filter: processBotAdvance is serialized per bot
  // (_runningBots) and this sweep runs BEFORE any new pending is inserted, so a
  // pending row with an order_id here is always from a PREVIOUS tick.
  const { rows } = await query(`
    SELECT id, symbol, order_id, qty, hard_sl_pct
      FROM bot_advance_trades
     WHERE bot_id=$1 AND status='pending' AND order_id IS NOT NULL
  `, [bot.id]).catch(() => ({ rows: [] }));
  for (const p of rows) {
    try {
      const polled = await pollOrderFill(p.order_id, { timeoutMs: 3000 });
      if (polled.status === 'filled' && polled.fill_price > 0) {
        const fillQty = polled.fill_qty || Number(p.qty) || 0;
        const stop = p.hard_sl_pct != null ? +(polled.fill_price * (1 - Number(p.hard_sl_pct))).toFixed(2) : null;
        await query(`
          UPDATE bot_advance_trades
             SET status='open', qty=$1, entry_price=$2, dollars_invested=$3,
                 stop_loss_price=COALESCE($4, stop_loss_price), opened_at=NOW()
           WHERE id=$5 AND status='pending'`,
          [fillQty, polled.fill_price, +(fillQty * polled.fill_price).toFixed(2), stop, p.id]);
        console.log(`[bot-advance/exec] bot ${bot.id} resolved stale pending ${p.symbol} → OPEN @ $${polled.fill_price}`);
      } else if (['rejected', 'canceled', 'expired', 'done_for_day'].includes(polled.status)) {
        await query(`UPDATE bot_advance_trades SET status='failed', exit_reason=$1 WHERE id=$2 AND status='pending'`,
          [`broker_${polled.status}`.slice(0, 30), p.id]);
        console.log(`[bot-advance/exec] bot ${bot.id} resolved stale pending ${p.symbol} → failed (${polled.status})`);
      }
      // still working → leave pending; dedup keeps blocking duplicates
    } catch (e) {
      console.warn(`[bot-advance/exec] stale-pending resolve failed for trade ${p.id}:`, e.message);
    }
  }
}

export async function processBotAdvance(bot) {
  if (_runningBots.has(bot.id)) return { skipped: true, reason: 'inflight' };
  _runningBots.add(bot.id);
  try {
    if (bot.shadow_mode) return { skipped: true, reason: 'shadow_mode' };

    // 0. Resolve any pending rows whose broker order outcome is still unknown
    await _resolveStalePendings(bot).catch(() => {});

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
  // Fix E-1 (2026-05-29): market-hours guard mirrors engine.js Fix A-6.
  // Executor cron fires until 15:59 ET but brokers (Tiger in particular) reject
  // orders after 15:30 with code 1200.  Without this guard every post-close tick
  // generates a failed row for each pending decision, producing the 187-row storm
  // we saw before the clean reset.  Allow up to 15:34 so any fill already in
  // progress at 15:30 can settle, then stop hard.
  try {
    const et     = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day    = et.getDay();
    const minsET = et.getHours() * 60 + et.getMinutes();
    if (day === 0 || day === 6 || minsET < 9 * 60 + 30 || minsET >= 15 * 60 + 34) {
      return { skipped: true, reason: 'outside_trading_window' };
    }
  } catch { /* ignore clock failures — let executor proceed */ }
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
