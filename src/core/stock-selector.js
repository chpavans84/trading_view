/**
 * Layer 2 — Intelligent Stock Selector
 * Takes market context from Layer 1 and finds the single best trade.
 * Scoring: deterministic indicators → ML conviction → Claude Haiku judgment → blended result.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSymbolNews, getPreEarningsDrift } from './news.js';
import { getRelativeStrength, SECTOR_MAP } from './sentiment.js';
import { getChartTechnicals, isTradingViewAvailable } from './tradingview-bridge.js';
import { getPerformancePatterns } from './db.js';
import { getConvictionScore } from './scoring.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Filter out things we should never trade
function isValidSymbol(sym) {
  if (!sym || typeof sym !== 'string') return false;
  if (sym.includes('^') || sym.includes('=') || sym.includes('/')) return false;
  if (['SPY','QQQ','IWM','DIA','VXX','UVXY','SQQQ','TQQQ','SPXU','SPXL'].includes(sym)) return false;
  return sym.match(/^[A-Z]{1,5}$/);
}

// ─── Performance patterns cache (30-min TTL) ──────────────────────────────────
let _patterns = [];
let _patternTs = 0;

async function loadPatterns() {
  if (Date.now() - _patternTs < 30 * 60 * 1000) return _patterns;
  _patterns = await getPerformancePatterns().catch(() => []);
  _patternTs = Date.now();
  return _patterns;
}

function buildCandidates(context, watchlist = []) {
  const { regime, _raw } = context;
  const movers   = _raw?.movers?.gainers  ?? [];
  const earnings = context.catalysts_today ?? [];

  const candidates = new Map(); // symbol → source weight

  if (regime === 'choppy') return [];

  watchlist.forEach(sym => {
    if (isValidSymbol(sym)) candidates.set(sym, (candidates.get(sym) ?? 0) + 1);
  });

  if (regime === 'news-driven' || regime === 'volatile') {
    earnings.forEach(e => { if (isValidSymbol(e.symbol)) candidates.set(e.symbol, (candidates.get(e.symbol) ?? 0) + 3); });
  }

  if (regime === 'trending' || regime === 'news-driven') {
    movers
      .filter(m => m.chg_pct > 0 && m.price >= 10 && m.price <= 600)
      .forEach(m => { if (isValidSymbol(m.symbol)) candidates.set(m.symbol, (candidates.get(m.symbol) ?? 0) + 2); });
  }

  if (regime === 'volatile') {
    const decliners = _raw?.movers?.decliners ?? [];
    decliners
      .filter(m => m.chg_pct < -3 && m.chg_pct > -12 && m.price >= 10 && m.price <= 600)
      .forEach(m => { if (isValidSymbol(m.symbol)) candidates.set(m.symbol, (candidates.get(m.symbol) ?? 0) + 2); });
  }

  const leadingSymbolBoost = new Set(
    (context.leading_sectors ?? []).flatMap(etf => SECTOR_LEADERS[etf] ?? [])
  );
  candidates.forEach((w, sym) => {
    if (leadingSymbolBoost.has(sym)) candidates.set(sym, w + 1);
  });

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([symbol]) => symbol);
}

const SECTOR_LEADERS = {
  XLK:  ['AAPL','MSFT','NVDA','AVGO','AMD','QCOM','TXN','MU'],
  XLF:  ['JPM','BAC','GS','MS','WFC','BRK.B','C','AXP'],
  XLY:  ['AMZN','TSLA','HD','MCD','NKE','LOW','TGT','SBUX'],
  XLC:  ['GOOGL','META','NFLX','DIS','T','VZ','CHTR','ATVI'],
  XLV:  ['UNH','JNJ','LLY','ABBV','PFE','MRK','TMO','ABT'],
  XLI:  ['GE','CAT','HON','UNP','RTX','LMT','BA','DE'],
  XLE:  ['XOM','CVX','COP','SLB','EOG','PXD','OXY','HAL'],
  XLB:  ['LIN','SHW','APD','ECL','NEM','FCX','NUE','CF'],
  XLP:  ['PG','KO','PEP','WMT','COST','PM','MO','CL'],
  XLRE: ['PLD','AMT','EQIX','SPG','O','DLR','PSA','VICI'],
  XLU:  ['NEE','DUK','SO','D','AEP','EXC','SRE','PCG'],
  GLD:  ['GLD','GDX','GOLD','NEM'],
};

async function scoreCandidate({ symbol, data, context }) {
  let score = 0;
  const { regime, leading_sectors } = context;
  const { rs, tech, drift, news } = data;

  // Relative strength
  if (rs?.signal === 'strong') score += 20;
  if (rs?.signal === 'weak')   score -= 15;

  // RSI
  const rsi = tech?.rsi;
  if (rsi != null) {
    if (rsi >= 40 && rsi <= 65) score += 15;
    if (rsi > 75)               score -= 20;
    if (rsi < 30)               score += 10;
  }

  // MACD histogram
  if (tech?.macd_hist != null) {
    if (tech.macd_hist > 0) score += 10;
    if (tech.macd_hist < 0) score -= 10;
  }

  // EMA trend
  if (tech?.current_price != null && tech?.ema20 != null && tech?.ema50 != null) {
    if (tech.current_price > tech.ema20 && tech.current_price > tech.ema50) score += 15;
    if (tech.current_price < tech.ema20 && tech.current_price < tech.ema50) score -= 15;
  }

  // Pre-earnings drift
  if (drift?.drift_direction === 'up')   score += 10;
  if (drift?.drift_direction === 'down') score -= 10;

  // Sector alignment
  const stockSector = SECTOR_MAP[symbol];
  if (stockSector && leading_sectors.includes(stockSector)) score += 15;

  // Guidance
  if (news?.guidance_signal === 'raised')  score += 10;
  if (news?.guidance_signal === 'lowered') score -= 15;

  // Choppy market penalty
  if (regime === 'choppy') score -= 30;

  // Regime performance adjustment — based on actual historical win rates
  const patterns = await loadPatterns();
  const match = patterns.find(p => p.regime === regime);
  if (match && match.trades >= 5) {
    if (match.win_rate < 40) {
      score -= 10;
    } else if (match.win_rate > 65) {
      score += 8;
    }
  }

  return Math.max(0, Math.min(100, score + 30));
}

function buildReason(symbol, score, data) {
  const parts = [];
  if (data.rs?.signal === 'strong')
    parts.push(`outperforming sector by ${data.rs.rs_score?.toFixed(1) ?? '?'}%`);
  if (data.tech?.rsi != null && data.tech.rsi >= 40 && data.tech.rsi <= 65)
    parts.push(`RSI at ${data.tech.rsi.toFixed(0)} — not extended`);
  if (data.tech?.macd_hist != null && data.tech.macd_hist > 0)
    parts.push('MACD positive momentum');
  if (data.drift?.drift_direction === 'up')
    parts.push('positive pre-earnings drift');
  if (data.news?.guidance_signal === 'raised')
    parts.push('guidance raised');
  return parts.length > 0
    ? `${symbol}: ${parts.join(', ')}.`
    : `${symbol} scores ${score}/100 across technical and momentum factors.`;
}

export async function selectBestTrade({ context, positions = [], blocked_symbols = [], watchlist = [] }) {
  if (context.regime === 'choppy') {
    return { symbol: null, no_trade_reason: 'Choppy market — no clean setups' };
  }

  const openSymbols   = new Set((positions ?? []).map(p => p.symbol));
  const blockedSet    = new Set((blocked_symbols ?? []).map(s => s.toUpperCase()));
  const rawCandidates = buildCandidates(context, watchlist)
    .filter(s => !openSymbols.has(s) && !blockedSet.has(s));

  if (!rawCandidates.length) {
    return { symbol: null, no_trade_reason: 'No candidates found matching current regime' };
  }

  const tvAvailable = await isTradingViewAvailable().catch(() => false);

  // Fetch per-candidate data in parallel (news + drift + RS + technicals + ML conviction)
  const candidateData = await Promise.all(
    rawCandidates.map(async symbol => {
      const [news, drift, rs, tech, convScore] = await Promise.allSettled([
        getSymbolNews({ symbol, limit: 3 }),
        getPreEarningsDrift({ symbol }),
        getRelativeStrength({ symbol }),
        tvAvailable ? getChartTechnicals({ symbol }) : Promise.resolve(null),
        getConvictionScore({ symbol, positions: [] }),
      ]).then(r => r.map(p => p.status === 'fulfilled' ? p.value : null));

      const mlScore     = convScore?.score ?? null;
      const mlGrade     = convScore?.grade ?? 'n/a';
      const backtestAdj = convScore?.breakdown?.backtest_alpha_adj ?? 0;

      // Extract flat fields for candidateTable
      const headlines = (news?.headlines ?? []).map(h => h.title).slice(0, 2).join(' | ') || 'none';
      const rsVal     = rs?.rs_score != null ? rs.rs_score.toFixed(1) : 'n/a';
      const rsi       = tech?.rsi != null ? tech.rsi.toFixed(0) : 'n/a';
      const macd_sig  = tech?.macd_hist != null ? (tech.macd_hist > 0 ? 'positive' : 'negative') : 'n/a';
      const ema_trend = (tech?.current_price != null && tech?.ema20 != null && tech?.ema50 != null)
        ? (tech.current_price > tech.ema20 && tech.current_price > tech.ema50 ? 'above' : 'below')
        : 'n/a';
      const drift_pct = drift?.drift_pct != null ? drift.drift_pct.toFixed(1) : '0';

      return { symbol, news, drift, rs, tech, mlScore, mlGrade, backtestAdj, headlines, rsVal, rsi, macd_sig, ema_trend, drift_pct };
    })
  );

  // Score all candidates with the deterministic scorer
  const scored = (await Promise.all(candidateData.map(async data => ({
    ...data,
    score: await scoreCandidate({ symbol: data.symbol, data, context }),
  })))).sort((a, b) => b.score - a.score);

  const best = scored[0];

  // Require minimum conviction
  if (!best || best.score < 45) {
    return {
      symbol: null,
      no_trade_reason: `No candidate met minimum conviction threshold (best: ${best?.symbol ?? 'none'} at ${best?.score ?? 0}/100)`,
      candidates_considered: rawCandidates,
    };
  }

  // ── Claude Haiku final judgment ────────────────────────────────────────────
  // Build a compact candidate table (top 6 by deterministic score)
  const topCandidates = scored.slice(0, 6);
  const candidateTable = topCandidates.map(c =>
    `${c.symbol}: ML=${c.mlScore ?? 'n/a'}(${c.mlGrade}) BacktestAdj=${c.backtestAdj > 0 ? '+' : ''}${c.backtestAdj} | RS=${c.rsVal}% | RSI=${c.rsi} | MACD=${c.macd_sig} | EMA=${c.ema_trend} | Drift=${c.drift_pct}% | News: ${c.headlines}`
  ).join('\n');

  const prompt = `You are a systematic trading bot selecting the single best intraday trade setup.

Market regime: ${context.regime}
VIX: ${context.vix ?? 'unknown'}
Leading sectors: ${(context.leading_sectors ?? []).join(', ') || 'none'}

Candidates (sorted by deterministic score):
${candidateTable}

Rules:
- Pick exactly ONE symbol or say NO_TRADE.
- ML Score is backtested conviction (0–100 adjusted by 3 years of historical data). Prefer stocks with ML Score >= 65 and positive BacktestAdj.
- BacktestAdj is the historical alpha adjustment: positive means this grade historically outperforms SPY, negative means it underperforms.
- Prefer RSI 40–65 (not extended), MACD positive, EMA above, RS positive.
- Avoid if ML Score < 40 or BacktestAdj <= -5.
- In volatile regime, smaller positions preferred.
- Respond with JSON only: { "symbol": "TICKER", "conviction": 0-100, "reason": "one sentence" }
  or { "symbol": null, "conviction": 0, "reason": "why no trade" }`;

  let result = { symbol: best.symbol, conviction: best.score, reason: buildReason(best.symbol, best.score, best) };

  try {
    const ctrl    = new AbortController();
    const timer   = setTimeout(() => ctrl.abort(), 20_000);
    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages:   [{ role: 'user', content: prompt }],
    });
    clearTimeout(timer);

    const raw  = message.content?.[0]?.text?.trim() ?? '';
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (json) {
      const parsed = JSON.parse(json);
      if (parsed.symbol && isValidSymbol(parsed.symbol)) {
        result.symbol    = parsed.symbol;
        result.conviction = Math.max(0, Math.min(100, Number(parsed.conviction) || best.score));
        result.reason    = parsed.reason || result.reason;
      } else if (parsed.symbol === null) {
        return { symbol: null, no_trade_reason: parsed.reason || 'Claude Haiku: no clean setup', candidates_considered: rawCandidates };
      }
    }
  } catch {
    // Haiku offline or timed out — keep deterministic result
  }

  // ── Blend conviction: 60% ML score + 40% Claude judgment ──────────────────
  if (result.symbol) {
    const candidate = candidateData.find(c => c.symbol === result.symbol);
    if (candidate?.mlScore != null) {
      result.conviction   = Math.round(0.6 * candidate.mlScore + 0.4 * result.conviction);
      result.ml_score     = candidate.mlScore;
      result.ml_grade     = candidate.mlGrade;
      result.backtest_adj = candidate.backtestAdj;
    }
  }

  return {
    symbol:               result.symbol,
    reason:               result.reason,
    conviction:           result.conviction,
    ml_score:             result.ml_score ?? null,
    ml_grade:             result.ml_grade ?? null,
    backtest_adj:         result.backtest_adj ?? null,
    entry_strategy:       `Buy ${result.symbol} on momentum confirmation`,
    risk_note:            best.tech?.current_price ? `Stop below recent support (~${(best.tech.current_price * 0.97).toFixed(2)})` : 'Use 2–3% stop below entry',
    candidates_considered: rawCandidates,
    no_trade_reason:      null,
    top_candidates:       scored.slice(0, 3).map(c => ({ symbol: c.symbol, score: c.score, ml_score: c.mlScore, ml_grade: c.mlGrade })),
  };
}
