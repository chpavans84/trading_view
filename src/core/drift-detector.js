/**
 * src/core/drift-detector.js
 *
 * Compares the DB's view of a bot's open positions against the BROKER's truth.
 * Two consumers:
 *   1. Pre-decision check — bot scanner calls `getBrokerOpenSymbols(bot)` BEFORE
 *      checking "am I at position cap?" The cap is per-broker reality, not per-DB.
 *      Prevents the bot 4 phantom-cap paralysis we hit 2026-06-02 (DB said 5/5,
 *      broker had 0, bot couldn't scan).
 *   2. Periodic drift cron — every 5 min during RTH, full reconciliation.
 *      Phantom DB rows (DB-open, broker-no-position) → auto-mark failed/phantom.
 *      Orphan broker positions (broker-has, DB-no-row) → log warning only
 *      (manual review; auto-creation is too dangerous).
 *
 * Author: 2026-06-03 (after Pavan caught the phantom-position bug).
 * Discipline rule: "Always cross-check broker for any position assertion."
 */

import { query, isDbAvailable } from './db.js';
import { sendTelegram } from './telegram.js';

// Lazy broker imports — these have side effects on first import.
async function _alpacaPositions(creds) {
  const { getUserPositions, getPositions } = await import('./trader.js');
  if (creds && creds.apiKey) return await getUserPositions(creds);
  return await getPositions();  // admin/env fallback
}
async function _tigerPositions(creds) {
  const { getTigerPositions } = await import('./tiger.js');
  return await getTigerPositions(creds);
}

/**
 * Pull broker creds for a (userId, broker) pair.
 * Returns null if not configured — caller should fall back to DB on null.
 */
