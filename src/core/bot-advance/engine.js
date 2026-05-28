/**
 * src/core/bot-advance/engine.js — bot-advance scanner.
 *
 * Distinct from src/core/bot-engine.js. Zero shared mutable state.
 *
 * Scan flow per bot:
 *   1. Skip if holding a position (one trade at a time)
 *   2. Build candidate universe = union of all enabled rules' candidate_generator() outputs
 *   3. For each candidate: build context, run rule cascade, collect matches
 *   4. Pick best match (first by priority order)
 *   5. Log decision to bot_advance_decisions
 *   6. Executor cron picks up "would_buy" decisions and (in live mode) places orders
 */

import cron from 'node-cron';
import { query, isDbAvailable } from '../db.js';
import { sendTelegram } from '../telegram.js';
import {
  buildAdvanceCandidateUniverse,
  matchEntryRules,
  getRule,
} from './entry-rules.js';
import { buildContext } from './context.js';

const ADVANCE_PREFIX = '🧪';   // marks all bot-advance telegrams so they're distinguishable
const _runningBots = new Set();

// ─── Utility: get active advance bots ────────────────────────────────────────
async function getActiveAdvanceBots() {
  const { rows } = await query(`
    SELECT id, name, user_id, broker, status, shadow_mode,
           capital_usd, cumulative_pnl_usd, current_trade_id,
           rules, enabled_rules
      FROM bots_advance
     WHERE status = 'active' AND deleted_at IS NULL
  `);
  return rows;
}

// ─── Decision logger ─────────────────────────────────────────────────────────
async function logDecision({
  botId, action, symbol = null, entryRule = null,
  composite = null, ruleMetadata = null, alsoMatched = null,
  signals = null, notes = null, shadowMode = true,
}) {
  try {
    const { rows } = await query(`
      INSERT INTO bot_advance_decisions
        (bot_id, action, symbol, entry_rule, composite_score, rule_metadata,
         also_matched, signals, notes, shadow_mode)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
      RETURNING id
    `, [
      botId, action, symbol, entryRule, composite,
      ruleMetadata ? JSON.stringify(ruleMetadata) : null,
      alsoMatched  ? JSON.stringify(alsoMatched)  : null,
      signals      ? JSON.stringify(signals)      : null,
      notes, shadowMode,
    ]);
    return rows[0]?.id ?? null;
  } catch (e) {
    console.warn(`[bot-advance] log failed: ${e.message}`);
    return null;
  }
}

