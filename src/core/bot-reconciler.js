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

const LOOKBACK_DAYS = 7;

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

  // 2. Collect open DB trades keyed by symbol+broker so we can detect gaps
  const { rows: openTrades } = await query(
    `SELECT symbol, account_source, order_id, bot_id
       FROM trades
      WHERE status='open' AND bot_id IN (${bots.map((_, i) => `$${i + 1}`).join(',')})`,
    bots.map(b => b.id)
  );
  const openTradeKey = new Set(
    openTrades.map(t => `${(t.symbol || '').toUpperCase()}::${(t.account_source || '').toLowerCase()}`)
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

  const matched   = [];
  const unmatched = [];
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
      if (openTradeKey.has(key)) continue;           // already in DB — no gap
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

  return { matched, unmatched, dryRun };
}
