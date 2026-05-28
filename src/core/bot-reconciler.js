/**
 * Bot Reconciler — back-fills missing DB trade rows from live broker positions.
 *
 * Designed for recovery after the line-269 Tiger bug where orders were filled
 * on the broker but recordTrade was never called. Admin-only; always dry-run
 * unless dryRun=false is passed explicitly.
 */

import { query, isDbAvailable, getDbUser, recordTrade } from './db.js';
import { getTigerPositions } from './tiger.js';
import { getPositions, getUserPositions } from './trader.js';
import { alert as raiseSystemAlert } from './system-alerts.js';

// 2026-05-28 (review fix): bump to 30 to preserve provenance for positions held >7 days.
// Decisions table is small; widening the scan window costs nothing and lets us join
// reconciled trades back to their original buy decision for signal_returns analytics.
const LOOKBACK_DAYS = 30;

// 2026-05-28 (review fix): quantity-mismatch comparison must tolerate fractional-share
// float noise (Alpaca returns 5.0000... vs DB NUMERIC 5.0 — strict !== fires phantoms).
// Tolerance picked from MIN_FRACTIONAL_INCREMENT = 0.0001 share on Alpaca.
const QTY_EQ_TOLERANCE = 1e-4;

/**
 * Compare a broker-reported qty vs a DB-stored qty with tolerance + NaN handling.
 * Exported for unit testing — the rest of this module is I/O-coupled.
 *
 * @param {*} dbQty       value from DB (may be NUMERIC string, number, or null/NaN)
 * @param {number} brokerQty broker-reported qty (already cast to Number)
 * @returns {{ match: boolean, dbQty: number|null }}
 *          match=true  → quantities agree within tolerance OR dbQty is unusable
 *                        (in which case caller treats as "qty_null_in_db" mismatch)
 *          dbQty=null  → DB value was NaN/null — surface to caller for separate handling
 */
export function _compareQty(dbQty, brokerQty) {
  // Explicit null/undefined guard: Number(null) === 0 in JS, which would silently
  // mask a NULL DB qty as "0 shares match broker's 0" instead of flagging the mismatch.
  if (dbQty == null) return { match: false, dbQty: null };
  const num = Number(dbQty);
  if (!Number.isFinite(num)) return { match: false, dbQty: null };
  return {
    match: Math.abs(num - brokerQty) <= QTY_EQ_TOLERANCE,
    dbQty: num,
  };
}

/**
 * Reconcile broker positions against the trades table for a given user.
 *
 * @param {{ userId: number, username: string, dryRun?: boolean }} opts
 * @returns {{ matched: object[], unmatched: object[] }}
 */
