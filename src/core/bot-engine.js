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

// ─── Single-flight guard per bot ──────────────────────────────────────────────
const _runningBots = new Set();

// ─── Public entrypoints ───────────────────────────────────────────────────────

export async function runBotScanForAllActive() {
  if (!isDbAvailable()) return { skipped: true, reason: 'no_db' };
  try {
    const { rows: bots } = await query(
      `SELECT * FROM bots WHERE status IN ('active','paused_today') ORDER BY id ASC`
    );
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

    // Bot already holding a trade — exits are managed by B-3
    if (bot.current_trade_id) {
      return await _log(bot.id, 'hold', null, null, null,
        `bot is holding trade #${bot.current_trade_id} — exits managed by B-3`);
    }

    // Circuit breaker
    const maxLoss = rules.risk?.max_loss_usd ?? 100;
    if (bot.cumulative_pnl_usd != null && Number(bot.cumulative_pnl_usd) <= -maxLoss) {
      if (bot.status !== 'stopped') {
        await query(
          `UPDATE bots SET status='stopped', status_message=$1, status_changed_at=NOW(), updated_at=NOW() WHERE id=$2`,
          [`Cumulative loss reached max_loss_usd ($${maxLoss})`, bot.id]
        );
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

    // 3. Score each candidate (cap at 30 per scan)
    const scored = [];
    for (const symbol of filtered.slice(0, 30)) {
      try {
        const result = await _scoreCandidate(symbol, bot);
        if (result) scored.push(result);
      } catch (e) {
        console.warn(`[bot-engine] bot ${bot.id} candidate ${symbol} score failed:`, e.message);
      }
    }

    if (!scored.length) {
      return await _log(bot.id, 'skip_filtered', null, null, null,
        `${filtered.length} candidates evaluated, none passed hard gates`);
    }

    // 4. Pick top scorer
    scored.sort((a, b) => b.composite - a.composite);
    const top = scored[0];
    const minScore = rules.entry_filters?.min_composite_score ?? 60;
    if (top.composite < minScore) {
      return await _log(bot.id, 'skip_no_candidate', top.symbol, top.composite, top.breakdown,
        `top score ${top.composite.toFixed(1)} below threshold ${minScore}`);
    }

    // 5. Log WOULD-TRADE decision — no actual trade placed
    return await _log(bot.id, 'buy', top.symbol, top.composite, top.breakdown,
      `WOULD BUY ${top.symbol} @ composite ${top.composite.toFixed(1)} (B-3 will execute)`);

  } catch (e) {
    console.error(`[bot-engine] scanBot(${bot.id}) error:`, e);
    return await _log(bot.id, 'skip_filtered', null, null, null, `scan error: ${e.message}`);
  } finally {
    _runningBots.delete(bot.id);
  }
}

// ─── Candidate universe ───────────────────────────────────────────────────────

async function _buildCandidateUniverse(bot) {
  const set = new Set();

  // Source A: bot owner's watchlist
  const ownerUsername = await _usernameForUserId(bot.user_id);
  if (ownerUsername) {
    const { rows: wl } = await query(
      `SELECT symbol FROM user_watchlist WHERE username=$1`,
      [ownerUsername]
    );
    wl.forEach(r => set.add(r.symbol.toUpperCase()));
  }

  // Source B: recent UW flow alerts (last 6 h, premium > $100k)
  const { rows: flow } = await query(
    `SELECT DISTINCT ticker FROM uw_flow_alerts
     WHERE alerted_at > NOW() - INTERVAL '6 hours'
       AND premium >= 100000
     LIMIT 30`
  );
  flow.forEach(r => set.add(r.ticker.toUpperCase()));

  // Source C: tickers with ≥3 positive news items in the last hour
  const { rows: news } = await query(
    `SELECT DISTINCT t.ticker
     FROM benzinga_news bn,
          jsonb_array_elements_text(bn.tickers) AS t(ticker)
     WHERE bn.published_at > NOW() - INTERVAL '1 hour'
       AND bn.sentiment = 'positive'
     GROUP BY t.ticker
     HAVING COUNT(*) >= 3
     LIMIT 20`
  );
  news.forEach(r => set.add(r.ticker.toUpperCase()));

  return [...set];
}

async function _usernameForUserId(userId) {
  const { rows } = await query(`SELECT username FROM users WHERE id=$1`, [userId]);
  return rows[0]?.username ?? null;
}

async function _getHeldSymbolsForUser(userId, excludeBotId) {
  const { rows } = await query(
    `SELECT t.symbol
     FROM bots b
     JOIN trades t ON t.id = b.current_trade_id
     WHERE b.user_id=$1 AND b.id<>$2 AND b.current_trade_id IS NOT NULL`,
    [userId, excludeBotId]
  );
  return new Set(rows.filter(r => r.symbol).map(r => r.symbol.toUpperCase()));
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
//
// Each signal returns a value in [-100, +100].
// Composite = Σ(weight_i × signal_i.value), also in [-100, +100].
// BOT_DEFAULT_RULES weights sum to 1.0; min_composite_score default 60.

async function _scoreCandidate(symbol, bot) {
  const rules   = bot.rules   || {};
  const filters = rules.entry_filters || {};

  // ── Hard gates ──────────────────────────────────────────────────────────
  const ind = await getAllBotIndicators(symbol).catch(() => null);

  // Earnings proximity
  const earnDays = ind?.earnings?.days_until;
  if (filters.avoid_earnings_within_days != null &&
      earnDays != null && earnDays >= 0 &&
      earnDays < filters.avoid_earnings_within_days) return null;

  // Liquidity
  const adv = ind?.liquidity?.adv_dollar_vol_30d;
  if (filters.min_adv_dollar_vol != null && adv != null &&
      adv < filters.min_adv_dollar_vol) return null;

  // Macro blackout
  if (filters.skip_during_macro_blackout && ind?.macro?.in_blackout) return null;

  // Premarket gap
  const gapPct = ind?.premarket?.gap_pct;
  if (filters.avoid_premarket_gap_above_pct != null && gapPct != null &&
      Math.abs(gapPct) > filters.avoid_premarket_gap_above_pct) return null;

  // Short interest
  if (filters.skip_high_short_interest &&
      ind?.short_interest?.short_pct_float > 0.30) return null;

  // Price range
  const lastPrice = ind?.liquidity?.last_price;
  if (lastPrice != null) {
    if (filters.price_min != null && lastPrice < filters.price_min) return null;
    if (filters.price_max != null && lastPrice > filters.price_max) return null;
  }

  // VIX regime
  const vix = await _getCurrentVix();
  if (filters.vix_min != null && vix != null && vix < filters.vix_min) return null;
  if (filters.vix_max != null && vix != null && vix > filters.vix_max) return null;

  // ── Signal computation ──────────────────────────────────────────────────
  const [convSig, newsSig, uwSig, gexSig, insiderSig, dist52wSig, predSig] = await Promise.all([
    _signalConviction(symbol),
    _signalNews(symbol),
    _signalUw(symbol),
    _signalGex(symbol),
    _signalInsider(symbol),
    _signalDistance52w(symbol),
    _signalPredictor(symbol),
  ]);

  const signals = {
    conviction:   convSig,
    news:         newsSig,
    uw_options:   uwSig,
    gex:          gexSig,
    insider:      insiderSig,
    distance_52w: dist52wSig,
    predictor:    predSig,
  };

  // Conviction grade gate
  const gradeMin = filters.conviction_grade_min;
  if (gradeMin && convSig.grade) {
    const order = { A: 4, B: 3, C: 2, F: 1 };
    if ((order[convSig.grade] ?? 0) < (order[gradeMin] ?? 0)) return null;
  }

  // UW label required
  if (Array.isArray(filters.require_uw_label_any) && filters.require_uw_label_any.length) {
    if (!filters.require_uw_label_any.includes(uwSig.label)) return null;
  }

  // News sentiment floor
  if (filters.require_news_sentiment_min) {
    const order = { negative: 0, neutral: 1, positive: 2 };
    const reqMin = order[filters.require_news_sentiment_min];
    const got    = order[newsSig.label];
    if (got == null || got < reqMin) return null;
  }

  // ── Composite score ─────────────────────────────────────────────────────
  const w = rules.composite_weights || {};
  const composite =
    (w.conviction   ?? 0) * (signals.conviction.value   ?? 0) +
    (w.news         ?? 0) * (signals.news.value         ?? 0) +
    (w.uw_options   ?? 0) * (signals.uw_options.value   ?? 0) +
    (w.gex          ?? 0) * (signals.gex.value          ?? 0) +
    (w.insider      ?? 0) * (signals.insider.value      ?? 0) +
    (w.distance_52w ?? 0) * (signals.distance_52w.value ?? 0) +
    (w.predictor    ?? 0) * (signals.predictor.value    ?? 0);

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

  return {
    symbol,
    composite: +composite.toFixed(2),
    breakdown: {
      vix,
      signals,
      weights: w,
      suggested_size_usd: +suggested_size_usd.toFixed(2),
      indicators: ind,
    },
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
  const c     = await getUwConvictionForSymbol(symbol).catch(() => null);
  const label = c?.composite?.label ?? 'no_data';
  const score = c?.composite?.score;
  if (label === 'no_data' || score == null) return { value: 0, label };
  const sign = (label === 'bullish' || label === 'strong_bullish')  ?  1
             : (label === 'bearish' || label === 'strong_bearish')  ? -1
             : 0;
  return { value: +(sign * score * 100).toFixed(1), label };
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
  // uw_insider_trades uses transaction_type ('buy'/'sell'), not a 'side' column
  const { rows } = await query(
    `SELECT
       SUM(CASE WHEN transaction_type='buy'  THEN value ELSE 0 END) AS buy_val,
       SUM(CASE WHEN transaction_type='sell' THEN value ELSE 0 END) AS sell_val
     FROM uw_insider_trades
     WHERE ticker=$1 AND filed_at > NOW() - INTERVAL '30 days'`,
    [symbol]
  );
  const buy  = Number(rows[0]?.buy_val)  || 0;
  const sell = Number(rows[0]?.sell_val) || 0;
  if (buy + sell === 0) return { value: 0, buy_usd: 0, sell_usd: 0 };
  const net   = buy - sell;
  const total = buy + sell;
  return { value: +((net / total) * 100).toFixed(1), buy_usd: buy, sell_usd: sell };
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
  // Backtest sweet spot: 20-40% off the 52w high
  let value;
  if      (pctOff > -0.05) value = -40;  // within 5% of high — extended
  else if (pctOff > -0.20) value =  30;  // 5-20% off
  else if (pctOff > -0.40) value =  80;  // 20-40% off — sweet spot
  else                     value = -60;  // >40% off — distressed
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

async function _getCurrentVix() {
  const { rows } = await query(
    `SELECT close FROM backtest_prices
     WHERE symbol IN ('^VIX','VIX') ORDER BY price_date DESC LIMIT 1`
  );
  return rows[0] ? Number(rows[0].close) : null;
}

// ─── Decision logger ──────────────────────────────────────────────────────────

async function _log(botId, action, symbol, composite, factor_breakdown, notes) {
  try {
    await query(
      `INSERT INTO bot_decisions
         (bot_id, action, symbol, composite_score, factor_breakdown, notes)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [botId, action, symbol, composite,
       factor_breakdown ? JSON.stringify(factor_breakdown) : null, notes]
    );
  } catch (e) {
    console.error('[bot-engine] log failed:', e.message);
  }
  return { action, symbol, composite, notes };
}

// ─── Cron registration ────────────────────────────────────────────────────────

export function startBotEngineCrons() {
  const TZ = { timezone: 'America/New_York' };
  // 9:30–9:59 ET on :30 past then every 5 min
  cron.schedule('30/5 9 * * 1-5', () => runBotScanForAllActive(), TZ);
  // 10:00–15:59 ET every 5 min
  cron.schedule('*/5 10-15 * * 1-5', () => runBotScanForAllActive(), TZ);
  console.log('[bot-engine] crons scheduled — scanning every 5 min during market hours');
}
