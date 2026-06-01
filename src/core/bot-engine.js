/**
 * Bot Scanner Engine — Phase B-2
 *
 * Reads 11+ signals per candidate, computes empirical composite score,
 * applies hard gates, deduplicates against the user's other bots' open
 * trades, and logs the decision to bot_decisions.
 *
 * IMPORTANT: This module does NOT place trades. All 'buy' decisions are
 * logged only. Phase B-3 reads the decision log and executes.
 */

import cron from 'node-cron';
import { query, isDbAvailable } from './db.js';
import { getUwConvictionForSymbol } from './uw-conviction.js';
import { getNewsSentimentForSymbol } from './news-sentiment-modifier.js';
import { getAllBotIndicators } from './bot-indicators.js';
import { classifySetup, computeLast5dReturn, computeRsi14, getFundamentalsGrowth } from './bot-setup-classifier.js';
import { getConvictionScore } from './scoring.js';
import {
  PRE_SIGNAL_GATES, POST_SIGNAL_GATES, SETUP_GATES,
  firstBlocker, allBlockers, gateCompositeScore,
} from './bot-gates.js';
import { getScannableBots, getOtherBotsHeldSymbols, tripCircuitBreaker, unlinkTrade } from '../repositories/bots-repo.js';
import { recordDecision } from '../repositories/bot-decisions-repo.js';

// ─── Single-flight guard per bot ──────────────────────────────────────────────
const _runningBots = new Set();

// ─── Public entrypoints ───────────────────────────────────────────────────────

export async function runBotScanForAllActive() {
  if (!isDbAvailable()) return { skipped: true, reason: 'no_db' };

  // Bug fix 2026-05-29 (audit G-2): scanner cron runs until 15:55 ET but
  // gateMarketCloseProximity blocks ALL entries after 15:30. Every scan from
  // 15:30–15:55 evaluates 50+ candidates through expensive Yahoo + DB calls only
  // to hit the close-proximity gate for every single one. Skip the whole scan
  // at the top level — cheaper and produces a clean skip log instead of a
  // gate_histogram showing market_close_proximity×49.
  try {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay();
    const minsET = et.getHours() * 60 + et.getMinutes();
    // Weekends: no market. After 15:29 ET (30 min before close cutoff): skip.
    if (day === 0 || day === 6 || minsET >= 15 * 60 + 29) {
      return { skipped: true, reason: 'outside_trading_window' };
    }
  } catch { /* ignore clock failures — let scan proceed */ }

  try {
    const bots = await getScannableBots();
    const results = [];
    for (const bot of bots) {
      if (bot.status === 'paused_today') continue;
      try {
        const r = await scanBot(bot);
        results.push({ bot_id: bot.id, action: r.action });
      } catch (e) {
        console.error(`[bot-engine] bot ${bot.id} scan failed:`, e);
      }
    }
    console.log(`[bot-engine] scanned ${results.length} active bots`);
    return { scanned: results.length, results };
  } catch (e) {
    console.error('[bot-engine] runBotScanForAllActive fatal:', e);
    return { error: e.message };
  }
}

