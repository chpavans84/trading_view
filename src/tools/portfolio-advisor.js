/**
 * src/tools/portfolio-advisor.js
 *
 * MCP tools exposing the dashboard's Portfolio Advisor + System Health +
 * Signal Validation + bot decision simulator. Mirror of the same 5 tools in
 * src/core/ai-chat.js (TOOLS array) — both surfaces share the underlying
 * backend modules so a logic change in one place propagates to both.
 *
 * Added 2026-05-24 as Path B / Step 2.
 *
 * Note on DB: the MCP server doesn't normally need DB. These tools do.
 * We lazy-init the DB pool on first tool call so the MCP server still
 * boots cleanly even if the DB is unreachable.
 */

import { z } from 'zod';
import { jsonResult } from './_format.js';
import { initDb, query as dbQuery, isDbAvailable } from '../core/db.js';
import { enrichPositions, getHedgeRecommendation as advHedgeRecommendation } from '../web/portfolio-advisor.js';
import { runAllChecks as runHealthChecks } from '../web/health-checks.js';
import { diagnoseCandidate } from '../core/bot-engine.js';
import { getFunds, getPositions as getMoomooPositions } from '../core/moomoo-tcp.js';
import { getAccount as getAlpacaAccount, getPositions as getAlpacaPositions, getLiveAccount, getLivePositions } from '../core/trader.js';

// ── Lazy DB init ────────────────────────────────────────────────────────────
let _dbReady = false;
async function ensureDb() {
  if (_dbReady) return true;
  try { await initDb(); _dbReady = isDbAvailable(); return _dbReady; }
  catch (err) { return false; }
}

// ── Production bot rules (mirror of BOT_DEFAULT_RULES in src/web/server.js) ─
// Kept locally to avoid cross-module dependency from MCP server into web/server.js
const PROD_BOT_RULES = {
  rules: {
    entry_filters: {
      min_composite_score: 70, conviction_grade_min: 'C',
      market_cap_min_b: 5, price_min: 5, price_max: 2500,
      min_adv_dollar_vol: 5_000_000, avoid_earnings_within_days: 3,
      vix_min: 15, vix_max: 60, vix_aggressive_at: 25,
      require_uw_label_any: ['bullish', 'strong_bullish'],
      skip_during_macro_blackout: true, avoid_premarket_gap_above_pct: 8,
    },
    composite_weights: {
      conviction: 0.10, news: 0.22, uw_options: 0.30, gex: 0.15,
      insider: 0.15, distance_52w: 0.08, predictor: 0.00,
    },
  },
  capital_usd: 10000,
};