export async function reconcileBotPositions({ userId, username, dryRun = true }) {
  if (!isDbAvailable()) throw new Error('DB not available');

  // 1. Load all active bots for this user
  const { rows: bots } = await query(
    `SELECT * FROM bots WHERE user_id=$1 AND deleted_at IS NULL`,
    [userId]
  );
  if (!bots.length) return { matched: [], unmatched: [] };

  // 2. Collect open DB trades keyed by symbol+broker so we can detect gaps.
  //    Also build a qty map for mismatch detection (qty stored as NUMERIC → cast to number).
  const { rows: openTrades } = await query(
    `SELECT symbol, account_source, order_id, bot_id, qty
       FROM trades
      WHERE status='open' AND bot_id IN (${bots.map((_, i) => `$${i + 1}`).join(',')})`,
    bots.map(b => b.id)
  );
  // key → true means "DB has a row for this symbol+broker"
  const openTradeKey = new Set(
    openTrades.map(t => `${(t.symbol || '').toUpperCase()}::${(t.account_source || '').toLowerCase()}`)
  );
  // key → qty map for quantity-mismatch detection
  const openTradeQty = new Map(
    openTrades.map(t => [
      `${(t.symbol || '').toUpperCase()}::${(t.account_source || '').toLowerCase()}`,
      Number(t.qty),
    ])
  );

  // 3. Fetch recent buy decisions across all bots (last LOOKBACK_DAYS days)
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  const { rows: decisions } = await query(
    `SELECT bd.*, b.broker, b.id AS bot_id
       FROM bot_decisions bd
       JOIN bots b ON b.id = bd.bot_id
      WHERE bd.bot_id IN (${bots.map((_, i) => `$${i + 2}`).join(',')})
        AND bd.action = 'buy'
        AND bd.scanned_at >= $1
      ORDER BY bd.scanned_at DESC`,
    [cutoff, ...bots.map(b => b.id)]
  );

  // 4. Gather broker positions per unique broker type
  const brokerTypes = [...new Set(bots.map(b => b.broker))];
  const brokerPositions = {};

  for (const broker of brokerTypes) {
    try {
      if (broker === 'tiger_demo') {
        const dbUser = await getDbUser(username);
        if (!dbUser?.tiger_demo_id || !dbUser?.tiger_demo_account || !dbUser?.tiger_demo_private_key) {
          console.warn('[reconciler] tiger_demo creds missing for', username);
          brokerPositions[broker] = [];
          continue;
        }
        const creds = {
          tiger_id:    dbUser.tiger_demo_id,
          account:     dbUser.tiger_demo_account,
          private_key: dbUser.tiger_demo_private_key,
        };
        brokerPositions[broker] = await getTigerPositions(creds);
      } else if (broker === 'alpaca') {
        const dbUser = await getDbUser(username);
        if (dbUser?.alpaca_api_key) {
          const creds = { apiKey: dbUser.alpaca_api_key, secretKey: dbUser.alpaca_secret_key, baseUrl: dbUser.alpaca_base_url };
          brokerPositions[broker] = await getUserPositions(creds);
        } else {
          brokerPositions[broker] = await getPositions();
        }
      } else {
        brokerPositions[broker] = [];
      }
    } catch (e) {
      console.error(`[reconciler] failed to fetch positions for broker ${broker}:`, e.message);
      brokerPositions[broker] = [];
    }
  }

  const matched      = [];
  const unmatched    = [];
  const qty_mismatch = []; // broker qty != DB qty for positions that DO have a DB row
  const processedPositionKeys = new Set(); // dedup: one position must not be reconciled for multiple bots

  // 5. For each bot, compare broker positions against DB open trades
  for (const bot of bots) {
    const rawPositions = brokerPositions[bot.broker] ?? [];

    for (const pos of rawPositions) {
      // Normalise Tiger position shape (symbol may be on contract sub-object)
      const sym = (pos.symbol ?? pos.contract?.symbol ?? '').toUpperCase();
      if (!sym) continue;

      const qty = +(pos.position ?? pos.positionQty ?? pos.quantity ?? pos.qty ?? pos.qty_available ?? 0);
      if (qty <= 0) continue;

      const key = `${sym}::${bot.broker.toLowerCase()}`;

      // Quantity-mismatch detection: DB has this symbol but with a different qty.
      // Uses tolerance (not strict !==) via _compareQty to avoid false alarms on fractional shares.
      if (openTradeKey.has(key)) {
        const { match, dbQty } = _compareQty(openTradeQty.get(key), qty);
        if (!match) {
          qty_mismatch.push({
            symbol:     sym,
            broker:     bot.broker,
            broker_qty: qty,
            // dbQty=null when DB row had qty=NULL/NaN — caller distinguishes via `reason`
            db_qty:     dbQty,
            // delta sign convention: POSITIVE → broker has MORE shares than DB (reconcile UP)
            //                       NEGATIVE → broker has FEWER shares than DB (DB stale, sell-fill missed)
            delta:      dbQty !== null ? (qty - dbQty) : null,
            reason:     dbQty !== null ? 'qty_mismatch' : 'qty_null_in_db',
          });
        }
        continue; // regardless of qty match — row exists, skip reconcile
      }
      if (processedPositionKeys.has(key)) continue;  // already reconciled this run

      // Find most recent buy decision for this symbol on this bot
      const decision = decisions.find(d => d.bot_id === bot.id && (d.symbol || '').toUpperCase() === sym)
        ?? decisions.find(d => (d.symbol || '').toUpperCase() === sym); // any bot for this user

      const avgCost = +(pos.averageCost ?? pos.average_cost ?? pos.avg_entry_price ?? pos.avg_cost ?? 0);

      const entry = {
        bot_id:           bot.id,
        bot_name:         bot.name,
        broker:           bot.broker,
        symbol:           sym,
        qty,
        avg_cost:         avgCost,
        conviction_score: decision ? Number(decision.composite_score ?? 0) : null,
        decision_id:      decision?.id ?? null,
        decision_at:      decision?.scanned_at ?? null,
      };

      if (!dryRun) {
        // Generate a synthetic order_id so ON CONFLICT doesn't silently collide
        const syntheticOrderId = `reconcile_${bot.broker}_${sym}_${Date.now()}`;
        const tradeId = await recordTrade({
          order_id:         syntheticOrderId,
          symbol:           sym,
          side:             'buy',
          qty,
          entry_price:      avgCost || 0,
          stop_loss:        null,
          take_profit:      null,
          dollars_invested: avgCost * qty || null,
          stop_loss_pct:    null,
          take_profit_pct:  null,
          atr_pct:          null,
          conviction_score: entry.conviction_score,
          conviction_grade: null,
          conviction_breakdown: decision?.factor_breakdown ?? null,
          username:         null,
          account_source:   bot.broker,
        });
        if (tradeId) {
          await query('UPDATE trades SET bot_id=$1 WHERE id=$2', [bot.id, tradeId]);
          await query(
            'UPDATE bots SET current_trade_id=$1, updated_at=NOW() WHERE id=$2 AND current_trade_id IS NULL',
            [tradeId, bot.id]
          );
          entry.trade_id = tradeId;
          entry.synthetic_order_id = syntheticOrderId;
          console.log(`[reconciler] inserted trade ${tradeId} for bot ${bot.id} ${sym} x${qty} @ $${avgCost}`);
        } else {
          console.error(`[reconciler] recordTrade returned null for bot ${bot.id} ${sym}`);
        }
      }

      matched.push(entry);
      processedPositionKeys.add(key);
    }
  }

  // 6. Report broker positions that couldn't be matched to any bot
  for (const broker of brokerTypes) {
    for (const pos of (brokerPositions[broker] ?? [])) {
      const sym = (pos.symbol ?? pos.contract?.symbol ?? '').toUpperCase();
      if (!sym) continue;
      const qty = +(pos.position ?? pos.positionQty ?? pos.quantity ?? pos.qty ?? 0);
      if (qty <= 0) continue;
      const alreadyMatched = matched.some(m => m.symbol === sym && m.broker === broker);
      const alreadyInDb    = openTradeKey.has(`${sym}::${broker.toLowerCase()}`);
      if (!alreadyMatched && !alreadyInDb) {
        unmatched.push({ symbol: sym, broker, qty, reason: 'no_matching_bot' });
      }
    }
  }

  // 2026-05-28 (review fix): raise a system alert whenever broker/DB quantities diverge —
  // it means our recordTrade pipeline missed a partial fill or sell. Dedup window 60min so
  // we don't spam the same alert every reconcile run for an unresolved mismatch.
  if (qty_mismatch.length > 0) {
    try {
      await raiseSystemAlert({
        key:      'reconciler_qty_mismatch',
        severity: 'warn',
        title:    `Reconciler found ${qty_mismatch.length} broker/DB quantity mismatch(es)`,
        detail:   { mismatches: qty_mismatch, username, dryRun },
        dedup_window_minutes: 60,
      });
    } catch (e) {
      console.error('[reconciler] system_alert raise failed:', e.message);
    }
  }

  return { matched, unmatched, qty_mismatch, dryRun };
}