export async function scanBot(bot) {
  if (_runningBots.has(bot.id)) {
    return { action: 'skip_inflight', symbol: null, notes: 'previous scan still in progress' };
  }
  _runningBots.add(bot.id);
  try {
    const rules = bot.rules || {};

    // Bot already holding a trade — exits are managed by B-3.
    // Phase 2.9 (2026-05-27): self-heal stale pointers. If current_trade_id
    // points at a row whose status is no longer 'open' (e.g. closed via a path
    // that bypassed recordTradeClose — manual dashboard sell, sentinel auto-exit,
    // broker-side reconciliation), clear the pointer instead of dead-locking the
    // bot. Bot 25 sat idle for 75+ min tonight on a stale pointer to closed
    // trade #74 and missed buying MU at composite 84.77.
    if (bot.current_trade_id) {
      const { rows: tr } = await query(
        `SELECT status FROM trades WHERE id = $1`,
        [bot.current_trade_id]
      );
      const stillOpen = tr[0]?.status === 'open';
      if (stillOpen) {
        return await _log(bot.id, 'hold', null, null, null,
          `bot is holding trade #${bot.current_trade_id} — exits managed by B-3`);
      }
      console.warn(`[bot-engine] bot ${bot.id}: clearing stale current_trade_id=${bot.current_trade_id} (trade status=${tr[0]?.status ?? 'missing'})`);
      await unlinkTrade(bot.id).catch(e => console.warn(`[bot-engine] unlinkTrade failed: ${e.message}`));
      bot.current_trade_id = null;
      // fall through to normal scan
    }

    // Circuit breaker
    const maxLoss = rules.risk?.max_loss_usd ?? 100;
    if (bot.cumulative_pnl_usd != null && Number(bot.cumulative_pnl_usd) <= -maxLoss) {
      if (bot.status !== 'stopped') {
        await tripCircuitBreaker(bot.id, `Cumulative loss reached max_loss_usd ($${maxLoss})`);
      }
      return await _log(bot.id, 'skip_circuit_breaker', null, null, null,
        `cumulative loss ${bot.cumulative_pnl_usd} ≤ -${maxLoss}`);
    }

    // 1. Candidate universe
    const universe = await _buildCandidateUniverse(bot);
    if (!universe.length) {
      return await _log(bot.id, 'skip_no_candidate', null, null, null, 'empty universe');
    }

    // 2. Deconflict against this user's other bots' open positions
    const heldSymbols = await _getHeldSymbolsForUser(bot.user_id, bot.id);
    const filtered = universe.filter(sym => !heldSymbols.has(sym));
    if (!filtered.length) {
      return await _log(bot.id, 'skip_no_candidate', null, null, null,
        `all ${universe.length} candidates already held by other bots`);
    }

    // 3. Score each candidate (cap at 50 per scan)
    // 2026-05-27: collect per-candidate blocker info so the scan log carries a
    // gate histogram + named-symbol detail. Replaces the useless "none passed
    // hard gates" message with: { gate_histogram: { uw_label: 32, conviction_grade: 5 }, sample_blocked: [{symbol, gate, value, threshold}, ...] }
    const candidates = filtered.slice(0, 50);

    // Phase 2.5 (2026-05-27): pre-warm conviction_scores for any candidate that
    // doesn't have a recent row. Without this, `_signalConviction` returned
    // value=0 for ~72 of yesterday's 90 quality movers (LRCX, TXN, KLAC, ADI,
    // SCCO, NXPI, STM, TER, WDC, AMAT, ...) because nothing had ever triggered
    // a score for them. Their composite was silently dragged down by ~10%
    // weight × 0 = real points missed. Pre-warm in parallel batches of 10 to
    // avoid Yahoo rate-limit storms; 60-min freshness window during market hours.
    // Treat rows lacking macd_hist as STALE — the tradingview-bridge fix
    // (Phase 2.7, 2026-05-27 22:00 SGT) means rows written before that time
    // have macd_hist=null, which silently disables momentum_flip. Force a
    // re-score so technicals get populated and the override path works.
    try {
      const { rows: fresh } = await query(
        `SELECT DISTINCT symbol FROM conviction_scores
         WHERE symbol = ANY($1::text[])
           AND scored_at > NOW() - INTERVAL '60 minutes'
           AND jsonb_typeof(signals->'macd_hist') = 'number'`,
        [candidates]
      );
      const haveFresh = new Set(fresh.map(r => r.symbol));
      const missing = candidates.filter(s => !haveFresh.has(s));
      if (missing.length > 0) {
        console.log(`[bot-engine] bot ${bot.id}: pre-warming conviction for ${missing.length}/${candidates.length} candidates (no row <60min)`);
        const CONCURRENCY = 10;
        for (let i = 0; i < missing.length; i += CONCURRENCY) {
          const batch = missing.slice(i, i + CONCURRENCY);
          await Promise.allSettled(batch.map(sym =>
            getConvictionScore({ symbol: sym }).catch(err => {
              console.warn(`[bot-engine] pre-warm conviction failed for ${sym}:`, err.message);
              return null;
            })
          ));
        }
      }
    } catch (e) {
      console.warn(`[bot-engine] bot ${bot.id} pre-warm step failed (continuing without):`, e.message);
    }

    const scored = [];
    const blocked = [];
    for (const symbol of candidates) {
      try {
        const result = await _scoreCandidate(symbol, bot);
        if (result?._blocked) blocked.push(result);
        else if (result) scored.push(result);
      } catch (e) {
        console.warn(`[bot-engine] bot ${bot.id} candidate ${symbol} score failed:`, e.message);
        blocked.push({ symbol, gate: 'exception', value: e.message?.slice(0, 80), threshold: 'no-throw' });
      }
    }

    if (!scored.length) {
      // Build a gate histogram so we know exactly what's killing trades this scan
      const gateHistogram = blocked.reduce((acc, b) => { acc[b.gate] = (acc[b.gate] || 0) + 1; return acc; }, {});
      const sample = blocked.slice(0, 5).map(b => ({ symbol: b.symbol, gate: b.gate, value: b.value, threshold: b.threshold }));
      const breakdown = { gate_histogram: gateHistogram, sample_blocked: sample, candidates_evaluated: filtered.slice(0, 50).length };
      // Notes string keeps a human-readable summary of the top blockers (e.g. "uw_label×32, conviction_grade×5")
      const topGates = Object.entries(gateHistogram).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([g, n]) => `${g}×${n}`).join(', ');
      return await _log(bot.id, filtered.length > 0 ? 'skip_unclassifiable_setup' : 'skip_filtered', null, null, breakdown,
        `${filtered.length} candidates evaluated, all blocked. Top gates: ${topGates || '(none recorded)'}`);
    }

    // 4. Pick top scorer
    scored.sort((a, b) => b.composite - a.composite);
    const top = scored[0];
    // Raised 2026-05-27 from 60 → 70 based on 90-day backtest:
    //   score 70-79 = 70% win rate at 10d, +9.98% avg return
    //   score 40-49 = 46.6% win rate (worse than coin flip), +2.14% avg
    // Threshold 60 still includes 60-69 (62.5% win, +6.86%) which is acceptable
    // but 70 is the sharp cliff above which alpha really lives. See conviction_scores
    // backtest in chat transcript 2026-05-27 for the full table.
    //
    // Phase 2.1 Option C (also 2026-05-27): allow composite 60-69 through IF
    // _scoreCandidate flagged it as a momentum_flip override (drift_5d>0 + macd_hist>-3,
    // within per-bot daily cap of 5). +6.86%/65.5% backtest win rate in flat regimes.
    const minScore = rules.entry_filters?.min_composite_score ?? 70;
    if (top.composite < minScore && !top._momentum_flip) {
      return await _log(bot.id, 'skip_no_candidate', top.symbol, top.composite, top.breakdown,
        `top score ${top.composite.toFixed(1)} below threshold ${minScore}`);
    }

    // 5. Cross-process dedup guard (2026-05-28 fix: trading-bot + trading-dashboard both run
    //    startBotEngineCrons, causing duplicate scans → duplicate trades on the same symbol).
    //    PRIMARY fix is gating cron registration on BOT_CRON_OWNER env var (see startBotEngineCrons).
    //    This DB check is belt-and-suspenders: if a deploy ever forgets to set the env var,
    //    we still cap dupes at "one decision per symbol per 15 min" instead of two.
    //    Note: still TOCTOU-racey under simultaneous SELECT — the env-var gate is the real fix.
    try {
      const { rows: recentDecision } = await query(
        `SELECT id FROM bot_decisions
         WHERE symbol = $1 AND action = 'buy'
           AND scanned_at > NOW() - INTERVAL '15 minutes'
         LIMIT 1`,
        [top.symbol]
      );
      if (recentDecision.length > 0) {
        return await _log(bot.id, 'skip_no_candidate', top.symbol, top.composite, top.breakdown,
          `cross-process dedup: ${top.symbol} already decided by another bot/process in last 15min`,
          top.setup_type ?? null, top.thesis ?? null);   // pass setup metadata so telemetry stays clean
      }
    } catch (e) {
      console.warn(`[bot-engine] bot ${bot.id}: dedup check failed (proceeding):`, e.message);
    }

    // 6. Log WOULD-TRADE decision — no actual trade placed
    return await _log(bot.id, 'buy', top.symbol, top.composite, top.breakdown,
      `WOULD BUY ${top.symbol} @ composite ${top.composite.toFixed(1)} setup=${top.setup_type} (B-3 will execute)`,
      top.setup_type ?? null, top.thesis ?? null);

  } catch (e) {
    console.error(`[bot-engine] scanBot(${bot.id}) error:`, e);
    return await _log(bot.id, 'skip_filtered', null, null, null, `scan error: ${e.message}`);
  } finally {
    _runningBots.delete(bot.id);
  }
}

// ─── Candidate universe ───────────────────────────────────────────────────────

