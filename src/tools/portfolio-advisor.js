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
      min_composite_score: 60, conviction_grade_min: 'C',
      market_cap_min_b: 5, price_min: 5, price_max: 500,
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
    'Run the bot\'s full decision engine on a single symbol. Returns one of 4 verdicts: BUY (passes all gates, composite ≥ 60), NEAR (within 10 points of threshold), BLOCKED (composite high enough but a hard gate fails), WATCH (below threshold). Also returns composite score, setup type (catalyst/breakout/momentum/value/mean_reversion), top 3 driver signals, and explicit blockers[] naming each failed gate (earnings_proximity, liquidity, conviction_grade, uw_label, etc.). Use whenever asked "would the bot buy X?" or "why didn\'t the bot trade X?".',
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
}
