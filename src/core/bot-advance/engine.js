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
import { checkRegimeGate } from './regime-gate.js';
import { getSiblingBotsActivity } from '../../repositories/bots-repo.js';
import { getBrokerOpenSymbols, bookPhantomRow } from '../drift-detector.js';

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
    // 2026-05-28: multi-position model — scanner ALWAYS scans regardless of how
    // many positions the bot already holds. Position cap is enforced in the
    // executor (max_concurrent_positions). The scanner is a pure "interesting
    // candidates" log; the executor decides what to do with them.
    //
    // If the bot is already at the cap, we still log 'hold' so the dashboard's
    // last_scan timestamp updates (operators can see the bot is alive).
    // 2026-06-03: position cap must reflect BROKER TRUTH, not DB count.
    // The phantom-position bug (bot 4 2026-06-02) had DB=5 open / broker=0,
    // paralyzing the bot. Cross-check broker first; if it has fewer positions
    // than DB, auto-reconcile the phantom rows and use the broker count.
    const { rows: posRow } = await query(
      `SELECT id, symbol, dollars_invested, entry_price, qty FROM bot_advance_trades
        WHERE bot_id=$1 AND status IN ('open','pending')`,
      [bot.id]
    );
    let openCount = posRow.length;
    const maxPositions = Number(bot.rules?.sizing?.max_concurrent_positions) || 5;

    // Cross-check broker (cheap call, ~150ms). Skip if not at cap (no need).
    if (openCount >= maxPositions) {
      const brokerResult = await getBrokerOpenSymbols(bot);
      if (brokerResult.available) {
        const phantomRows = posRow.filter(r => !brokerResult.symbols.has(r.symbol.toUpperCase()));
        if (phantomRows.length > 0) {
          console.warn(`[bot-advance] bot ${bot.id} found ${phantomRows.length} PHANTOM positions vs broker — auto-reconciling`);
          // Book each phantom via the shared helper: filled positions (dollars_invested>0)
          // become real closes with P&L; never-filled orders stay 'failed'. See
          // drift-detector.bookPhantomRow — the 2026-07-07 fix for the DB≠Alpaca P&L gap.
          for (const ph of phantomRows) {
            await bookPhantomRow('bot_advance_trades', ph)
              .catch(e => console.error(`[bot-advance] reconcile ${ph.symbol}:`, e.message));
          }
          await query(`UPDATE bots_advance SET current_trade_id=NULL, updated_at=NOW() WHERE id=$1`, [bot.id]).catch(() => {});
          openCount = posRow.length - phantomRows.length;
          await logDecision({
            botId: bot.id, action: 'phantom_reconciled',
            notes: `auto-reconciled ${phantomRows.length} phantom rows: ${phantomRows.map(p=>p.symbol).join(',')}`,
            shadowMode: bot.shadow_mode,
          });
        }
      }
    }
    if (openCount >= maxPositions) {
      await logDecision({
        botId:      bot.id,
        action:     'hold',
        notes:      `at position cap (${openCount}/${maxPositions}) — not scanning`,
        shadowMode: bot.shadow_mode,
      });
      return { action: 'hold', open: openCount, cap: maxPositions };
    }

    // 2026-06-03 (CLS/ELMT pattern) — DAILY catastrophic-loss circuit breaker.
    // Skip new entries for the rest of the ET session if today's realized loss
    // breaches max_daily_loss_usd. Default $200. Auto-resets next ET trading day.
    const maxDailyLoss = Number(bot.rules?.risk?.max_daily_loss_usd ?? 200);
    if (maxDailyLoss > 0) {
      const { rows: pnlRows } = await query(`
        SELECT COALESCE(SUM(pnl_usd), 0)::numeric AS daily_pnl, COUNT(*) AS n
          FROM bot_advance_trades
         WHERE bot_id = $1
           AND status = 'closed'
           AND (closed_at AT TIME ZONE 'America/New_York')::date
             = (NOW() AT TIME ZONE 'America/New_York')::date
      `, [bot.id]);
      const dailyPnl = Number(pnlRows[0]?.daily_pnl ?? 0);
      if (dailyPnl <= -maxDailyLoss) {
        await logDecision({
          botId:      bot.id,
          action:     'skip_daily_loss_cap',
          notes:      `daily P&L $${dailyPnl.toFixed(2)} ≤ -$${maxDailyLoss} (${pnlRows[0]?.n} closed trades today) — paused until next session`,
          shadowMode: bot.shadow_mode,
        });
        return { action: 'skip_daily_loss_cap', daily_pnl: dailyPnl, cap: maxDailyLoss };
      }
    }

    // 2026-06-14 — MARKET REGIME GATE (promoted from BOT_SIM after the
    // multi-regime replay: not trading while SPY < 200d turned COVID −12%→−5%
    // and the 2022 bear −7%→0%). Blocks NEW entries only; never adds risk.
    // Fails open on data gaps. Per-bot opt-out: rules.risk.regime_gate_enabled=false.
    const gate = await checkRegimeGate(bot);
    if (gate.blocked) {
      await logDecision({
        botId:      bot.id,
        action:     'skip_regime_gate',
        notes:      `risk-off regime — new entries paused. ${gate.detail}`,
        shadowMode: bot.shadow_mode,
      });
      return { action: 'skip_regime_gate', regime: gate.regime, detail: gate.detail };
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

    // 2. Build candidate universe (each rule contributes its own list).
    //    Pass bot-derived context so generators can self-tune. maxPrice here
    //    prevents the ml_v2 rule from ranking $971 stocks at the top for a
    //    $1000-cap bot (fixes the 7× insufficient_capital loop seen 2026-06-01).
    //    Heuristic: need to fit at least 2 shares to be tradeable.
    const _maxPositionUsd = Number(bot.rules?.sizing?.max_position_usd) || 1000;
    const botCtx = {
      capitalUsd: Number(bot.capital_usd) || 10000,
      maxPositionUsd: _maxPositionUsd,
      maxPrice: Math.floor(_maxPositionUsd / 2),   // need to afford ≥ 2 shares
      // Restrict candidates to S&P500/NDX100 (default ON; set rules.universe.index_only=false to disable)
      indexOnly: bot.rules?.universe?.index_only !== false,
      // Liquidity + quality gate — opt-in alternative for mid/small-cap strategies (e.g. insider).
      // Enable with rules.universe.quality_gate=true (usually paired with index_only=false).
      qualityGate:       bot.rules?.universe?.quality_gate === true,
      minPrice:          bot.rules?.universe?.min_price,        // default 5 in applyQualityGate
      minAdvUsd:         bot.rules?.universe?.min_adv_usd,      // default 3,000,000
      excludeIndustries: bot.rules?.universe?.exclude_industries, // default ['Asset Management']
    };
    const { tickers: candidates, breakdown } = await buildAdvanceCandidateUniverse(enabledRules, botCtx);
    if (!candidates.length) {
      await logDecision({
        botId:      bot.id,
        action:     'skip_empty_universe',
        notes:      `no candidates from rules: ${JSON.stringify(breakdown)}`,
        shadowMode: bot.shadow_mode,
      });
      return { action: 'skip_empty_universe', breakdown };
    }

    // ── OBSERVABILITY (2026-05-29) ───────────────────────────────────────────
    // Temporary verification logging — proves whether candidates beyond the first
    // ~N are silently dropped due to DB-pool timeouts in buildContext().
    console.log(`[bot-advance/scan] bot=${bot.id} candidates=${candidates.length} ` +
                `breakdown=${JSON.stringify(breakdown)} first10=[${candidates.slice(0, 10).join(',')}] ` +
                `last10=[${candidates.slice(-10).join(',')}]`);

    // 2b. Cross-bot situational awareness (2026-06-02) — see bot-engine.js for
    //     the full rationale. Bots sharing a broker account act as a fleet:
    //       • Skip symbols any sibling bot currently holds (duplicate position
    //         in the broker = no risk diversification, just stacked exposure)
    //       • Skip symbols any sibling bot closed/failed within cool-down
    //         (the same MU was attempted 7× in 3.5h on 2026-06-01 — exactly
    //         what this prevents)
    //     Default cool-down 4h; configurable via bot.rules.entry_filters.reentry_cooldown_hours.
    const cooldownHours = Number(bot.rules?.entry_filters?.reentry_cooldown_hours ?? 4);
    const sibling = await getSiblingBotsActivity({
      userId:       bot.user_id,
      broker:       bot.broker,
      excludeBotId: bot.id,
      cooldownHours,
    });
    const _blockedHeld = [];
    const _blockedCd   = [];
    const filteredCandidates = candidates.filter(sym => {
      const symU = sym.toUpperCase();
      if (sibling.held.has(symU))     { _blockedHeld.push(symU); return false; }
      if (sibling.cooldown.has(symU)) { _blockedCd.push(symU);   return false; }
      return true;
    });
    if (_blockedHeld.length || _blockedCd.length) {
      console.log(`[bot-advance/scan] bot=${bot.id} cross-bot filter: ` +
        `held=${_blockedHeld.length}${_blockedHeld.length ? `[${_blockedHeld.slice(0,5).join(',')}]` : ''} ` +
        `cooldown=${_blockedCd.length}${_blockedCd.length ? `[${_blockedCd.slice(0,5).join(',')}]` : ''} ` +
        `survived=${filteredCandidates.length}/${candidates.length}`);
    }

    if (!filteredCandidates.length) {
      await logDecision({
        botId:      bot.id,
        action:     'skip_sibling_block',
        notes:      `all ${candidates.length} candidates blocked by sibling-bot fleet: ` +
                    `held=${_blockedHeld.length}, cooldown=${_blockedCd.length} (${cooldownHours}h)`,
        shadowMode: bot.shadow_mode,
      });
      return { action: 'skip_sibling_block', held: _blockedHeld.length, cooldown: _blockedCd.length };
    }

    // 3. For each candidate, build context and run rule cascade
    const matches = [];
    let _built = 0, _failed = 0, _firstFailSym = null;
    const _failedSyms = [];
    // 2026-06-02: iterate the cross-bot-filtered list, not the raw candidates.
    // Saves expensive buildContext() calls on symbols that are already held by a
    // sibling bot or in cool-down — and prevents the duplicate-buy / re-entry bugs.
    for (const sym of filteredCandidates) {
      let ctx;
      try {
        ctx = await buildContext(sym);
        _built++;
      } catch (e) {
        _failed++;
        if (!_firstFailSym) _firstFailSym = `${sym}@idx${_built + _failed - 1}:${e.message?.slice(0, 60)}`;
        if (_failedSyms.length < 20) _failedSyms.push(sym);
        console.warn(`[bot-advance] context build failed for ${sym}: ${e.message}`);
        continue;
      }
      const m = matchEntryRules(ctx, enabledRules);
      if (m) matches.push({ symbol: sym, rule: m.rule, also_matched: m.also_matched, ctx });
    }

    // ── OBSERVABILITY ────────────────────────────────────────────────────────
    console.log(`[bot-advance/scan] bot=${bot.id} processed=${_built}/${filteredCandidates.length} ` +
                `failed=${_failed} matched=${matches.length} ` +
                `winners=${matches.map(m => `${m.symbol}:${m.rule.id}`).join(',') || 'none'}` +
                (_failedSyms.length ? ` failed_syms=[${_failedSyms.join(',')}${_failed > _failedSyms.length ? ',…' : ''}]` : '') +
                (_firstFailSym ? ` firstFail=${_firstFailSym}` : ''));

    if (!matches.length) {
      await logDecision({
        botId:      bot.id,
        action:     'skip_no_match',
        notes:      `${filteredCandidates.length} candidates evaluated (${candidates.length} pre-filter), ${JSON.stringify(breakdown)}`,
        shadowMode: bot.shadow_mode,
      });
      return { action: 'skip_no_match', candidates: candidates.length };
    }

    // 4. MULTI-PICK arbitration (2026-05-29 fix): one winner PER RULE, capped by
    //    available position slots. Previously: single winner per scan, which meant
    //    insider_director_cluster (priority 1) always won and the other 4 rules
    //    (52w, momentum, congress, composite_70) were mathematically unreachable.
    //
    //    New logic:
    //      • Sort matches by rule priority
    //      • For each rule, take the FIRST non-deduped candidate (one pick per rule)
    //      • Stop once we've filled (maxPositions - openCount) available slots
    //      • Skip duplicates: same symbol matched by multiple rules → only first wins
    //      • 15-min cross-process dedup per symbol still applies (executor defense)
    matches.sort((a, b) => a.rule.priority - b.rule.priority);

    const availableSlots = Math.max(0, maxPositions - openCount);
    const picks      = [];
    const seenRules  = new Set();
    const seenSyms   = new Set();

    for (const m of matches) {
      if (picks.length >= availableSlots) break;
      if (seenRules.has(m.rule.id))      continue;
      if (seenSyms.has(m.symbol))         continue;

      const { rows: recent } = await query(`
        SELECT id FROM bot_advance_decisions
         WHERE symbol = $1 AND action = 'would_buy'
           AND scanned_at > NOW() - INTERVAL '15 minutes'
         LIMIT 1
      `, [m.symbol]);
      if (recent.length > 0) continue;   // 15-min cross-process dedup

      picks.push(m);
      seenRules.add(m.rule.id);
      seenSyms.add(m.symbol);
    }

    console.log(`[bot-advance/scan] bot=${bot.id} availableSlots=${availableSlots} ` +
                `picks=${picks.length} rules=[${picks.map(p => p.rule.id).join(',')}] ` +
                `syms=[${picks.map(p => p.symbol).join(',')}]`);

    if (!picks.length) {
      const reason = availableSlots === 0
        ? 'no slots (at position cap, will hold)'
        : `${matches.length} match(es) but all already decided recently`;
      await logDecision({
        botId:      bot.id,
        action:     'skip_dedup',
        notes:      reason,
        shadowMode: bot.shadow_mode,
      });
      return { action: 'skip_dedup', matches: matches.length, availableSlots };
    }

    // 5. Log one WOULD-BUY decision PER PICK
    const decisions = [];
    for (const pick of picks) {
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
      decisions.push({ symbol: pick.symbol, entry_rule: pick.rule.id, decision_id: decisionId });
    }

    // 6. Fire ONE consolidated Telegram alert per scan (not one per pick — avoids spam
    //    when bot picks 4-5 candidates simultaneously)
    const tag = bot.shadow_mode ? `${ADVANCE_PREFIX} SHADOW` : `${ADVANCE_PREFIX} LIVE`;
    const picksLines = picks.map(p =>
      `• <b>${p.symbol}</b> via <code>${p.rule.id}</code> @ $${p.ctx?.indicators?.liquidity?.last_price?.toFixed?.(2) ?? '—'} ` +
      `(comp=${p.ctx?.composite?.toFixed?.(1) ?? '—'}, ${(p.rule.backtest_evidence.win_rate * 100).toFixed(0)}% win / +${(p.rule.backtest_evidence.avg_return_5d * 100).toFixed(1)}%/5d)`
    ).join('\n');
    sendTelegram(
      `${tag} <b>${picks.length} would_buy pick(s)</b>\n` +
      `Bot ${bot.id} ${bot.name} • slots=${picks.length}/${availableSlots}\n` +
      picksLines
    ).catch(() => {});

    return {
      action:      'would_buy',
      pick_count:  picks.length,
      picks:       decisions,
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
  // Fix A-6 (2026-05-29): mirror the same market-hours guard added to the regular bot.
  // Cron fires at 15:50 and 15:55 ET (after market close at 15:30) — skip those ticks
  // so we don't generate stale would_buy decisions the executor would then try to fill.
  try {
    const et      = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day     = et.getDay();
    const minsET  = et.getHours() * 60 + et.getMinutes();
    if (day === 0 || day === 6 || minsET >= 15 * 60 + 29) {
      return { skipped: true, reason: 'outside_trading_window' };
    }
  } catch { /* ignore clock failures — let scan proceed */ }
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
