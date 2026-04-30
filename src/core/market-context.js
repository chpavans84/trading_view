/**
 * Layer 1 — Market Context Engine
 * Answers: "What kind of trading day is today and should we be trading?"
 * Fully deterministic — no LLM calls.
 */

import { getMarketSentiment, getSectorPerformance, getTrendingStocks, getMarketMovers } from './sentiment.js';
import { getEarningsCalendar } from './news.js';

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function timeET() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
}

function buildMarketNarrative({ regime, direction, vix, vix_trend, leading_sectors, avoid_sectors, catalysts_today }) {
  const regimeDesc = {
    trending:      'Market is trending with clear direction.',
    volatile:      'Market is volatile with wide swings.',
    'news-driven': 'Market is catalyst-driven — earnings and news moving stocks.',
    choppy:        'Market is choppy with no clear direction. Avoiding new entries.',
  }[regime] || 'Market conditions are mixed.';

  const directionDesc = direction === 'bullish'
    ? `Bias is bullish — ${leading_sectors.slice(0, 2).join(', ')} leading.`
    : direction === 'bearish'
    ? `Bias is bearish — ${avoid_sectors.slice(0, 2).join(', ')} lagging.`
    : 'No clear directional bias.';

  const vixDesc = vix ? `VIX at ${vix.toFixed(1)} and ${vix_trend}.` : '';

  const catalystDesc = catalysts_today.length > 0
    ? `Key catalysts: ${catalysts_today.slice(0, 3).map(c => c.symbol).join(', ')} reporting today.`
    : '';

  return [regimeDesc, directionDesc, vixDesc, catalystDesc].filter(Boolean).join(' ');
}

function buildHuntingGround({ regime, direction, leading_sectors }) {
  if (regime === 'choppy') return 'Staying flat — no clear setup today.';
  if (regime === 'news-driven') return 'Focus on earnings catalysts and high-volume movers with news.';
  if (regime === 'volatile' && direction === 'bullish')
    return `Look for oversold bounces in ${leading_sectors[0] || 'leading'} sector.`;
  if (regime === 'trending' && direction === 'bullish')
    return `Momentum plays in ${leading_sectors.slice(0, 2).join(' and ')} sector.`;
  if (direction === 'bearish') return 'Defensive posture — only short setups or stay flat.';
  return 'Selective entries only — wait for high-conviction setups.';
}

let _contextCache = null;
let _contextCacheTs = 0;
const CONTEXT_TTL = 15 * 60 * 1000;

export async function getMarketContext() {
  if (_contextCache && Date.now() - _contextCacheTs < CONTEXT_TTL) {
    return { ..._contextCache, cached: true };
  }

  // Fetch all data in parallel
  const [sentiment, sectors, trending, movers, earnings] = await Promise.allSettled([
    getMarketSentiment(),
    getSectorPerformance(),
    getTrendingStocks({ limit: 20 }),
    getMarketMovers(),
    getEarningsCalendar({ date: todayET(), limit: 30 }),
  ]).then(r => r.map(p => p.status === 'fulfilled' ? p.value : null));

  const vix        = sentiment?.vix?.value ?? null;
  const vixChgPct  = sentiment?.vix?.change_pct ?? null;
  const sectorList = sectors?.sectors ?? [];

  // ── VIX trend ────────────────────────────────────────────────────────────────
  const vixTrend = vixChgPct == null ? 'flat'
    : vixChgPct >  5 ? 'rising'
    : vixChgPct < -5 ? 'falling'
    : 'flat';

  // ── Sector agreement ──────────────────────────────────────────────────────────
  const positiveSectors = sectorList.filter(s => s.chg_pct > 0);
  const negativeSectors = sectorList.filter(s => s.chg_pct < 0);
  const leadingSectors  = sectorList.filter(s => s.chg_pct > 0.3).map(s => s.symbol).slice(0, 4);
  const avoidSectors    = sectorList.filter(s => s.chg_pct < -0.3).map(s => s.symbol).slice(0, 3);

  // ── Earnings catalysts ────────────────────────────────────────────────────────
  const earningsToday = (Array.isArray(earnings) ? earnings : earnings?.earnings ?? [])
    .filter(e => e.symbol && e.symbol.match(/^[A-Z]{1,5}$/))
    .slice(0, 10)
    .map(e => ({ symbol: e.symbol, type: 'earnings', detail: `Reports ${e.time || 'today'}` }));

  // ── Tradeable rules ───────────────────────────────────────────────────────────
  let notTradeableReason = null;

  if (vix != null && vix > 35)
    notTradeableReason = `VIX at ${vix} — extreme fear, risk too high`;
  else if (vixChgPct != null && vixChgPct > 15)
    notTradeableReason = `VIX spiking ${vixChgPct.toFixed(1)}% today — panic selling in progress`;
  else if (sectorList.length >= 6 && positiveSectors.length === 0)
    notTradeableReason = 'All sectors negative — broad market selloff, no longs today';
  else if (sectorList.length >= 6 && positiveSectors.length < 3 && negativeSectors.length < 3)
    notTradeableReason = 'No clear market direction — fewer than 3 sectors agree';

  const tradeable = notTradeableReason === null;

  // ── Regime ───────────────────────────────────────────────────────────────────
  let regime;
  if (earningsToday.length >= 3 && movers?.movers?.some(m => Math.abs(m.chg_pct) > 5))
    regime = 'news-driven';
  else if (positiveSectors.length >= 5 && (vix == null || vix < 20))
    regime = 'trending';
  else if (vix != null && vix >= 20 && vix <= 35)
    regime = 'volatile';
  else
    regime = 'choppy';

  // ── Direction ────────────────────────────────────────────────────────────────
  const direction = positiveSectors.length >= negativeSectors.length + 3 ? 'bullish'
    : negativeSectors.length >= positiveSectors.length + 3 ? 'bearish'
    : 'neutral';

  // ── Confidence ───────────────────────────────────────────────────────────────
  const confidence = positiveSectors.length >= 7 || negativeSectors.length >= 7 ? 'high'
    : positiveSectors.length >= 4 || negativeSectors.length >= 4 ? 'medium'
    : 'low';

  // ── Deterministic narrative (no LLM) ─────────────────────────────────────────
  const market_narrative    = buildMarketNarrative({ regime, direction, vix, vix_trend: vixTrend, leading_sectors: leadingSectors, avoid_sectors: avoidSectors, catalysts_today: earningsToday });
  const best_hunting_ground = tradeable ? buildHuntingGround({ regime, direction, leading_sectors: leadingSectors }) : 'Stay flat today.';

  const ctx = {
    tradeable,
    regime,
    direction,
    confidence,
    leading_sectors: leadingSectors,
    avoid_sectors:   avoidSectors,
    vix,
    vix_trend:       vixTrend,
    catalysts_today: earningsToday,
    market_narrative,
    best_hunting_ground,
    not_tradeable_reason: notTradeableReason,
    _raw: { sentiment, sectors: sectorList, movers },
  };
  _contextCache = ctx;
  _contextCacheTs = Date.now();
  return ctx;
}