async function _buildCandidateUniverse(bot) {
  const universe = new Map();
  const bump = (sym, w, src) => {
    const s = String(sym || '').toUpperCase();
    if (!s) return;
    universe.set(s, (universe.get(s) || 0) + w);
    // Track which sources contributed (visible in scan logs for debugging)
    if (src) _sourceContrib.set(s, [...(_sourceContrib.get(s) || []), src]);
  };
  const _sourceContrib = new Map();

  // ── Source 1a: UW flow alerts by SINGLE-ALERT premium (mega-cap whales) ──
  // Captures the SPY/QQQ/NVDA-tier giant alerts. Expanded LIMIT from 50 → 150
  // because the previous cap was filtering out 93% of UW activity (731 tickers
  // were active in a typical 5-day window; only 50 reached the bot).
  try {
    const { rows: flow } = await query(
      `SELECT ticker, premium FROM uw_flow_alerts
       WHERE alerted_at > NOW() - INTERVAL '6 hours' AND premium >= 100000
       ORDER BY premium DESC LIMIT 150`
    );
    flow.forEach(r => bump(r.ticker, 10 + Math.min(5, Math.log10(Number(r.premium) || 1) - 5), 'uw_flow_abs'));
  } catch (e) { console.warn('[bot-engine] uw_flow abs query failed:', e.message); }

  // ── Source 1b: UW BULLISH-ONLY aggregated premium ────────────────────────
  // CRDO case study: had $2.7M bullish premium across 7 alerts on May 22 but
  // ranked #85 in absolute volume, well outside the LIMIT 50. This source
  // groups by ticker and sums BULLISH premium only — surfaces mid-caps with
  // unusual aggregate bullish flow that single-alert ranking missed.
  try {
    const { rows: bullish } = await query(
      `SELECT ticker, SUM(premium)::numeric AS bull_premium
       FROM uw_flow_alerts
       WHERE alerted_at > NOW() - INTERVAL '6 hours'
         AND sentiment IN ('bullish', 'strong_bullish')
         AND premium >= 50000
       GROUP BY ticker
       HAVING SUM(premium) >= 200000
       ORDER BY bull_premium DESC
       LIMIT 100`
    );
    bullish.forEach(r => bump(r.ticker, 11 + Math.min(4, Math.log10(Number(r.bull_premium) || 1) - 5), 'uw_flow_bullish'));
  } catch (e) { console.warn('[bot-engine] uw_flow bullish query failed:', e.message); }

  // ── Source 2: Benzinga positive news catalysts ───────────────────────────
  try {
    const { rows: news } = await query(
      `SELECT t.ticker, COUNT(*)::int AS n
       FROM benzinga_news bn, jsonb_array_elements_text(bn.tickers) AS t(ticker)
       WHERE bn.published_at > NOW() - INTERVAL '1 hour' AND bn.sentiment = 'positive'
       GROUP BY t.ticker HAVING COUNT(*) >= 3 LIMIT 50`
    );
    news.forEach(r => bump(r.ticker, 8 + Math.min(4, r.n - 3), 'news'));
  } catch (e) { console.warn('[bot-engine] news query failed:', e.message); }

  // ── Source 3: UW top movers ──────────────────────────────────────────────
  try {
    const { rows: movers } = await query(
      `SELECT DISTINCT ticker FROM uw_top_movers
       WHERE captured_at > NOW() - INTERVAL '1 hour' LIMIT 100`
    );
    movers.forEach(r => bump(r.ticker, 5, 'movers'));
  } catch (e) { console.warn('[bot-engine] movers query failed:', e.message); }

  // ── Source 4: Filtered tradable universe — large-cap liquid baseline ─────
  const filters      = bot.rules?.entry_filters ?? {};
  const minMktCapB   = filters.market_cap_min_b  ?? 5;
  const minAdvDollar = filters.min_adv_dollar_vol ?? 5_000_000;
  const minPrice     = filters.price_min ?? 5;
  const maxPrice     = filters.price_max ?? 2500;  // raised 2026-05-27 (500→1500→2500) — KLAC trades above $2000, fractionable lets us size in dollars not shares
  try {
    // Two NULL-tolerant escape hatches around weak sync data:
    //
    //   (a) ADV-NULL safety net: ~67% of tradable_universe rows have NULL
    //       adv_dollar_30d (sync is incomplete). `NULL >= $2` is false in SQL,
    //       so the OLD query silently dropped MU/AMD/MRVL/NVDA/KLAC/AMAT/AVGO/LRCX
    //       even though they're $100B+ mega-caps. Fix: trust mktcap ≥ $10B as
    //       a liquidity proxy when ADV is missing.
    //
    //   (b) mktcap-NULL escape for ETFs: SOXX, SMH, XLK, QQQ etc. have NULL
    //       market_cap_usd (they're funds, not companies), so the mktcap ≥ $5B
    //       gate kills them. Fix: allow NULL mktcap when ADV ≥ $1B/day, which
    //       only the actually-huge ETFs clear.
    //
    // Diagnosed 2026-05-27 after MU +20% / SOXL +18% / semis ripped and the bot
    // saw nothing. Of 734 stocks that moved ≥5% on 05-26, 491 were killed by
    // path (a) alone. Sector ETFs were a separate silent rejection via path (b).
    const { rows: base } = await query(
      `SELECT symbol FROM tradable_universe
       WHERE (market_cap_usd >= $1 OR (market_cap_usd IS NULL AND adv_dollar_30d >= 1e9))
         AND (adv_dollar_30d >= $2 OR (adv_dollar_30d IS NULL AND market_cap_usd >= 1e10))
         AND last_price BETWEEN $3 AND $4
         AND fractionable = TRUE
       ORDER BY COALESCE(adv_dollar_30d, 0) DESC, COALESCE(market_cap_usd, 0) DESC
       LIMIT 800`,
      [minMktCapB * 1_000_000_000, minAdvDollar, minPrice, maxPrice]
    );
    base.forEach(r => bump(r.symbol, 1, 'baseline'));
  } catch (e) { console.warn('[bot-engine] tradable_universe query failed:', e.message); }

  // ── Source 5: User's watchlist — always include, high priority ──────────
  // Catches names the user is actively interested in, even if no UW or news
  // signal currently exists. Falls back gracefully if user_id can't be mapped
  // to a username or the watchlist is empty.
  try {
    if (bot.user_id != null) {
      const { rows: wl } = await query(
        `SELECT w.symbol
         FROM user_watchlist w
         JOIN users u ON u.username = w.username
         WHERE u.id = $1`,
        [bot.user_id]
      );
      wl.forEach(r => bump(r.symbol, 7, 'watchlist'));
    }
  } catch (e) { console.warn('[bot-engine] watchlist query failed:', e.message); }

  // Sort by priority desc, cap at 250 (up from 200 — accommodates the new sources)
  const ranked = [...universe.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 250)
    .map(([sym]) => sym);

  console.log(`[bot-engine] universe built: ${ranked.length} candidates (top 5: ${ranked.slice(0, 5).join(', ')})`);
  return ranked;
}