async function _loadCreds(userId, broker) {
  if (!isDbAvailable()) return null;
  try {
    const { rows } = await query('SELECT * FROM users WHERE id=$1', [userId]);
    const u = rows[0];
    if (!u) return null;
    if (broker === 'alpaca') {
      if (u.alpaca_api_key && u.alpaca_secret_key) {
        return { apiKey: u.alpaca_api_key, secretKey: u.alpaca_secret_key,
                 baseUrl: u.alpaca_base_url || 'https://paper-api.alpaca.markets' };
      }
      if (u.role === 'admin' && process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY) {
        return { apiKey: process.env.ALPACA_API_KEY, secretKey: process.env.ALPACA_SECRET_KEY,
                 baseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets' };
      }
    }
    if (broker === 'tiger_demo') {
      const { decryptCredential } = await import('./crypto.js');
      const pkey = u.tiger_demo_private_key;
      if (!u.tiger_demo_id || !u.tiger_demo_account || !pkey) return null;
      return { tiger_id: u.tiger_demo_id, account: u.tiger_demo_account,
               private_key: decryptCredential(pkey) };
    }
  } catch (e) {
    console.warn(`[drift-detector] _loadCreds(${userId},${broker}):`, e.message);
  }
  return null;
}

/**
 * Get the SET of symbols currently held at the broker for a bot's account.
 *
 * @param {object} bot — { user_id, broker, ... }
 * @returns {Promise<{ symbols: Set<string>, available: boolean }>}
 *   - available=false means we couldn't talk to broker (network, no creds);
 *     callers must NOT treat empty symbols as "no positions" — fall back to DB.
 */
export async function getBrokerOpenSymbols(bot) {
  if (!bot?.broker || bot.user_id == null) return { symbols: new Set(), available: false };
  const creds = await _loadCreds(bot.user_id, bot.broker);
  // For alpaca, admin can fall back to env creds (no per-user creds needed).
  if (!creds && !(bot.broker === 'alpaca')) return { symbols: new Set(), available: false };
  try {
    let positions;
    if (bot.broker === 'alpaca') positions = await _alpacaPositions(creds);
    else if (bot.broker === 'tiger_demo') positions = await _tigerPositions(creds);
    else return { symbols: new Set(), available: false };
    const out = new Set();
    for (const p of positions || []) {
      const sym = (p.symbol || p.contract?.symbol || p.ticker || '').toUpperCase();
      const qty = Math.abs(Number(p.qty ?? p.quantity ?? p.position ?? 0));
      if (sym && qty > 0) out.add(sym);
    }
    return { symbols: out, available: true };
  } catch (e) {
    console.warn(`[drift-detector] getBrokerOpenSymbols(bot=${bot.id ?? '?'}):`, e.message);
    return { symbols: new Set(), available: false };
  }
}

/**
 * Reconcile ONE bot's DB-open trades against broker truth.
 * - Phantom (DB-open, broker doesn't have): auto-mark failed/alpaca_reconcile_phantom
 * - Orphan (broker has, DB doesn't): log + telegram warning only
 *
 * Engines:
 *   - 'legacy'  → trades + bots tables
 *   - 'advance' → bot_advance_trades + bots_advance tables
 *
 * Returns { reconciled: [{symbol, trade_id, action}], orphans: [symbol] }
 */
export async function reconcileBot({ bot, engine }) {
  if (!isDbAvailable()) return { reconciled: [], orphans: [] };
  const { symbols: brokerSymbols, available } = await getBrokerOpenSymbols(bot);
  if (!available) {
    console.log(`[drift-detector] bot ${bot.id} (${bot.name}): broker unavailable, skipping reconcile`);
    return { reconciled: [], orphans: [], skipped: true };
  }

  // DB-open symbols
  const table = engine === 'advance' ? 'bot_advance_trades' : 'trades';
  const { rows: dbRows } = await query(
    `SELECT id, symbol FROM ${table}
      WHERE bot_id=$1 AND status IN ('open','pending')`,
    [bot.id]
  );
  const dbSymbols = new Map(dbRows.map(r => [r.symbol.toUpperCase(), r.id]));

  // Phantoms: DB has but broker doesn't
  const reconciled = [];
  for (const [sym, tid] of dbSymbols) {
    if (!brokerSymbols.has(sym)) {
      try {
        await query(
          `UPDATE ${table}
              SET status='failed',
                  exit_reason=COALESCE(exit_reason, 'alpaca_reconcile_phantom'),
                  closed_at=NOW()
            WHERE id=$1`,
          [tid]
        );
        reconciled.push({ symbol: sym, trade_id: tid, action: 'phantom_marked_failed' });
        console.warn(`[drift-detector] bot ${bot.id} phantom RECONCILED: ${sym} trade ${tid}`);
      } catch (e) {
        console.error(`[drift-detector] bot ${bot.id} reconcile failed for ${sym}:`, e.message);
      }
    }
  }
  // Clear current_trade_id on the bot row if it pointed at one of the reconciled trades
  if (reconciled.length) {
    const botsTable = engine === 'advance' ? 'bots_advance' : 'bots';
    await query(`UPDATE ${botsTable} SET current_trade_id=NULL, updated_at=NOW() WHERE id=$1`, [bot.id]).catch(() => {});
  }

  // Orphans: broker has but DB doesn't — log only (creating DB rows is risky)
  const orphans = [];
  for (const sym of brokerSymbols) {
    if (!dbSymbols.has(sym)) orphans.push(sym);
  }
  return { reconciled, orphans };
}

/**
 * Reconcile ALL active bots (both engines) — call from cron.
 * Throttled by user+broker (one broker call per (user, broker), reused across bots).
 */
export async function reconcileAllBots() {
  if (!isDbAvailable()) return { skipped: true };
  // Load active bots from both engines
  const [{ rows: legacyBots }, { rows: advanceBots }] = await Promise.all([
    query(`SELECT * FROM bots WHERE status='active' AND deleted_at IS NULL`),
    query(`SELECT * FROM bots_advance WHERE status='active' AND deleted_at IS NULL`),
  ]);
  const allBots = [
    ...legacyBots.map(b => ({ ...b, _engine: 'legacy' })),
    ...advanceBots.map(b => ({ ...b, _engine: 'advance' })),
  ];

  // Cache broker positions by (user, broker) to avoid duplicate API calls.
  const cache = new Map();
  const summary = { totalBots: allBots.length, totalReconciled: 0, totalOrphans: 0, perBot: [] };
  for (const bot of allBots) {
    const key = `${bot.user_id}:${bot.broker}`;
    let brokerSymsResult;
    if (cache.has(key)) brokerSymsResult = cache.get(key);
    else {
      brokerSymsResult = await getBrokerOpenSymbols(bot);
      cache.set(key, brokerSymsResult);
    }
    // Substitute in-process so reconcileBot doesn't refetch
    const origFn = await import('./drift-detector.js');
    const r = await reconcileBotWithBrokerSymbols(bot, brokerSymsResult);
    summary.perBot.push({ bot_id: bot.id, name: bot.name, ...r });
    summary.totalReconciled += r.reconciled?.length || 0;
    summary.totalOrphans    += r.orphans?.length   || 0;
  }
  // One telegram per reconcile run, if anything happened
  if (summary.totalReconciled > 0 || summary.totalOrphans > 0) {
    const lines = summary.perBot
      .filter(p => p.reconciled?.length || p.orphans?.length)
      .map(p => `• bot ${p.bot_id} ${p.name}: phantoms=[${p.reconciled?.map(r=>r.symbol).join(',')||'-'}] orphans=[${p.orphans?.join(',')||'-'}]`);
    sendTelegram(
      `🔧 <b>Drift detector reconciled ${summary.totalReconciled} phantoms, found ${summary.totalOrphans} orphans</b>\n${lines.join('\n')}`
    ).catch(() => {});
  }
  return summary;
}

/**
 * Book a single phantom row — a trade the DB tracks as open/pending but the broker
 * has no matching position for.
 *
 * ROOT-CAUSE FIX (2026-07-07). The old sweep dumped EVERY phantom as status='failed',
 * which zeroes pnl_usd. But 119 of 170 historical phantoms HAD a real fill
 * (dollars_invested > 0) — real positions that left the broker outside our own close
 * path (a sibling order path, a manual/auto liquidation, or a lost close-write). Booking
 * those as 'failed' silently deleted their P&L and is the main reason the DB ledger
 * (−$1,605) disagreed with the Alpaca account (−$592).
 *
 * Now: a filled row is booked as a real CLOSE at last-known price (best available
 * estimate) with a distinct, auditable exit_reason so it carries P&L. A never-filled
 * row ($0) stays 'failed' — the order genuinely never became a position.
 *
 * Scoped to bot_advance_trades: the legacy `trades` table has ambiguous duplicate
 * columns (entry_price vs entry_px, qty twice) so its P&L math is left untouched.
 *
 * @param {string} table  'bot_advance_trades' | 'trades'
 * @param {{id:number, symbol:string, dollars_invested?:number, entry_price?:number, qty?:number}} row
 * @returns {Promise<'closed'|'failed'>} the terminal status written
 */
/**
 * Terminal status a phantom row should receive (pure — exported for unit tests).
 * Only a filled advance trade (dollars_invested > 0) is booked as a real 'closed'
 * with P&L; a never-filled order, or any non-advance table, is a genuine 'failed'.
 */
export function phantomTerminalStatus(table, dollarsInvested) {
  return (table === 'bot_advance_trades' && Number(dollarsInvested) > 0) ? 'closed' : 'failed';
}

export async function bookPhantomRow(table, row) {
  // Never filled, or a table we don't book P&L for → genuine failed order.
  if (phantomTerminalStatus(table, row.dollars_invested) === 'failed') {
    await query(
      `UPDATE ${table} SET status='failed',
              exit_reason=COALESCE(exit_reason, 'alpaca_reconcile_phantom'), closed_at=NOW()
        WHERE id=$1`, [row.id]);
    return 'failed';
  }
  // Had a fill → the position really existed and exited outside our path. Book a real
  // close using last known price; fall back to entry (0 P&L) if the quote is unavailable
  // — still better than dropping the row and its capital.
  const entry = Number(row.entry_price) || 0;
  const qty   = Number(row.qty) || 0;
  let exitPx  = entry;
  try {
    const { getLatestPrice } = await import('./trader.js');
    const px = await getLatestPrice(row.symbol);
    if (px && px > 0) exitPx = px;
  } catch { /* keep entry-price fallback */ }
  const pnlUsd = (exitPx - entry) * qty;
  const pnlPct = entry > 0 ? ((exitPx - entry) / entry) * 100 : 0;
  await query(
    `UPDATE ${table}
        SET status='closed', exit_price=$1, exit_reason='reconciled_missing_from_broker',
            pnl_usd=$2, pnl_pct=$3, closed_at=NOW()
      WHERE id=$4`,
    [exitPx, pnlUsd, pnlPct, row.id]);
  return 'closed';
}

// Helper: variant of reconcileBot that takes pre-fetched broker symbols (cache hit)
async function reconcileBotWithBrokerSymbols(bot, { symbols: brokerSymbols, available }) {
  if (!available) return { reconciled: [], orphans: [], skipped: true };
  const engine = bot._engine || 'legacy';
  const table = engine === 'advance' ? 'bot_advance_trades' : 'trades';
  const { rows: dbRows } = await query(
    `SELECT id, symbol, dollars_invested, entry_price, qty
       FROM ${table} WHERE bot_id=$1 AND status IN ('open','pending')`,
    [bot.id]
  );
  const dbSymbols = new Map(dbRows.map(r => [r.symbol.toUpperCase(), r]));
  const reconciled = [];
  for (const [sym, row] of dbSymbols) {
    if (!brokerSymbols.has(sym)) {
      try {
        const booked = await bookPhantomRow(table, row);
        reconciled.push({ symbol: sym, trade_id: row.id, booked });
      } catch (e) {
        console.error(`[drift-detector] reconcile bot ${bot.id} ${sym}:`, e.message);
      }
    }
  }
  if (reconciled.length) {
    const botsTable = engine === 'advance' ? 'bots_advance' : 'bots';
    await query(`UPDATE ${botsTable} SET current_trade_id=NULL, updated_at=NOW() WHERE id=$1`, [bot.id]).catch(() => {});
  }
  // Orphans: broker has X, but NO bot on this (user, broker) tracks it.
  // 2026-06-03 fix: check ALL siblings (both engines) before declaring orphan.
  // Otherwise bot 27 sees bot 2's positions as orphans → noise.
  const orphans = [];
  if (brokerSymbols.size > 0) {
    const { rows: siblingRows } = await query(`
      SELECT UPPER(t.symbol) AS sym FROM trades t JOIN bots b ON b.id=t.bot_id
       WHERE t.status IN ('open','pending') AND b.user_id=$1 AND b.broker=$2
      UNION
      SELECT UPPER(bat.symbol) FROM bot_advance_trades bat JOIN bots_advance ba ON ba.id=bat.bot_id
       WHERE bat.status IN ('open','pending') AND ba.user_id=$1 AND ba.broker=$2
    `, [bot.user_id, bot.broker]);
    const allSiblingSyms = new Set(siblingRows.map(r => r.sym));
    for (const sym of brokerSymbols) if (!allSiblingSyms.has(sym)) orphans.push(sym);
  }
  return { reconciled, orphans };
}

/**
 * Cron registration — call from server.js or bot-engine.js startup.
 * Runs every 5 min during US market hours.
 */
export function startDriftDetectorCron() {
  if (process.env.BOT_CRON_OWNER !== 'true') {
    console.log('[drift-detector] cron NOT scheduled (BOT_CRON_OWNER != true)');
    return;
  }
  import('node-cron').then(({ default: cron }) => {
    const TZ = { timezone: 'America/New_York' };
    cron.schedule('*/5 9-15 * * 1-5', () => {
      reconcileAllBots().catch(e => console.error('[drift-detector] cron error:', e));
    }, TZ);
    console.log('[drift-detector] cron scheduled — every 5 min during RTH');
  });
}
