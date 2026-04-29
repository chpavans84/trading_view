/**
 * Layer 2 — Intelligent Stock Selector
 * Takes market context from Layer 1 and finds the single best trade.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSymbolNews, getPreEarningsDrift } from './news.js';
import { getRelativeStrength } from './sentiment.js';
import { getChartTechnicals, isTradingViewAvailable } from './tradingview-bridge.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Filter out things we should never trade
function isValidSymbol(sym) {
  if (!sym || typeof sym !== 'string') return false;
  if (sym.includes('^') || sym.includes('=') || sym.includes('/')) return false;
  if (['SPY','QQQ','IWM','DIA','VXX','UVXY','SQQQ','TQQQ','SPXU','SPXL'].includes(sym)) return false;
  return sym.match(/^[A-Z]{1,5}$/);
}

function buildCandidates(context) {
  const { regime, _raw } = context;
  const movers   = _raw?.movers?.gainers  ?? [];
  const earnings = context.catalysts_today ?? [];
  const sectors  = _raw?.sectors          ?? [];

  const candidates = new Map(); // symbol → source weight

  if (regime === 'choppy') return [];

  if (regime === 'news-driven' || regime === 'volatile') {
    // Prioritise earnings catalysts
    earnings.forEach(e => { if (isValidSymbol(e.symbol)) candidates.set(e.symbol, (candidates.get(e.symbol) ?? 0) + 3); });
  }

  if (regime === 'trending' || regime === 'news-driven') {
    // Top gainers in leading sectors
    movers
      .filter(m => m.chg_pct > 0 && m.price >= 10 && m.price <= 600)
      .forEach(m => { if (isValidSymbol(m.symbol)) candidates.set(m.symbol, (candidates.get(m.symbol) ?? 0) + 2); });
  }

  if (regime === 'volatile') {
    // Oversold bounces — down 3–10% with potential reversal
    const decliners = _raw?.movers?.decliners ?? [];
    decliners
      .filter(m => m.chg_pct < -3 && m.chg_pct > -12 && m.price >= 10 && m.price <= 600)
      .forEach(m => { if (isValidSymbol(m.symbol)) candidates.set(m.symbol, (candidates.get(m.symbol) ?? 0) + 2); });
  }

  // Boost symbols in leading sectors (rough heuristic by known constituents)
  const leadingSymbolBoost = new Set(
    (context.leading_sectors ?? []).flatMap(etf => SECTOR_LEADERS[etf] ?? [])
  );
  candidates.forEach((w, sym) => {
    if (leadingSymbolBoost.has(sym)) candidates.set(sym, w + 1);
  });

  // Sort by weight, return top 8
  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([symbol]) => symbol);
}

// Representative leaders per sector ETF — used to boost sector-aligned candidates
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

export async function selectBestTrade({ context, positions = [] }) {
  if (context.regime === 'choppy') {
    return { symbol: null, no_trade_reason: 'Choppy market — no clean setups' };
  }

  const openSymbols  = new Set((positions ?? []).map(p => p.symbol));
  const rawCandidates = buildCandidates(context).filter(s => !openSymbols.has(s));

  if (!rawCandidates.length) {
    return { symbol: null, no_trade_reason: 'No candidates found matching current regime' };
  }

  // Fetch per-candidate data in parallel (max 8)
  const tvAvailable = await isTradingViewAvailable().catch(() => false);

  const candidateData = await Promise.all(
    rawCandidates.map(async symbol => {
      const [news, drift, relStr, technicals] = await Promise.allSettled([
        getSymbolNews({ symbol, limit: 3 }),
        getPreEarningsDrift({ symbol }),
        getRelativeStrength({ symbol }),
        tvAvailable ? getChartTechnicals({ symbol }) : Promise.resolve(null),
      ]).then(r => r.map(p => p.status === 'fulfilled' ? p.value : null));

      const headlines = news?.headlines?.slice(0, 2).map(h => h.title).join(' | ') ?? 'No recent news';
      const rs        = relStr?.relative_strength?.toFixed(1) ?? 'n/a';
      const rsi       = technicals?.rsi?.toFixed(0) ?? 'n/a';
      const macd_sig  = technicals?.macd_signal ?? 'n/a';
      const ema_trend = technicals?.ema_trend   ?? 'n/a';
      const drift_pct = drift?.drift_pct?.toFixed(1) ?? 'n/a';

      return { symbol, headlines, rs, rsi, macd_sig, ema_trend, drift_pct };
    })
  );

  // Format candidate table for Claude
  const candidateTable = candidateData.map(c =>
    `${c.symbol}: RS=${c.rs}% | RSI=${c.rsi} | MACD=${c.macd_sig} | EMA=${c.ema_trend} | Drift=${c.drift_pct}% | News: ${c.headlines}`
  ).join('\n');

  // Ask Claude Haiku to pick the best trade
  let result;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are a professional day trader making a single trade decision.

Today's market: ${context.market_narrative}
Best opportunity: ${context.best_hunting_ground}
Regime: ${context.regime} | Direction: ${context.direction} | VIX: ${context.vix}
Leading sectors: ${context.leading_sectors?.join(', ') || 'none'}
Avoid sectors: ${context.avoid_sectors?.join(', ') || 'none'}

Candidates (sorted by signal strength):
${candidateTable}

Rules:
- Only go LONG (buy) today unless direction is bearish
- Prefer stocks with strong relative strength, RSI 40–65 (not overbought), positive MACD
- Prefer stocks with a catalyst (earnings, news, sector momentum)
- If nothing looks good, say NO_TRADE with a reason

Return ONLY valid JSON — no markdown, no explanation:
{
  "symbol": "AAPL" or null,
  "reason": "2-sentence explanation of why this is the best trade right now",
  "conviction": 7,
  "entry_strategy": "Buy on next 1% pullback or break above $185",
  "risk_note": "Stop below $181 (yesterday's low / recent support)",
  "no_trade_reason": null
}`
      }],
    });

    const text = msg.content[0]?.text?.trim() ?? '';
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}');

    result = {
      symbol:               json.symbol ?? null,
      reason:               json.reason ?? '',
      conviction:           json.conviction ?? 5,
      entry_strategy:       json.entry_strategy ?? '',
      risk_note:            json.risk_note ?? '',
      candidates_considered: rawCandidates,
      no_trade_reason:      json.no_trade_reason ?? null,
    };
  } catch (err) {
    result = { symbol: null, no_trade_reason: `Selection error: ${err.message}`, candidates_considered: rawCandidates };
  }

  return result;
}