async function _getHeldSymbolsForUser(userId, excludeBotId) {
  const symbols = await getOtherBotsHeldSymbols(userId, excludeBotId);
  return new Set(symbols.filter(s => s).map(s => s.toUpperCase()));
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
//
// Each signal returns a value in [-100, +100].
// Composite = Σ(weight_i × signal_i.value), also in [-100, +100].
// BOT_DEFAULT_RULES weights sum to 1.0; min_composite_score default 60.

async function _scoreCandidate(symbol, bot) {
  const rules   = bot.rules   || {};
  const filters = rules.entry_filters || {};

  // ── Pre-signal hard gates (cheap data only) ───────────────────────────────
  const ind = await getAllBotIndicators(symbol).catch(() => null);
  const vix = await _getCurrentVix();
  const preCtx = { filters, indicators: ind, vix };
  // 2026-05-27: surface which gate blocked so the caller can build a histogram
  // ("why didn't bot buy X" used to be impossible to answer per-candidate).
  const preBlocker = firstBlocker(preCtx, PRE_SIGNAL_GATES);
  if (preBlocker) return { _blocked: true, symbol, gate: preBlocker.gate, value: preBlocker.value, threshold: preBlocker.threshold, message: preBlocker.message };

  // ── Signal computation ──────────────────────────────────────────────────
  const [convSig, newsSig, uwSig, gexSig, insiderSig, dist52wSig, predSig, congressSig, rsSig] = await Promise.all([
    _signalConviction(symbol),
    _signalNews(symbol),
    _signalUw(symbol),
    _signalGex(symbol),
    _signalInsider(symbol),
    _signalDistance52w(symbol),
    _signalPredictor(symbol),
    _signalCongress(symbol),
    _signalRelativeStrength(symbol),  // M4 — observational, weight=0 until backtested
  ]);
  const signals = {
    conviction:           convSig,
    news:                 newsSig,
    uw_options:           uwSig,
    gex:                  gexSig,
    insider:              insiderSig,
    distance_52w:         dist52wSig,
    predictor:            predSig,
    congress:             congressSig,
    relative_strength:    rsSig,      // weight 0 — logged in factor_breakdown only
  };

  // ── Post-signal gates (need conviction/UW/news to be computed) ───────────
  const postBlocker = firstBlocker({ ...preCtx, signals }, POST_SIGNAL_GATES);
  if (postBlocker) return { _blocked: true, symbol, gate: postBlocker.gate, value: postBlocker.value, threshold: postBlocker.threshold, message: postBlocker.message };

  // ── Composite score (renormalized over signals with data) ──────────────
  // OLD bug: signals returning value=0 (no_data) diluted the composite. A
  // stock with one STRONG signal (e.g. +80 UW) and 6 no_data signals scored
  //   composite = 0.30 * 80 + 0.70 * 0 = 24
  // — below any reasonable threshold. We now exclude no-data signals from
  // the denominator: same stock above scores
  //   composite = (0.30 * 80) / 0.30 = 80
  // so a single strong signal still counts. Signals that EXPLICITLY return
  // a non-zero value (positive or negative) participate; those returning 0
  // are treated as "no data" and don't dilute.
  // Phase 4.2 (2026-05-28): congress signal added. Only participates when
  // there are recent congressional buys (value=0 otherwise → excluded).
  const w = rules.composite_weights || {};
  // Bug fix 2026-05-29 (audit B-3): relative_strength was missing from pairs[].
  // With weight=0.00 this had no visible effect today, but the M4 promotion plan
  // (bump weight to 0.05 by updating DB rows) would have silently done nothing
  // because the signal was never read in the weighted sum. Added here so the
  // weight change is sufficient to activate RS scoring — no code change needed later.
  const pairs = [
    ['conviction',        signals.conviction.value],
    ['news',              signals.news.value],
    ['uw_options',        signals.uw_options.value],
    ['gex',               signals.gex.value],
    ['insider',           signals.insider.value],
    ['distance_52w',      signals.distance_52w.value],
    ['predictor',         signals.predictor.value],
    ['congress',          signals.congress.value],
    ['relative_strength', signals.relative_strength.value],  // M4 — weight=0 until backtest gate passes
  ];
  let weightedSum = 0, weightTotal = 0;
  for (const [key, val] of pairs) {
    const weight = w[key] ?? 0;
    if (weight <= 0) continue;
    if (val == null || val === 0) continue;      // no-data signal — skip
    weightedSum += weight * val;
    weightTotal += weight;
  }
  const composite = weightTotal > 0 ? (weightedSum / weightTotal) : 0;

  // Note: _scoreCandidate does NOT enforce min_composite_score itself — the
  // selector layer applies that. We keep the composite in the return value so
  // the selector + decision-log row can see it. Same behavior as before.

  // Suggested position size for B-3 (logged in breakdown, not acted on)
  const sizing   = rules.sizing || {};
  const capital  = Number(bot.capital_usd) || 0;
  const baseSize = capital * ((sizing.position_size_pct ?? 95) / 100);
  const vixMult  = (vix != null &&
                    filters.vix_aggressive_at != null &&
                    vix > filters.vix_aggressive_at)
    ? (sizing.vix_aggressive_multiplier ?? 1.0)
    : 1.0;
  const suggested_size_usd = Math.min(capital, baseSize * vixMult);

  // ── Setup classification (B-3.7) ─────────────────────────────────────────
  const [last5dReturn, rsi14, fundamentals] = await Promise.all([
    computeLast5dReturn(symbol).catch(() => null),
    computeRsi14(symbol).catch(() => null),
    getFundamentalsGrowth(symbol).catch(() => null),
  ]);
  const enforceSetup = filters.require_setup_classification !== false;
  let setup = enforceSetup
    ? await classifySetup({ signals, indicators: { ...ind, symbol }, rsi: rsi14, fundamentals, last5dReturn }).catch(() => null)
    : null;

  // Setup classification + strategy filter + overbought gate (shared with diagnoseCandidate)
  // rsi14 is threaded in so gateOverboughtEntry can check RSI vs per-setup ceiling.
  const setupBlocker = firstBlocker({ filters, setup, enforceSetup, rsi14 }, SETUP_GATES);
  if (setupBlocker) return { _blocked: true, symbol, gate: setupBlocker.gate, value: setupBlocker.value, threshold: setupBlocker.threshold, message: setupBlocker.message };

  // ── Phase 2.1 Option C: momentum_flip override (experimental, capped at 5/day) ──
  // Backtest 2026-05-27 (BOT_DESIGN.md Decision Log): composite 60-69 + drift_5d_pct>0 + macd_hist>-3
  // yielded +6.86% / 65.5% win rate over 90d, N=1,477. CONDITIONAL on flat-to-mild-up SPY regime;
  // UNDERPERFORMS in strong SPY-up regime. Live-experiment with daily cap until we have a regime detector.
  // Kill-switch: set `entry_filters.momentum_flip_enabled = false` to disable per-bot.
  const momentumFlipEnabled = filters.momentum_flip_enabled !== false;
  const baseThreshold = filters.min_composite_score ?? 70;
  let momentumFlipApplied = false;
  if (momentumFlipEnabled && composite >= 60 && composite < baseThreshold) {
    try {
      // Pull drift_5d_pct + macd_hist from the latest conviction_scores row (last 6h)
      const { rows: cs } = await query(
        `SELECT
           CASE WHEN jsonb_typeof(signals->'drift_5d_pct') = 'number' THEN (signals->>'drift_5d_pct')::numeric ELSE NULL END AS drift_5d,
           CASE WHEN jsonb_typeof(signals->'macd_hist') = 'number' THEN (signals->>'macd_hist')::numeric ELSE NULL END AS macd_hist
         FROM conviction_scores
         WHERE symbol = $1 AND scored_at > NOW() - INTERVAL '6 hours'
         ORDER BY scored_at DESC LIMIT 1`,
        [symbol]
      );
      const drift5d = cs[0]?.drift_5d != null ? Number(cs[0].drift_5d) : null;
      const macdHist = cs[0]?.macd_hist != null ? Number(cs[0].macd_hist) : null;
      // 2026-05-28 fix: TTMI had RSI=69.4 + drift_5d=+19.6% and lost -14.5% (gapped through stop).
      // Cap momentum_flip at RSI < 68 (not already overbought) and drift_5d < 15%
      // (stock hasn't already made its move). Backtest edge was for early-stage momentum, not exhausted.
      // Note: rsi14 may be null (signal missing) → treat as pass so we don't double-block good setups.
      if (
        drift5d != null && macdHist != null &&
        drift5d > 0 && drift5d < 15 &&
        macdHist > -3 &&
        (rsi14 == null || rsi14 < 68)
      ) {
        // Check per-bot daily cap (max 5 momentum_flip buys per bot per day)
        const dailyCap = filters.momentum_flip_daily_cap ?? 5;
        const { rows: capRows } = await query(
          `SELECT COUNT(*)::int AS n FROM bot_decisions
           WHERE bot_id = $1 AND action = 'buy' AND setup_type = 'momentum_flip'
             AND (scanned_at AT TIME ZONE 'America/New_York')::date
                 = (NOW() AT TIME ZONE 'America/New_York')::date`,
          [bot.id]
        );
        if ((capRows[0]?.n ?? 0) < dailyCap) {
          // Override setup metadata to mark this as the experimental path
          const overrideSetup = {
            setup_type: 'momentum_flip',
            thesis: {
              text: `Momentum-flip experimental (Phase 2.1 Option C). Composite ${composite.toFixed(1)} (60-69 range) + drift_5d=${drift5d.toFixed(1)}% + MACD turning (${macdHist.toFixed(2)}). 5-day time-stop. Backtest 90d: +6.86%/65.5% win on N=1,477 in SPY-flat regimes. Daily cap ${dailyCap}.`,
              drift_5d_pct: drift5d,
              macd_hist: macdHist,
              backtest_evidence: 'BOT_DESIGN.md Decision Log 2026-05-27',
              experimental: true,
            },
            expected_hold_days_min: 1,
            expected_hold_days_max: 5,
          };
          // Splice override into the local `setup` so the return shape below picks it up
          // (a non-mutating wrapper would be cleaner, but `setup` may be null when classifier
          // returned no result for this candidate, so we just replace it here)
          setup = overrideSetup;
          momentumFlipApplied = true;
        }
      }
    } catch (e) {
      console.warn(`[bot-engine] momentum_flip override check failed for ${symbol}:`, e.message);
    }
  }

  return {
    symbol,
    composite: +composite.toFixed(2),
    setup_type: setup?.setup_type ?? null,
    thesis:     setup?.thesis ?? null,
    expected_hold_days_min: setup?.expected_hold_days_min ?? null,
    expected_hold_days_max: setup?.expected_hold_days_max ?? null,
    _momentum_flip: momentumFlipApplied,   // signal to caller to allow this through the composite gate
    breakdown: {
      vix,
      signals,
      weights: w,
      suggested_size_usd: +suggested_size_usd.toFixed(2),
      indicators: ind,
      rsi14, last5dReturn,
      setup_classification: setup,
    },
  };
}

// ─── Diagnostic candidate evaluator ──────────────────────────────────────────
//
// Records all gate failures (instead of bailing) so the Portfolio Advisor's
// Best Buys panel can show the user EXACTLY which gate blocked a rejected pick.
// Verdicts: BUY / NEAR / BLOCKED / WATCH.
//
// Shares its gate logic with _scoreCandidate via src/core/bot-gates.js —
// add a new gate there once and both functions pick it up. No more
// "out-of-sync gate logic" warnings.
//
// Returns `{ symbol, verdict, composite, setup_type, grade, blockers[], top_drivers[], ... }`.
// Never returns null — always returns a full diagnostic record.

// Default weights when diagnose is called without a specific bot — matches
// what the user's bots ship with so the diagnostic view reflects what bots see.
// Phase 4.2 (2026-05-28): added congress 0.05 — weak but real signal (+0.44pp edge).
// Weights are renormalized over signals WITH data so congress only participates
// when there are recent congressional buys for the given stock.
// Bug fix 2026-05-29 (audit A-3/C-1): uw_options was 0.30 here but 0.25 in all
// active bots and BOT_DEFAULT_RULES (Phase 4.2 congress fix updated server.js and
// DB but not this constant). Result: bot_verdict and diagnoseCandidate computed
// a different composite than the live bot for the same stock — up to ~4 pts higher
// for UW-strong candidates. Fixed to mirror BOT_DEFAULT_RULES exactly.
// Also added relative_strength: 0.00 so this object stays in sync as M4 weight
// is promoted (see B-3 audit finding — pairs[] must match this object).
const DIAGNOSE_DEFAULT_WEIGHTS = {
  conviction: 0.10, news: 0.22, uw_options: 0.25, gex: 0.15,
  insider: 0.15, distance_52w: 0.08, predictor: 0, congress: 0.05,
  relative_strength: 0.00,
};

export async function diagnoseCandidate(symbol, bot) {
  const rules    = bot?.rules || {};
  const filters  = rules.entry_filters    || {};
  const w        = Object.keys(rules.composite_weights || {}).length ? rules.composite_weights : DIAGNOSE_DEFAULT_WEIGHTS;
  const minScore = filters.min_composite_score ?? 70;   // raised 2026-05-27 from 40 — backtest showed 40-49 has 46.6% win rate (worse than coin flip)

  // ── Pre-signal data ─────────────────────────────────────────────────
  const ind = await getAllBotIndicators(symbol).catch(() => null);
  const vix = await _getCurrentVix();
  const earnDays = ind?.earnings?.days_until;

  // Hard gates (collect all blockers — no early exit)
  const blockers = allBlockers({ filters, indicators: ind, vix }, PRE_SIGNAL_GATES);

  // ── Signal computation ───────────────────────────────────────────────
  const [convSig, newsSig, uwSig, gexSig, insiderSig, dist52wSig, predSig, congressSig, rsSig2] = await Promise.all([
    _signalConviction(symbol),
    _signalNews(symbol),
    _signalUw(symbol),
    _signalGex(symbol),
    _signalInsider(symbol),
    _signalDistance52w(symbol),
    _signalPredictor(symbol),
    _signalCongress(symbol),
    _signalRelativeStrength(symbol),  // M4 — observational, weight=0 until backtested
  ]);
  const signals = { conviction: convSig, news: newsSig, uw_options: uwSig, gex: gexSig, insider: insiderSig, distance_52w: dist52wSig, predictor: predSig, congress: congressSig, relative_strength: rsSig2 };

  // Post-signal gates (conviction grade, UW label, news sentiment)
  blockers.push(...allBlockers({ filters, signals }, POST_SIGNAL_GATES));

  // ── Composite score (renormalized — see _scoreCandidate for rationale) ─
  const pairs = [
    ['conviction',        signals.conviction.value],
    ['news',              signals.news.value],
    ['uw_options',        signals.uw_options.value],
    ['gex',               signals.gex.value],
    ['insider',           signals.insider.value],
    ['distance_52w',      signals.distance_52w.value],
    ['predictor',         signals.predictor.value],
    ['congress',          signals.congress.value],
    ['relative_strength', signals.relative_strength.value],  // M4 — weight=0 until backtest gate passes
  ];
  let weightedSum = 0, weightTotal = 0;
  for (const [key, val] of pairs) {
    const weight = w[key] ?? 0;
    if (weight <= 0) continue;
    if (val == null || val === 0) continue;
    weightedSum += weight * val;
    weightTotal += weight;
  }
  const composite = weightTotal > 0 ? +(weightedSum / weightTotal).toFixed(2) : 0;

  const scoreBlock = gateCompositeScore({ filters: { min_composite_score: minScore }, composite });
  if (scoreBlock) blockers.push(scoreBlock);

  // ── Setup classification + strategy filter (shared with _scoreCandidate) ─
  const [last5dReturn, rsi14, fundamentals] = await Promise.all([
    computeLast5dReturn(symbol).catch(() => null),
    computeRsi14(symbol).catch(() => null),
    getFundamentalsGrowth(symbol).catch(() => null),
  ]);
  const enforceSetup = filters.require_setup_classification !== false;
  const setup = enforceSetup
    ? await classifySetup({ signals, indicators: { ...ind, symbol }, rsi: rsi14, fundamentals, last5dReturn }).catch(() => null)
    : null;
  // Thread rsi14 into setup gates so gateOverboughtEntry can apply its RSI ceiling.
  blockers.push(...allBlockers({ filters, setup, enforceSetup, rsi14 }, SETUP_GATES));

  // Top driver signals (sorted by absolute contribution to composite)
  const sigEntries = Object.entries(signals).map(([k, v]) => ({
    k,
    value: Number(v?.value ?? 0),
    weight: Number(w[k] ?? 0),
    contribution: Number(v?.value ?? 0) * Number(w[k] ?? 0),
  }));
  sigEntries.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const top_drivers = sigEntries.slice(0, 3);

  // Verdict logic
  let verdict;
  const onlyScoreGate = blockers.length === 1 && blockers[0].gate === 'composite_score';
  if (blockers.length === 0)                                                            verdict = 'BUY';
  else if (onlyScoreGate && composite >= (minScore - 10))                               verdict = 'NEAR';
  else if (composite >= minScore)                                                       verdict = 'BLOCKED';
  else                                                                                  verdict = 'WATCH';

  return {
    symbol,
    verdict,
    composite: +composite.toFixed(2),
    composite_threshold: minScore,
    setup_type: setup?.setup_type ?? null,
    thesis:     setup?.thesis     ?? null,
    grade:      convSig.grade ?? null,
    blockers,
    top_drivers,
    signals_summary: {
      conviction_score: convSig.value != null ? (convSig.value / 2 + 50) : null,  // centre-back to 0..100 for display
      news_label: newsSig.label ?? null,
      uw_label:   uwSig.label   ?? null,
    },
    next_earnings_days: earnDays,
    vix,
  };
}

// ─── Signal helpers ───────────────────────────────────────────────────────────

async function _signalConviction(symbol) {
  const { rows } = await query(
    `SELECT score, grade FROM conviction_scores
     WHERE symbol=$1 ORDER BY scored_at DESC LIMIT 1`,
    [symbol]
  );
  if (!rows.length) return { value: 0, grade: null };
  // DB score is 0..100; centre at 50 → -100..+100
  return { value: (Number(rows[0].score) - 50) * 2, grade: rows[0].grade };
}

async function _signalNews(symbol) {
  const s = await getNewsSentimentForSymbol(symbol);
  if (!s || s.label === 'no_data' || s.label === 'insufficient') {
    return { value: 0, label: 'no_data', article_count: s?.article_count ?? 0 };
  }
  // avg_sentiment is -1..+1; scale by confidence = min(article_count/10, 1)
  const conf  = Math.min((s.article_count ?? 0) / 10, 1);
  const value = (s.avg_sentiment ?? 0) * 100 * conf;
  return { value: +value.toFixed(1), label: s.label, article_count: s.article_count };
}

async function _signalUw(symbol) {
  // Primary: UW conviction labeler (returns no_data 80% of the time though)
  const c     = await getUwConvictionForSymbol(symbol).catch(() => null);
  const label = c?.composite?.label ?? 'no_data';
  const score = c?.composite?.score;
  if (label !== 'no_data' && score != null) {
    const sign = (label === 'bullish' || label === 'strong_bullish')  ?  1
               : (label === 'bearish' || label === 'strong_bearish')  ? -1
               : 0;
    return { value: +(sign * score * 100).toFixed(1), label, source: 'labeler' };
  }
  // Fallback: raw flow data — when labeler can't decide, look at the actual
  // dollar premium of bullish vs bearish alerts in the last 6h. A stock with
  // $5M of bullish premium today has VERY strong UW signal even if labeler
  // returned no_data. Was returning 0 for every stock except the ~50 the
  // labeler had enough data for.
  try {
    const { rows } = await query(
      `SELECT
         SUM(CASE WHEN sentiment IN ('bullish','strong_bullish') THEN premium ELSE 0 END) AS bull,
         SUM(CASE WHEN sentiment IN ('bearish','strong_bearish') THEN premium ELSE 0 END) AS bear
       FROM uw_flow_alerts
       WHERE ticker=$1 AND alerted_at > NOW() - INTERVAL '6 hours'`,
      [symbol]
    );
    const bull = Number(rows[0]?.bull) || 0;
    const bear = Number(rows[0]?.bear) || 0;
    if (bull === 0 && bear === 0) return { value: 0, label: 'no_data', source: 'raw' };
    const total = bull + bear;
    const tilt  = (bull - bear) / total;            // -1 (all bear) → +1 (all bull)
    // Magnitude scaler: $50K = weak signal, $1M+ = full strength
    const mag   = Math.min(1, Math.log10(total / 50_000) / 1.5);
    const value = +(tilt * Math.max(0, mag) * 100).toFixed(1);
    const dLabel = tilt > 0.2 ? (mag > 0.7 ? 'strong_bullish' : 'bullish')
                 : tilt < -0.2 ? (mag > 0.7 ? 'strong_bearish' : 'bearish')
                 : 'neutral';
    return { value, label: dLabel, source: 'raw', bull_usd: bull, bear_usd: bear };
  } catch {
    return { value: 0, label: 'no_data', source: 'raw' };
  }
}

async function _signalGex(symbol) {
  const { rows } = await query(
    `SELECT call_gamma, put_gamma FROM uw_greek_exposure
     WHERE ticker=$1 ORDER BY as_of_date DESC LIMIT 1`,
    [symbol]
  );
  if (!rows.length) return { value: 0 };
  const cg    = Number(rows[0].call_gamma) || 0;
  const pg    = Number(rows[0].put_gamma)  || 0;
  const net   = cg + pg;
  const total = Math.abs(cg) + Math.abs(pg) || 1;
  return { value: +((net / total) * 100).toFixed(1), call_gamma: cg, put_gamma: pg };
}

async function _signalInsider(symbol) {
  // SEC transaction codes — only count meaningful open-market transactions:
  // Buys:  P = open-market purchase
  // Sells: S = open-market sale (excludes F=tax withholding, A=grant, D=derivative)
  //
  // Phase 4.2 improvements (2026-05-28, BOT_DESIGN.md Decision Log):
  // Backtest on 1,658 events (2024-01-01→2026-04-30) showed:
  //   <$10K buys:  48.5% win (below SPY 62.7%) — noise, excluded
  //   Director/10%Owner ≥$100K: 67.0% win, +3.49% 5d — highest conviction
  //   All buys ≥$10K: 61.2% win, +2.78% 5d — meaningful signal
  // Role weighting: Director/10%Owner → 1.5×, Officer → 1.0×
  const { rows } = await query(
    `SELECT
       -- Weighted buy: Director/10%Owner 1.5×, Officer/other 1.0×, <$10K excluded
       SUM(CASE
         WHEN transaction_type='P' AND value >= 10000
              AND (role ILIKE '%Director%' OR role ILIKE '%10% Owner%')
         THEN value * 1.5
         WHEN transaction_type='P' AND value >= 10000
         THEN value
         ELSE 0
       END) AS buy_val_weighted,
       -- Raw buy for display (unweighted, ≥$10K only)
       SUM(CASE WHEN transaction_type='P' AND value >= 10000 THEN value ELSE 0 END) AS buy_val_raw,
       -- High-conviction subset: Director/10%Owner ≥$100K
       SUM(CASE
         WHEN transaction_type='P' AND value >= 100000
              AND (role ILIKE '%Director%' OR role ILIKE '%10% Owner%')
         THEN value ELSE 0
       END) AS hc_buy_val,
       SUM(CASE WHEN transaction_type='S' THEN value ELSE 0 END) AS sell_val
     FROM uw_insider_trades
     WHERE ticker=$1 AND filed_at > NOW() - INTERVAL '30 days'`,
    [symbol]
  );
  const buy  = Number(rows[0]?.buy_val_weighted) || 0;
  const sell = Number(rows[0]?.sell_val)         || 0;
  const raw  = Number(rows[0]?.buy_val_raw)      || 0;
  const hc   = Number(rows[0]?.hc_buy_val)       || 0;
  if (buy + sell === 0) return { value: 0, buy_usd: 0, sell_usd: 0, hc_buy_usd: 0 };
  const net   = buy - sell;
  const total = buy + sell;
  return {
    value:       +((net / total) * 100).toFixed(1),
    buy_usd:     raw,
    sell_usd:    sell,
    hc_buy_usd:  hc,
    role_weighted: true,
  };
}

async function _signalCongress(symbol) {
  // Congressional trade signal (STOCK Act filings).
  // Phase 4.1B backtest (2025-12-22→2026-05-18, N=854 buys):
  //   All buys ≥$15K:    +0.44pp edge vs SPY, 57.6% win
  //   ≥$100K buys:       66.1% win, N=56
  //   Quick filers 0-5d: +2.34% 5d, 66.7% win
  // Sell signal: inconclusive — stocks also rose after sells (market bias period)
  // Returns 0 when no recent congressional buys (no-data → excluded from composite)
  const { rows } = await query(
    `SELECT
       COUNT(*) FILTER (
         WHERE transaction_type='Buy'
           AND amount_range != '$1,001 - $15,000'
       ) AS buy_count,
       COUNT(*) FILTER (
         WHERE transaction_type='Buy'
           AND (amount_range LIKE '$100,001%' OR amount_range LIKE '$250,001%'
             OR amount_range LIKE '$500,001%' OR amount_range LIKE '>%')
       ) AS hc_buy_count,
       MIN(EXTRACT(DAY FROM (filed_at - traded_at::timestamptz)))
         FILTER (WHERE transaction_type='Buy' AND amount_range != '$1,001 - $15,000')
         AS min_lag_days
     FROM uw_congressional_trades
     WHERE ticker=$1 AND filed_at > NOW() - INTERVAL '30 days'`,
    [symbol]
  );
  const buys    = Number(rows[0]?.buy_count)    || 0;
  const hcBuys  = Number(rows[0]?.hc_buy_count) || 0;
  const minLag  = Number(rows[0]?.min_lag_days);
  if (buys === 0) return { value: 0, buy_count: 0, hc_buy_count: 0 };
  // Score: base signal + HC bonus + quick-filer bonus
  let value = buys === 1 ? 30 : 50;               // 1 buy → +30, 2+ → +50
  if (hcBuys >= 1) value = Math.max(value, 60);   // ≥$100K → at least +60
  if (hcBuys >= 2) value = Math.max(value, 75);   // 2+ HC buys → +75
  if (!isNaN(minLag) && minLag <= 5) value += 15; // quick filer bonus: +15
  value = Math.min(100, value);
  return { value, buy_count: buys, hc_buy_count: hcBuys, min_lag_days: isNaN(minLag) ? null : minLag };
}

async function _signalDistance52w(symbol) {
  const { rows: last } = await query(
    `SELECT close FROM backtest_prices WHERE symbol=$1 ORDER BY price_date DESC LIMIT 1`,
    [symbol]
  );
  if (!last.length) return { value: 0 };
  const price = Number(last[0].close);
  const { rows: hi } = await query(
    `SELECT MAX(high) AS hi52w FROM backtest_prices
     WHERE symbol=$1 AND price_date > NOW() - INTERVAL '365 days'`,
    [symbol]
  );
  const high = Number(hi[0]?.hi52w) || price;
  if (!high) return { value: 0 };
  const pctOff = (price - high) / high; // -1..0
  // ── Phase 2.6 momentum re-weighting (2026-05-27, BOT_DESIGN.md Decision Log) ──
  // OLD mapping was empirically backwards: penalized near-52w-high with -40
  // (mean-reversion bias), rewarded -40% off the high with +80 (catching falling
  // knives). Backtest on 21,719 signal_returns rows proved the inversion:
  //   Top 10% by signal:  OLD +2.82%/5d 58.2% win  →  NEW +9.00%/5d 76.6% win
  //   Top 25% by signal:  OLD +1.46%/5d 53.6% win  →  NEW +7.06%/5d 68.2% win
  // Edge: +6.2pp on top picks, +14.4pp winrate. Far above +3pp ship threshold.
  // Aligns with Jegadeesh-Titman (1993) momentum literature and Pavan's earlier
  // pushback "buying at 52w high underperforms is wrong".
  let value;
  if      (pctOff > -0.02) value =  80;  // within 2% of high — breakout/momentum
  else if (pctOff > -0.10) value =  50;  // 2-10% off — still in trend
  else if (pctOff > -0.25) value =  10;  // 10-25% off — correction/neutral zone
  else                     value = -40;  // > 25% off — distressed / falling knife
  return { value, pct_off_52w_high: +pctOff.toFixed(3) };
}

async function _signalPredictor(symbol) {
  const { rows } = await query(
    `SELECT predicted_change_pct, confidence FROM stock_predictions
     WHERE symbol=$1 ORDER BY created_at DESC LIMIT 1`,
    [symbol]
  );
  if (!rows.length) return { value: 0 };
  const pct  = Number(rows[0].predicted_change_pct) || 0;
  const conf = Number(rows[0].confidence) || 50;
  // 47% historical accuracy — weight already capped at 5% in defaults
  const value = Math.max(-100, Math.min(100, pct * 10)) * (conf / 100);
  return { value: +value.toFixed(1), predicted_change_pct: pct, confidence: conf };
}

// ─── _signalRelativeStrength ───────────────────────────────────────────────────
// M4 (2026-05-29): queries relative_strength table computed by rs-scanner.js
// daily cron. Returns value 0–100 based on rank_overall percentile + RS vs sector.
//
// Weight: 0.00 (observational) — no backtest data yet.
// Backtest gate: after 30d of daily RS data, test whether top-quartile RS symbols
// (rs_vs_spy_5d > 0 AND rank_overall ≤ 25%) show ≥ +2pp edge vs bottom half.
// If gate passes, promote to 0.05 weight, reduce distance_52w from 0.08 → 0.03.
// (The two signals are correlated — near-52w-high stocks tend to have strong RS.)
async function _signalRelativeStrength(symbol) {
  try {
    const { rows } = await query(
      `SELECT rs_vs_spy_5d, rs_vs_sector_5d, rank_overall, rank_sector, return_5d
       FROM relative_strength
       WHERE symbol = $1
       ORDER BY calc_date DESC
       LIMIT 1`,
      [symbol.toUpperCase()]
    );
    if (!rows.length) return { value: 0 };
    const rs5d     = rows[0].rs_vs_spy_5d  != null ? Number(rows[0].rs_vs_spy_5d)  : null;
    const rsSec    = rows[0].rs_vs_sector_5d != null ? Number(rows[0].rs_vs_sector_5d) : null;
    const rankAll  = rows[0].rank_overall   != null ? Number(rows[0].rank_overall)  : null;

    if (rs5d == null) return { value: 0 };

    // Score in [-100, +100] range (signal-module contract; 0 = neutral).
    // FIXED 2026-06-01: previously returned 10-90 unsigned which violated the
    // contract and caused composite-score scaling drift in scoring.js.
    //   rs_spy >  +20pp → +80 (sector leader)
    //   rs_spy +5–+20pp → +40-60 (strong outperformer)
    //   rs_spy   0–+5pp → 0-+20 (modest outperformer)
    //   rs_spy -5–  0pp → -20-0 (slight laggard)
    //   rs_spy < -5pp   → -40-80 (clear laggard)
    let value;
    if      (rs5d >=  20) value = 80;
    else if (rs5d >=  10) value = 60;
    else if (rs5d >=   5) value = 40;
    else if (rs5d >=   2) value = 20;
    else if (rs5d >=   0) value = 0;
    else if (rs5d >=  -3) value = -20;
    else if (rs5d >=  -7) value = -50;
    else                  value = -80;

    // Sector bonus: +/-10 if also beating/lagging sector ETF
    if (rsSec != null) value = Math.max(-100, Math.min(100, value + (rsSec > 0 ? 10 : rsSec < 0 ? -10 : 0)));

    return {
      value,
      rs_vs_spy_5d:    rs5d    != null ? +rs5d.toFixed(2)    : null,
      rs_vs_sector_5d: rsSec   != null ? +rsSec.toFixed(2)   : null,
      rank_overall:    rankAll,
    };
  } catch { return { value: 0 }; }
}

async function _getCurrentVix() {
  const { rows } = await query(
    `SELECT close FROM backtest_prices
     WHERE symbol IN ('^VIX','VIX') ORDER BY price_date DESC LIMIT 1`
  );
  return rows[0] ? Number(rows[0].close) : null;
}

// ─── Decision logger ──────────────────────────────────────────────────────────

async function _log(botId, action, symbol, composite, factor_breakdown, notes, setup_type = null, thesis = null) {
  try {
    await recordDecision({
      botId, action, symbol, composite,
      factorBreakdown: factor_breakdown,
      notes, setupType: setup_type, thesis,
    });
  } catch (e) {
    console.error('[bot-engine] log failed:', e.message);
  }
  return { action, symbol, composite, notes, setup_type, thesis };
}

// ─── Cron registration ────────────────────────────────────────────────────────

export function startBotEngineCrons() {
  // 2026-05-28 fix: trading-bot AND trading-dashboard both run `npm start` and both
  // call startBotEngineCrons → duplicate scans firing within ms of each other → duplicate
  // 'buy' decisions on the same symbol (TOCTOU on the DB dedup guard).
  // Gate cron registration on BOT_CRON_OWNER=true so only ONE process owns the scanner.
  // Set this in the trading-bot PM2 process env only; leave it unset on trading-dashboard.
  if (process.env.BOT_CRON_OWNER !== 'true') {
    console.log('[bot-engine] crons NOT scheduled (BOT_CRON_OWNER != true) — this process is a non-owner');
    return;
  }
  const TZ = { timezone: 'America/New_York' };
  // 9:30–9:59 ET on :30 past then every 5 min
  cron.schedule('30/5 9 * * 1-5', () => runBotScanForAllActive(), TZ);
  // 10:00–15:59 ET every 5 min
  cron.schedule('*/5 10-15 * * 1-5', () => runBotScanForAllActive(), TZ);
  console.log('[bot-engine] crons scheduled — scanning every 5 min during market hours (BOT_CRON_OWNER=true)');
}