// ─── Scan one bot ────────────────────────────────────────────────────────────
export async function scanBotAdvance(bot) {
  if (_runningBots.has(bot.id)) return { skipped: true, reason: 'inflight' };
  _runningBots.add(bot.id);

  try {
    // 1. If holding a position, log 'hold' and return
    if (bot.current_trade_id) {
      await logDecision({
        botId:      bot.id,
        action:     'hold',
        notes:      `holding trade #${bot.current_trade_id}`,
        shadowMode: bot.shadow_mode,
      });
      return { action: 'hold' };
    }

    const enabledRules = Array.isArray(bot.enabled_rules) ? bot.enabled_rules : [];
    if (!enabledRules.length) {
      await logDecision({
        botId:      bot.id,
        action:     'skip_no_rules',
        notes:      'enabled_rules is empty',
        shadowMode: bot.shadow_mode,
      });
      return { action: 'skip_no_rules' };
    }

    // 2. Build candidate universe (each rule contributes its own list)
    const { tickers: candidates, breakdown } = await buildAdvanceCandidateUniverse(enabledRules);
    if (!candidates.length) {
      await logDecision({
        botId:      bot.id,
        action:     'skip_empty_universe',
        notes:      `no candidates from rules: ${JSON.stringify(breakdown)}`,
        shadowMode: bot.shadow_mode,
      });
      return { action: 'skip_empty_universe', breakdown };
    }

    // 3. For each candidate, build context and run rule cascade
    const matches = [];
    for (const sym of candidates) {
      let ctx;
      try { ctx = await buildContext(sym); }
      catch (e) {
        console.warn(`[bot-advance] context build failed for ${sym}: ${e.message}`);
        continue;
      }
      const m = matchEntryRules(ctx, enabledRules);
      if (m) matches.push({ symbol: sym, rule: m.rule, also_matched: m.also_matched, ctx });
    }

    if (!matches.length) {
      await logDecision({
        botId:      bot.id,
        action:     'skip_no_match',
        notes:      `${candidates.length} candidates evaluated, ${JSON.stringify(breakdown)}`,
        shadowMode: bot.shadow_mode,
      });
      return { action: 'skip_no_match', candidates: candidates.length };
    }

    // 4. Cross-process dedup — has any decision in last 15 min already fired on this symbol?
    //    (Defense-in-depth — won't fire twice if the cron ever doubles up.)
    matches.sort((a, b) => a.rule.priority - b.rule.priority);
    let pick = null;
    for (const m of matches) {
      const { rows: recent } = await query(`
        SELECT id FROM bot_advance_decisions
         WHERE symbol = $1 AND action = 'would_buy'
           AND scanned_at > NOW() - INTERVAL '15 minutes'
         LIMIT 1
      `, [m.symbol]);
      if (recent.length === 0) { pick = m; break; }
    }
    if (!pick) {
      // All top matches are duplicates of recent decisions — skip
      await logDecision({
        botId:      bot.id,
        action:     'skip_dedup',
        notes:      `${matches.length} match(es) but all already decided recently`,
        shadowMode: bot.shadow_mode,
      });
      return { action: 'skip_dedup' };
    }

    // 5. Log the WOULD-BUY decision
    const decisionId = await logDecision({
      botId:       bot.id,
      action:      'would_buy',
      symbol:      pick.symbol,
      entryRule:   pick.rule.id,
      composite:   pick.ctx?.composite ?? null,
      ruleMetadata: {
        priority:                 pick.rule.priority,
        position_size_multiplier: pick.rule.position_size_multiplier,
        exits:                    pick.rule.exits,
        backtest_evidence:        pick.rule.backtest_evidence,
      },
      alsoMatched: pick.also_matched,
      signals:     pick.ctx?.signals ?? null,
      notes: `rule=${pick.rule.id} composite=${pick.ctx?.composite?.toFixed?.(1) ?? 'n/a'} ` +
             `also_matched=[${pick.also_matched.join(',')}] price=$${pick.ctx?.indicators?.liquidity?.last_price ?? 'n/a'}`,
      shadowMode: bot.shadow_mode,
    });

    // 6. Fire a Telegram alert (always — shadow or live)
    const tag = bot.shadow_mode ? `${ADVANCE_PREFIX} SHADOW` : `${ADVANCE_PREFIX} LIVE`;
    sendTelegram(
      `${tag} <b>would_buy</b> ${pick.symbol}\n` +
      `Bot ${bot.id} ${bot.name} • rule=<code>${pick.rule.id}</code>\n` +
      `Price: $${pick.ctx?.indicators?.liquidity?.last_price?.toFixed?.(2) ?? '—'} • ` +
      `composite=${pick.ctx?.composite?.toFixed?.(1) ?? '—'}\n` +
      `Backtest: ${(pick.rule.backtest_evidence.win_rate * 100).toFixed(0)}% win / +${(pick.rule.backtest_evidence.avg_return_5d * 100).toFixed(1)}%/5d (N=${pick.rule.backtest_evidence.sample_size})`
    ).catch(() => {});

    return {
      action:      'would_buy',
      symbol:      pick.symbol,
      entry_rule:  pick.rule.id,
      decision_id: decisionId,
      shadow_mode: bot.shadow_mode,
    };
  } catch (e) {
    console.error(`[bot-advance] scanBotAdvance(${bot.id}) error:`, e);
    await logDecision({
      botId:      bot.id,
      action:     'error',
      notes:      e.message?.slice(0, 200),
      shadowMode: bot.shadow_mode,
    });
    return { action: 'error', error: e.message };
  } finally {
    _runningBots.delete(bot.id);
  }
}

// ─── Public: run scan for all active advance bots ────────────────────────────
export async function runAdvanceScanForAllActive() {
  if (!isDbAvailable()) return { skipped: true, reason: 'no_db' };
  try {
    const bots = await getActiveAdvanceBots();
    const out = [];
    for (const bot of bots) {
      try {
        const r = await scanBotAdvance(bot);
        out.push({ bot_id: bot.id, ...r });
      } catch (e) {
        console.error(`[bot-advance] bot ${bot.id} error:`, e.message);
        out.push({ bot_id: bot.id, action: 'error', error: e.message });
      }
    }
    return { processed: out.length, out };
  } catch (e) {
    console.error('[bot-advance] fatal:', e.message);
    return { error: e.message };
  }
}

// ─── Cron registration ───────────────────────────────────────────────────────
export function startBotAdvanceCrons() {
  // Same env-var gate as the existing bot — only run on the cron-owner process.
  if (process.env.BOT_CRON_OWNER !== 'true') {
    console.log('[bot-advance] crons NOT scheduled (BOT_CRON_OWNER != true)');
    return;
  }
  const TZ = { timezone: 'America/New_York' };
  // Same cadence as the existing scanner so they're easy to compare
  cron.schedule('30/5 9 * * 1-5', () => runAdvanceScanForAllActive(), TZ);
  cron.schedule('*/5 10-15 * * 1-5', () => runAdvanceScanForAllActive(), TZ);
  console.log('[bot-advance] crons scheduled — scanning every 5 min during market hours');
}
