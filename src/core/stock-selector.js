/**
 * Layer 2 — Intelligent Stock Selector
 * Takes market context from Layer 1 and finds the single best trade.
 * Fully deterministic — no LLM calls.
 */

import { getSymbolNews, getPreEarningsDrift } from './news.js';
import { getRelativeStrength, SECTOR_MAP } from './sentiment.js';
import { getChartTechnicals, isTradingViewAvailable } from './tradingview-bridge.js';

// Filter out things we should never trade
function isValidSymbol(sym) {
  if (!sym || typeof sym !== 'string') return false;
  if (sym.includes('^') || sym.includes('=') || sym.includes('/')) return false;
  if (['SPY','QQQ','IWM','DIA','VXX','UVXY','SQQQ','TQQQ','SPXU','SPXL'].includes(sym)) return false;
  return sym.match(/^[A-Z]{1,5}$/);
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

function scoreCandidate({ symbol, data, context }) {
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

  // Fetch per-candidate data in parallel
  const candidateData = await Promise.all(
    rawCandidates.map(async symbol => {
      const [newsRes, driftRes, rsRes, techRes] = await Promise.allSettled([
        getSymbolNews({ symbol, limit: 3 }),
        getPreEarningsDrift({ symbol }),
        getRelativeStrength({ symbol }),
        tvAvailable ? getChartTechnicals({ symbol }) : Promise.resolve(null),
      ]);

      const news  = newsRes.status  === 'fulfilled' ? newsRes.value  : null;
      const drift = driftRes.status === 'fulfilled' ? driftRes.value : null;
      const rs    = rsRes.status    === 'fulfilled' ? rsRes.value    : null;
      const tech  = techRes.status  === 'fulfilled' ? techRes.value  : null;

      return { symbol, news, drift, rs, tech };
    })
  );

  // Score all candidates
  const scored = candidateData.map(data => ({
    ...data,
    score: scoreCandidate({ symbol: data.symbol, data, context }),
  })).sort((a, b) => b.score - a.score);

  const best = scored[0];

  // Require minimum conviction
  if (!best || best.score < 45) {
    return {
      symbol: null,
      no_trade_reason: `No candidate met minimum conviction threshold (best: ${best?.symbol ?? 'none'} at ${best?.score ?? 0}/100)`,
      candidates_considered: rawCandidates,
    };
  }

  const headline = best.news?.headlines?.[0]?.title ?? null;

  return {
    symbol:               best.symbol,
    reason:               buildReason(best.symbol, best.score, best),
    conviction:           best.score,
    entry_strategy:       `Buy ${best.symbol} on momentum confirmation`,
    risk_note:            best.tech?.current_price ? `Stop below recent support (~${(best.tech.current_price * 0.97).toFixed(2)})` : 'Use 2–3% stop below entry',
    candidates_considered: rawCandidates,
    no_trade_reason:      null,
    top_candidates:       scored.slice(0, 3).map(c => ({ symbol: c.symbol, score: c.score })),
  };
}