export function registerPortfolioAdvisorTools(server) {

  server.tool(
    'portfolio_advisor',
    'Full portfolio advisory: every held position with 8-factor risk score (0-100), the bot\'s verdict (BUY/HOLD/TRIM/EXIT) per holding, and a covered-call hedge recommendation when risk ≥ 60. Returns per-position factor breakdown showing exactly what is driving each risk score (drawdown, concentration, days-to-earnings, volatility, bot conviction, UW flow, news, sector). Source defaults to Alpaca paper; pass source="moomoo" for the Moomoo brokerage.',
    {
      source: z.enum(['alpaca', 'alpaca_live', 'moomoo']).optional().describe('Broker source. Default: alpaca paper.'),
    },
    async ({ source }) => {
      const src = (source || 'alpaca').toLowerCase();
      if (!await ensureDb()) return jsonResult({ error: 'Database unreachable from MCP server.' }, true);
      let positions = [], accountValue = 0;
      try {
        if (src === 'moomoo') {
          const [fundsRes, posRes] = await Promise.allSettled([getFunds(), getMoomooPositions()]);
          const f = fundsRes.status === 'fulfilled' ? fundsRes.value : null;
          const p = posRes.status  === 'fulfilled' ? posRes.value  : null;
          if (!p) return jsonResult({ error: 'Moomoo unreachable — rate-limited or OpenD not running on localhost:11111.' }, true);
          accountValue = f?.total_assets || p?.total_market_val || 0;
          positions = (p?.positions || []).map(x => ({
            symbol: x.symbol, name: x.name, qty: Number(x.qty),
            avg_cost: Number(x.avg_cost), current_price: Number(x.current_price),
            market_val: Number(x.market_val), unrealized_pl: Number(x.unrealized_pl),
            unrealized_pl_pct: x.unrealized_pl_pct != null ? Number(x.unrealized_pl_pct) : null,
            today_pl: Number(x.today_pl ?? 0),
          }));
        } else {
          const useLive = src === 'alpaca_live';
          const [acct, posList] = await Promise.allSettled(
            useLive ? [getLiveAccount(), getLivePositions()] : [getAlpacaAccount(), getAlpacaPositions()]
          );
          accountValue = acct.status === 'fulfilled' ? Number(acct.value?.portfolio_value || 0) : 0;
          const pl = posList.status === 'fulfilled' ? (posList.value || []) : [];
          positions = pl.map(x => ({
            symbol: x.symbol, name: x.symbol, qty: Math.abs(Number(x.qty)),
            avg_cost: Number(x.avg_entry_price), current_price: Number(x.current_price),
            market_val: Number(x.market_value), unrealized_pl: Number(x.unrealized_pl),
            unrealized_pl_pct: Number(x.unrealized_plpc) * 100,
            today_pl: Number(x.unrealized_intraday_pl ?? 0),
          }));
        }
      } catch (err) { return jsonResult({ error: `Broker fetch failed: ${err.message}`, source: src }, true); }
      if (!positions.length) return jsonResult({ source: src, account_value: accountValue, positions: [], note: `${src} account has no open positions (cash only).` });
      const enriched = await enrichPositions(positions, accountValue, dbQuery);
      const totalUnrealized = enriched.reduce((s, p) => s + (p.unrealized_pl || 0), 0);
      const avgRisk = Math.round(enriched.reduce((s, p) => s + (p.risk?.score || 0), 0) / enriched.length);
      const concerns = enriched
        .filter(p => (p.risk?.score || 0) >= 60 || (p.unrealized_pl_pct || 0) < -10)
        .sort((a, b) => (b.risk?.score || 0) - (a.risk?.score || 0))
        .slice(0, 3)
        .map(p => ({ symbol: p.symbol, risk: p.risk?.score, pl_pct: p.unrealized_pl_pct }));
      return jsonResult({ source: src, account_value: accountValue, total_unrealized_pl: +totalUnrealized.toFixed(2), avg_risk_score: avgRisk, top_concerns: concerns, positions: enriched });
    }
  );

  server.tool(
    'bot_verdict',
    'Run the bot\'s full decision engine on a single symbol. Returns one of 4 verdicts: BUY (passes all gates, composite ≥ 70), NEAR (within 10 points of threshold), BLOCKED (composite high enough but a hard gate fails), WATCH (below threshold). Also returns composite score, setup type (catalyst/breakout/momentum/value/mean_reversion), top 3 driver signals, and explicit blockers[] naming each failed gate (earnings_proximity, liquidity, conviction_grade, uw_label, etc.). Use whenever asked "would the bot buy X?" or "why didn\'t the bot trade X?".',
    {
      symbol: z.string().describe('Stock ticker, e.g. NVDA, AAPL.'),
    },
    async ({ symbol }) => {
      const sym = (symbol || '').trim().toUpperCase();
      if (!sym) return jsonResult({ error: 'symbol is required' }, true);
      if (!await ensureDb()) return jsonResult({ error: 'Database unreachable from MCP server.' }, true);
      try { return jsonResult(await diagnoseCandidate(sym, PROD_BOT_RULES)); }
      catch (err) { return jsonResult({ error: `Bot diagnostic failed: ${err.message}` }, true); }
    }
  );

  server.tool(
    'system_health',
    'Run all 20 system-health invariants from the 🩺 Health dashboard. Returns per-check: status (ok/warn/fail), measured value, threshold, and inline what/why/if_red docs. Covers data pipeline (tradable_universe, UW flow, news, prices), DB integrity (dangling pointers, stale predictions), cron heartbeats (bot scanner, executor, universe sync), ML quality (model AUC, signal variance), processes (PM2 daemons, DB latency, Anthropic API key). Use this before recommending any action that depends on a specific data source being live, or when diagnosing "is anything broken".',
    {},
    async () => {
      if (!await ensureDb()) return jsonResult({ error: 'Database unreachable from MCP server.' }, true);
      try { return jsonResult(await runHealthChecks(dbQuery)); }
      catch (err) { return jsonResult({ error: `Health check failed: ${err.message}` }, true); }
    }
  );

  server.tool(
    'signal_track_record',
    'Forward-return analysis of the bot\'s conviction signal over a recent window. For each conviction score issued, matches against actual price 5 and 10 trading days later from backtest_prices. Returns stats by score bucket (80-100, 60-79, 40-59, 20-39, 0-19): avg forward return + % of cases where price went up. Use as EVIDENCE when questioning whether the bot signals work. Typical result: high-score signals show +9pp 10-day edge over low-score signals = real signal exists.',
    {
      days: z.coerce.number().optional().describe('Lookback window in days. Default 90, min 7, max 365.'),
    },
    async ({ days }) => {
      const d = Math.min(Math.max(parseInt(days, 10) || 90, 7), 365);
      if (!await ensureDb()) return jsonResult({ error: 'Database unreachable from MCP server.' }, true);
      try {
        const cte = `
          WITH daily_scores AS (
            SELECT DISTINCT ON (symbol, scored_at::date) symbol, scored_at::date AS score_date, grade, score
            FROM conviction_scores WHERE scored_at > NOW() - INTERVAL '${d} days'
            ORDER BY symbol, scored_at::date, scored_at DESC
          ),
          price_seq AS (
            SELECT symbol, price_date, adj_close, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY price_date) AS day_idx
            FROM backtest_prices WHERE price_date > NOW() - INTERVAL '${d + 30} days'
          ),
          matched AS (
            SELECT s.grade, s.score,
              CASE WHEN s.score >= 80 THEN '80-100' WHEN s.score >= 60 THEN '60-79' WHEN s.score >= 40 THEN '40-59' WHEN s.score >= 20 THEN '20-39' ELSE '0-19' END AS bucket,
              p_in.adj_close AS px_0, p5.adj_close AS px_5, p10.adj_close AS px_10
            FROM daily_scores s
            JOIN price_seq p_in ON p_in.symbol = s.symbol AND p_in.price_date = s.score_date
            LEFT JOIN price_seq p5  ON p5.symbol  = s.symbol AND p5.day_idx  = p_in.day_idx + 5
            LEFT JOIN price_seq p10 ON p10.symbol = s.symbol AND p10.day_idx = p_in.day_idx + 10
          )`;
        const byBucket = await dbQuery(`${cte}
          SELECT bucket, COUNT(*)::int AS n,
            ROUND(AVG((px_5  / px_0 - 1) * 100)::numeric, 2) AS avg_5d_pct,
            ROUND(AVG((px_10 / px_0 - 1) * 100)::numeric, 2) AS avg_10d_pct,
            ROUND(100.0 * COUNT(*) FILTER (WHERE px_10 > px_0)::numeric / NULLIF(COUNT(px_10), 0), 1) AS pct_up_10d
          FROM matched WHERE px_10 IS NOT NULL GROUP BY bucket ORDER BY bucket DESC`);
        const ml = await dbQuery(`SELECT trained_at, auc_roc, accuracy, f1_1 FROM model_results ORDER BY trained_at DESC LIMIT 1`);
        return jsonResult({
          window_days: d, by_score_bucket: byBucket.rows, latest_ml_model: ml.rows[0] ?? null,
          interpretation: 'Higher buckets should show larger forward returns + higher % up. 5pp+ gap between 60+ and 0-19 buckets = real edge. AUC > 0.6 = ML adjustment layer has skill.',
        });
      } catch (err) { return jsonResult({ error: `Track record query failed: ${err.message}` }, true); }
    }
  );

  server.tool(
    'weekly_bot_retrospective',
    'Generate a structured weekly retrospective of the bot\'s activity. Returns: trades opened/closed in the window with P&L, top winners + top losers, biggest misses (stocks that conviction-engine scored A/B but bot never bought), gate-histogram summary (which gates rejected most candidates), signal-edge updates from signal_returns. Use on Saturdays to assess the week. Pavan asks Claude Desktop "weekly review" and this gives all the data; Claude narrates the analysis using your Max subscription.',
    {
      days: z.coerce.number().optional().describe('Lookback window in days. Default 7, min 1, max 30.'),
    },
    async ({ days }) => {
      const d = Math.min(Math.max(parseInt(days, 10) || 7, 1), 30);
      if (!await ensureDb()) return jsonResult({ error: 'Database unreachable from MCP server.' }, true);
      try {
        // 1. Trades opened in window
        const { rows: opened } = await dbQuery(`
          SELECT t.symbol, t.qty, t.entry_price, t.opened_at, t.setup_type, t.status,
                 t.exit_price, t.closed_at, b.name AS bot_name,
                 CASE WHEN t.status = 'closed' AND t.entry_price > 0
                      THEN ROUND(((t.exit_price - t.entry_price) / t.entry_price * 100)::numeric, 2)
                      ELSE NULL END AS pnl_pct,
                 CASE WHEN t.status = 'closed' AND t.qty IS NOT NULL
                      THEN ROUND(((t.exit_price - t.entry_price) * t.qty)::numeric, 2)
                      ELSE NULL END AS pnl_usd
          FROM trades t LEFT JOIN bots b ON b.id = t.bot_id
          WHERE t.opened_at > NOW() - INTERVAL '${d} days'
          ORDER BY t.opened_at DESC LIMIT 50`);

        // 2. Top winners + losers (closed only)
        const closed = opened.filter(t => t.status === 'closed' && t.pnl_pct != null);
        const winners = [...closed].filter(t => t.pnl_pct > 0).sort((a, b) => b.pnl_pct - a.pnl_pct).slice(0, 5);
        const losers  = [...closed].filter(t => t.pnl_pct < 0).sort((a, b) => a.pnl_pct - b.pnl_pct).slice(0, 5);
        const open_positions = opened.filter(t => t.status === 'open');

        // 3. Biggest MISSES: A/B-grade conviction stocks the bot never bought
        const heldSymbols = open_positions.map(t => t.symbol).concat(closed.map(t => t.symbol));
        const heldSet = heldSymbols.length ? heldSymbols : ['__NONE__'];
        const { rows: misses } = await dbQuery(`
          SELECT cs.symbol,
                 MAX(cs.score)::int AS peak_score,
                 STRING_AGG(DISTINCT cs.grade, ',') AS grades,
                 COUNT(*)::int AS n_scores,
                 MAX(cs.scored_at) AS latest_score_at
          FROM conviction_scores cs
          WHERE cs.scored_at > NOW() - INTERVAL '${d} days'
            AND cs.grade IN ('A', 'B')
            AND cs.score >= 70
            AND cs.symbol != ALL($1::text[])
          GROUP BY cs.symbol
          ORDER BY MAX(cs.score) DESC, COUNT(*) DESC
          LIMIT 15`, [heldSet]);

        // 4. Gate-histogram summary (from Phase 1.2 logging)
        const { rows: gateHist } = await dbQuery(`
          SELECT key AS gate, SUM(value::int)::int AS rejections
          FROM bot_decisions bd, jsonb_each_text(bd.factor_breakdown->'gate_histogram')
          WHERE bd.scanned_at > NOW() - INTERVAL '${d} days'
            AND bd.factor_breakdown ? 'gate_histogram'
          GROUP BY 1 ORDER BY 2 DESC LIMIT 10`);

        // 5. Bot decision action breakdown
        const { rows: actionMix } = await dbQuery(`
          SELECT action, COUNT(*)::int AS n
          FROM bot_decisions
          WHERE scanned_at > NOW() - INTERVAL '${d} days'
          GROUP BY 1 ORDER BY 2 DESC`);

        // 6. Composite-score edge stats (refresh from signal_returns)
        const { rows: compositeEdge } = await dbQuery(`
          SELECT
            CASE WHEN composite_score >= 80 THEN '80-100'
                 WHEN composite_score >= 70 THEN '70-79'
                 WHEN composite_score >= 60 THEN '60-69'
                 ELSE 'below 60' END AS bucket,
            COUNT(DISTINCT source_id)::int AS n,
            ROUND(AVG(ret_10d_pct)::numeric, 2)::float8 AS avg_10d_pct,
            ROUND(100.0 * COUNT(*) FILTER (WHERE ret_10d_pct > 0)::numeric / NULLIF(COUNT(*), 0), 1)::float8 AS win_10d_pct
          FROM signal_returns
          WHERE signal_name = 'vix' AND ret_10d_pct IS NOT NULL
            AND scored_at > NOW() - INTERVAL '${d * 6} days'   -- wider window for stats
          GROUP BY 1 ORDER BY 1 DESC`);

        // 7. Momentum_flip live experiment stats
        const { rows: momFlipStats } = await dbQuery(`
          SELECT COUNT(*)::int AS n_buys, COUNT(DISTINCT symbol)::int AS unique_symbols
          FROM bot_decisions
          WHERE setup_type = 'momentum_flip' AND action = 'buy'
            AND scanned_at > NOW() - INTERVAL '${d} days'`);

        return jsonResult({
          window_days: d,
          generated_at: new Date().toISOString(),
          trades_opened: opened.length,
          trades_closed: closed.length,
          open_positions: open_positions.length,
          total_realized_pnl_usd: closed.reduce((s, t) => s + (Number(t.pnl_usd) || 0), 0).toFixed(2),
          winners,
          losers,
          biggest_misses: misses,
          gate_rejection_summary: gateHist,
          action_breakdown: actionMix,
          composite_edge_recent: compositeEdge,
          momentum_flip_experiment: momFlipStats[0],
          interpretation: 'Use winners + losers to assess which setups worked. biggest_misses = stocks scored A/B at 70+ but bot never bought (universe filter, gate rejection, or capacity constraint). gate_rejection_summary tells which gate is killing trades. momentum_flip_experiment tracks the live capped experiment shipped 2026-05-27.',
        });
      } catch (err) {
        return jsonResult({ error: `Weekly retrospective failed: ${err.message}` }, true);
      }
    }
  );

  server.tool(
    'why_didnt_bot_buy',
    'Audit why the bot did NOT take a position in a specific symbol. Returns three things: (1) historical bot_decisions for the symbol on the requested date or recent window, including the gate histogram showing which gates rejected candidates that scan, (2) any conviction_scores written for the symbol around that time with grade + composite, (3) a live `bot_verdict` for the symbol RIGHT NOW (uses current data — same engine as live bot scans). Use when Pavan asks "why didn\'t the bot buy MU on May 21?" or "what\'s blocking AMD today?". Note: live verdict uses CURRENT signals; historical bot_decisions row tells what happened at the time.',
    {
      symbol: z.string().describe('Stock ticker, e.g. MU, AMD, NVDA.'),
      date: z.string().optional().describe('ISO date YYYY-MM-DD to audit, e.g. "2026-05-21". Default: last 7 days of decisions for the symbol.'),
    },
    async ({ symbol, date }) => {
      const sym = (symbol || '').trim().toUpperCase();
      if (!sym) return jsonResult({ error: 'symbol is required' }, true);
      if (!await ensureDb()) return jsonResult({ error: 'Database unreachable from MCP server.' }, true);
      try {
        // 1. Historical bot_decisions for this symbol
        const decisionsQuery = date
          ? `SELECT bd.id, bd.bot_id, b.name AS bot_name, bd.scanned_at, bd.action, bd.composite_score, bd.setup_type, bd.notes, bd.factor_breakdown
             FROM bot_decisions bd
             LEFT JOIN bots b ON b.id = bd.bot_id
             WHERE bd.symbol = $1
               AND (bd.scanned_at AT TIME ZONE 'America/New_York')::date = $2::date
             ORDER BY bd.scanned_at DESC LIMIT 20`
          : `SELECT bd.id, bd.bot_id, b.name AS bot_name, bd.scanned_at, bd.action, bd.composite_score, bd.setup_type, bd.notes, bd.factor_breakdown
             FROM bot_decisions bd
             LEFT JOIN bots b ON b.id = bd.bot_id
             WHERE bd.symbol = $1
               AND bd.scanned_at > NOW() - INTERVAL '7 days'
             ORDER BY bd.scanned_at DESC LIMIT 20`;
        const decisionsParams = date ? [sym, date] : [sym];
        const { rows: decisions } = await dbQuery(decisionsQuery, decisionsParams);

        // 1b. Gate histograms from the SAME bot+date as the symbol's decisions (not random other bots).
        // FIXED 2026-06-01: previously matched only by date+action, returning unrelated histograms
        // for other symbols/bots. Now constrains to the bot_id values from the decisions we just
        // fetched so the histogram reflects the same scan context as the decision rows above.
        const botIdsForHist = [...new Set(decisions.map(d => d.bot_id).filter(Boolean))];
        let gateHistograms = [];
        if (botIdsForHist.length) {
          const histogramQuery = date
            ? `SELECT b.name AS bot_name, bd.scanned_at, bd.action, bd.factor_breakdown->'gate_histogram' AS gates, bd.factor_breakdown->'sample_blocked' AS sample, bd.notes
               FROM bot_decisions bd LEFT JOIN bots b ON b.id = bd.bot_id
               WHERE bd.action IN ('skip_unclassifiable_setup', 'skip_filtered')
                 AND (bd.scanned_at AT TIME ZONE 'America/New_York')::date = $1::date
                 AND bd.bot_id = ANY($2::int[])
                 AND bd.factor_breakdown ? 'gate_histogram'
               ORDER BY bd.scanned_at DESC LIMIT 10`
            : `SELECT b.name AS bot_name, bd.scanned_at, bd.action, bd.factor_breakdown->'gate_histogram' AS gates, bd.factor_breakdown->'sample_blocked' AS sample, bd.notes
               FROM bot_decisions bd LEFT JOIN bots b ON b.id = bd.bot_id
               WHERE bd.action IN ('skip_unclassifiable_setup', 'skip_filtered')
                 AND bd.scanned_at > NOW() - INTERVAL '24 hours'
                 AND bd.bot_id = ANY($1::int[])
                 AND bd.factor_breakdown ? 'gate_histogram'
               ORDER BY bd.scanned_at DESC LIMIT 10`;
          const histogramParams = date ? [date, botIdsForHist] : [botIdsForHist];
          ({ rows: gateHistograms } = await dbQuery(histogramQuery, histogramParams));
        }

        // 2. Conviction scores around that date
        const scoresQuery = date
          ? `SELECT scored_at, score, grade, signals->>'rsi' AS rsi, signals->>'analyst_consensus' AS analyst_consensus, signals->>'weekly_trend' AS weekly_trend
             FROM conviction_scores
             WHERE symbol = $1
               AND (scored_at AT TIME ZONE 'America/New_York')::date BETWEEN ($2::date - 1) AND ($2::date + 1)
             ORDER BY scored_at DESC LIMIT 15`
          : `SELECT scored_at, score, grade, signals->>'rsi' AS rsi, signals->>'analyst_consensus' AS analyst_consensus, signals->>'weekly_trend' AS weekly_trend
             FROM conviction_scores
             WHERE symbol = $1 AND scored_at > NOW() - INTERVAL '7 days'
             ORDER BY scored_at DESC LIMIT 15`;
        const { rows: scores } = await dbQuery(scoresQuery, decisionsParams);

        // 3. Live verdict using current data
        let liveVerdict = null;
        try {
          liveVerdict = await diagnoseCandidate(sym, PROD_BOT_RULES);
        } catch (err) {
          liveVerdict = { error: `Live diagnose failed: ${err.message}` };
        }

        return jsonResult({
          symbol: sym,
          query_date: date || 'last 7 days',
          summary: decisions.length === 0
            ? `No bot_decisions for ${sym} in the requested window. Either the bot never had ${sym} in its candidate universe, or no scan ran. Check the gate_histograms below to see what was killing candidates in scans that day.`
            : `${decisions.length} bot_decision rows for ${sym}. See "decisions" array for what each bot did when it saw ${sym}.`,
          decisions: decisions,
          gate_histograms: gateHistograms,
          conviction_scores: scores,
          live_verdict_now: liveVerdict,
          interpretation: 'Three views: (1) decisions = bot rows that saw this symbol on the date; (2) gate_histograms = scans that day where ALL candidates were blocked, showing which gates fired most. If the symbol isn\'t in (1) but appears in (3) conviction_scores with grade A/B, then the symbol was scored by the pipeline but NEVER reached the bot — likely killed at the universe filter (ADV NULL, price out of band, etc.). live_verdict_now answers what would happen RIGHT NOW if the bot scanned this symbol fresh.',
        });
      } catch (err) {
        return jsonResult({ error: `Audit query failed: ${err.message}` }, true);
      }
    }
  );

  server.tool(
    'signal_edge_report',
    'Forward-return edge analysis per signal from the signal_returns table. For each tracked signal (composite_score, RSI, RVOL, analyst_consensus, analyst_upside_pct, insider_buys_60d, weekly_trend, drift_5d_pct, etc.), reports avg 5d/10d forward returns + win rate, BUCKETED BY VALUE (numeric signals) or BY LABEL (categorical). Use this as the canonical "does this signal have edge?" answer. ' +
    'Pass `signal` (default: top 10 signals by sample size) to focus on one signal. Pass `days` (default 90, range 30-365). The 90-day backfill covers ~40k unique decisions per signal, ~22k with full 10d windows. Example findings already discovered 2026-05-27: composite_score 70+ has +10%/70% win rate vs 40-49 at +2%/47% (worse than coin flip); RSI 70+ overbought wins +9.65%; analyst upside 30%+ is WORST bucket (herd-already-priced-in).',
    {
      signal: z.string().optional().describe('Specific signal_name to analyze (e.g. "rsi", "analyst_consensus", "composite_score"). Omit to get top signals overview.'),
      days: z.coerce.number().optional().describe('Lookback window in days. Default 90, min 30, max 365.'),
    },
    async ({ signal, days }) => {
      const d = Math.min(Math.max(parseInt(days, 10) || 90, 30), 365);
      if (!await ensureDb()) return jsonResult({ error: 'Database unreachable from MCP server.' }, true);
      try {
        // Composite-score bucketed analysis is the headline finding — always include.
        const compositeBuckets = await dbQuery(`
          SELECT
            CASE WHEN composite_score >= 80 THEN '80-100'
                 WHEN composite_score >= 70 THEN '70-79'
                 WHEN composite_score >= 60 THEN '60-69'
                 WHEN composite_score >= 50 THEN '50-59'
                 WHEN composite_score >= 40 THEN '40-49'
                 ELSE '0-39' END AS bucket,
            COUNT(DISTINCT source_id)::int AS n_decisions,
            ROUND(AVG(ret_5d_pct)::numeric, 2)::float8  AS avg_5d_pct,
            ROUND(AVG(ret_10d_pct)::numeric, 2)::float8 AS avg_10d_pct,
            ROUND((COUNT(*) FILTER (WHERE ret_10d_pct > 0)::numeric / NULLIF(COUNT(ret_10d_pct), 0) * 100), 1)::float8 AS pct_up_10d
          FROM signal_returns
          WHERE signal_name = 'vix'
            AND scored_at > NOW() - INTERVAL '${d} days'
            AND ret_10d_pct IS NOT NULL
          GROUP BY 1 ORDER BY 1 DESC`);

        // If a specific signal is requested, analyze it in detail (numeric → bucketed, label → grouped).
        if (signal) {
          const sigName = signal.trim().toLowerCase();
          // Detect whether this signal is mostly numeric or labeled
          const probe = await dbQuery(`
            SELECT
              COUNT(signal_value)::int AS n_numeric,
              COUNT(signal_label)::int AS n_label
            FROM signal_returns
            WHERE signal_name = $1 AND scored_at > NOW() - INTERVAL '${d} days'`,
            [sigName]);
          if (!probe.rows.length || (probe.rows[0].n_numeric === 0 && probe.rows[0].n_label === 0)) {
            return jsonResult({ error: `No data for signal "${sigName}" in the last ${d} days. Try one of: composite_score, rsi, rvol, analyst_consensus, analyst_upside_pct, insider_buys_60d, weekly_trend, drift_5d_pct, rs_score, rs_signal, guidance_signal, drift_direction.` }, true);
          }
          const useNumeric = probe.rows[0].n_numeric >= probe.rows[0].n_label;
          let buckets;
          if (useNumeric) {
            // Auto-bucket by quintile based on observed value range
            buckets = await dbQuery(`
              WITH q AS (
                SELECT
                  signal_value, ret_5d_pct, ret_10d_pct,
                  NTILE(5) OVER (ORDER BY signal_value) AS quintile
                FROM signal_returns
                WHERE signal_name = $1
                  AND scored_at > NOW() - INTERVAL '${d} days'
                  AND signal_value IS NOT NULL
                  AND ret_10d_pct IS NOT NULL
              )
              SELECT
                quintile,
                CONCAT('Q', quintile, ': ', ROUND(MIN(signal_value)::numeric, 2), ' to ', ROUND(MAX(signal_value)::numeric, 2)) AS range,
                COUNT(*)::int AS n,
                ROUND(AVG(ret_5d_pct)::numeric, 2)::float8  AS avg_5d_pct,
                ROUND(AVG(ret_10d_pct)::numeric, 2)::float8 AS avg_10d_pct,
                ROUND((COUNT(*) FILTER (WHERE ret_10d_pct > 0)::numeric / NULLIF(COUNT(ret_10d_pct), 0) * 100), 1)::float8 AS pct_up_10d
              FROM q GROUP BY quintile ORDER BY quintile`);
          } else {
            buckets = await dbQuery(`
              SELECT
                signal_label AS label,
                COUNT(*)::int AS n,
                ROUND(AVG(ret_5d_pct)::numeric, 2)::float8  AS avg_5d_pct,
                ROUND(AVG(ret_10d_pct)::numeric, 2)::float8 AS avg_10d_pct,
                ROUND((COUNT(*) FILTER (WHERE ret_10d_pct > 0)::numeric / NULLIF(COUNT(ret_10d_pct), 0) * 100), 1)::float8 AS pct_up_10d
              FROM signal_returns
              WHERE signal_name = $1
                AND scored_at > NOW() - INTERVAL '${d} days'
                AND signal_label IS NOT NULL
                AND ret_10d_pct IS NOT NULL
              GROUP BY 1 ORDER BY avg_10d_pct DESC NULLS LAST`,
              [sigName]);
          }
          return jsonResult({
            window_days: d,
            signal: sigName,
            type: useNumeric ? 'numeric (bucketed by quintile)' : 'label',
            composite_score_buckets: compositeBuckets.rows,
            signal_buckets: buckets.rows,
            interpretation: useNumeric
              ? 'Look at avg_10d_pct + pct_up_10d trending across quintiles. Monotonic increase = signal has positive forward edge. Flat across quintiles = noise. Reversed (high values → worse returns) = inverted signal (e.g. analyst_upside_pct).'
              : 'Compare each label\'s avg_10d_pct + pct_up_10d to overall baseline. Labels with materially higher returns = useful classifier; labels near baseline = noise.',
          });
        }

        // No specific signal — return the overview: composite buckets + top N signals by sample size.
        const topSignals = await dbQuery(`
          SELECT
            signal_name,
            COUNT(*)::int AS n_total,
            COUNT(ret_10d_pct)::int AS n_with_returns,
            ROUND(AVG(ret_5d_pct)::numeric, 2)::float8  AS avg_5d_pct,
            ROUND(AVG(ret_10d_pct)::numeric, 2)::float8 AS avg_10d_pct,
            ROUND((COUNT(*) FILTER (WHERE ret_10d_pct > 0)::numeric / NULLIF(COUNT(ret_10d_pct), 0) * 100), 1)::float8 AS pct_up_10d
          FROM signal_returns
          WHERE scored_at > NOW() - INTERVAL '${d} days'
          GROUP BY 1 ORDER BY n_with_returns DESC NULLS LAST LIMIT 15`);

        return jsonResult({
          window_days: d,
          composite_score_buckets: compositeBuckets.rows,
          all_signals_overview: topSignals.rows,
          interpretation: 'composite_score_buckets is the headline: confirms threshold-70 decision (40-49 bucket is sub-coin-flip). all_signals_overview shows per-signal sample sizes + flat avg returns — to see EDGE per signal, call this tool again with `signal="<name>"` (e.g. `signal="rsi"` or `signal="analyst_consensus"`).',
          hint: 'For per-signal edge analysis, call again with parameter `signal=<signal_name>` from the list. Try: rsi, analyst_consensus, analyst_upside_pct, insider_buys_60d, weekly_trend, drift_5d_pct.',
        });
      } catch (err) {
        return jsonResult({ error: `Signal edge query failed: ${err.message}` }, true);
      }
    }
  );

  server.tool(
    'hedge_recommendation',
    'Generate a specific covered-call hedge proposal for a held position. Computes strike (~10% OTM), expiry (~30 days), per-share premium (live UW option chain when available, Black-Scholes fallback), total premium across all 100-share blocks, breakeven price, "stays under strike" outcome, "called away" outcome, annualized yield on premium. Only suggests when position ≥ $5,000 AND ≥ 100 shares. Read-only — proposes only, never executes.',
    {
      symbol: z.string().describe('Symbol from your held positions to hedge.'),
    },
    async ({ symbol }) => {
      const sym = (symbol || '').trim().toUpperCase();
      if (!sym) return jsonResult({ error: 'symbol is required' }, true);
      let pos = null;

      // 1. Try Moomoo
      try {
        const m = await getMoomooPositions();
        const found = (m?.positions || []).find(p => p.symbol.toUpperCase() === sym);
        if (found) pos = { symbol: sym, qty: Number(found.qty), avg_cost: Number(found.avg_cost), current_price: Number(found.current_price), market_val: Number(found.market_val) };
      } catch { /* fall through */ }

      // 2. Try Alpaca paper
      if (!pos) {
        try {
          const a = await getAlpacaPositions();
          const found = (a || []).find(p => p.symbol.toUpperCase() === sym);
          if (found) pos = { symbol: sym, qty: Math.abs(Number(found.qty)), avg_cost: Number(found.avg_entry_price), current_price: Number(found.current_price), market_val: Number(found.market_value) };
        } catch { /* fall through */ }
      }

      // 3. Try Alpaca live
      if (!pos) {
        try {
          const a = await getLivePositions();
          const found = (a || []).find(p => p.symbol.toUpperCase() === sym);
          if (found) pos = { symbol: sym, qty: Math.abs(Number(found.qty)), avg_cost: Number(found.avg_entry_price), current_price: Number(found.current_price), market_val: Number(found.market_value) };
        } catch { /* nothing */ }
      }

      if (!pos) return jsonResult({ error: `${sym} not found in any connected broker (Moomoo, Alpaca paper, or Alpaca live) — must be a held position to hedge.` }, true);
      try { return jsonResult({ symbol: sym, position: pos, hedge: await advHedgeRecommendation(pos, 100) }); }
      catch (err) { return jsonResult({ error: `Hedge recommendation failed: ${err.message}` }, true); }
    }
  );

  server.tool(
    'get_regime_state',
    'Returns the current market regime (risk_on, neutral, risk_off, vol_spike) with SPY slope, distance from 50d MA, realized volatility proxy, and sector ETF relative strength leaders/laggers. Also returns the last 5 regime snapshots for trend context. Data is computed from backtest_prices (SPY + 11 sector ETFs). Use before making broad market calls, sizing decisions, or when the user asks "what is the market doing right now?"',
    {},
    async () => {
      const ok = await ensureDb();
      if (!ok) return jsonResult({ error: 'Database unavailable' }, true);
      try {
        const { getCurrentRegime } = await import('../core/regime-detector.js');
        const current = await getCurrentRegime();

        // Last 5 snapshots for history (including the current one)
        const { rows: history } = await dbQuery(
          `SELECT id, snapshot_at, regime, strength,
                  spy_slope_50d, spy_pct_from_50d, vix_proxy, vix_5d_change,
                  sector_leaders, sector_laggers, notes
           FROM regime_snapshots
           ORDER BY snapshot_at DESC
           LIMIT 5`
        );

        return jsonResult({
          current,
          history,
          interpretation: {
            risk_on:   'SPY trending up (slope >+0.05%/d), above 50d MA, low vol (<22). Favorable for long entries.',
            neutral:   'Mixed signals. No strong directional edge. Normal position sizing applies.',
            risk_off:  'SPY below 50d MA or declining slope. Bot still trades but reduce conviction thresholds.',
            vol_spike: 'Realized vol >35% annualized OR sudden +40% vol surge. Elevated risk — review all open positions.',
          },
        });
      } catch (err) {
        return jsonResult({ error: `Regime state query failed: ${err.message}` }, true);
      }
    }
  );
}
