/**
 * Layer 1 — Market Context Engine
 * Answers: "What kind of trading day is today and should we be trading?"
 * Fully deterministic — no Claude API calls (saves ~$0.002 per scan).
 */

import { getMarketSentiment, getSectorPerformance, getTrendingStocks, getMarketMovers } from './sentiment.js';
import { getEarningsCalendar } from './news.js';

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function timeET() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
}

export async function getMarketContext() {
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

  // ── Deterministic narrative (no API call) ────────────────────────────────────
  const topGainerStr  = movers?.gainers?.slice(0, 3).map(m => `${m.symbol} +${m.chg_pct?.toFixed(1)}%`).join(', ') || '';
  const topDeclinerStr= movers?.decliners?.slice(0, 2).map(m => `${m.symbol} ${m.chg_pct?.toFixed(1)}%`).join(', ') || '';
  const vixStr        = vix != null ? `VIX ${vix.toFixed(1)} (${vixTrend})` : 'VIX unknown';
  const sectorSummary = `${positiveSectors.length} sectors up, ${negativeSectors.length} down`;

  let market_narrative;
  if (!tradeable) {
    market_narrative = `Market is not tradeable: ${notTradeableReason}. ${vixStr}. ${sectorSummary}.`;
  } else if (direction === 'bullish') {
    market_narrative = `Bullish ${regime} market — ${sectorSummary}, ${vixStr}. ${topGainerStr ? `Leaders: ${topGainerStr}.` : ''}`;
  } else if (direction === 'bearish') {
    market_narrative = `Bearish pressure — ${sectorSummary}, ${vixStr}. ${topDeclinerStr ? `Decliners: ${topDeclinerStr}.` : ''} Defensive posture required.`;
  } else {
    market_narrative = `Mixed signals — ${sectorSummary}, ${vixStr}. ${regime} conditions, low directional conviction.`;
  }

  let best_hunting_ground;
  if (!tradeable) {
    best_hunting_ground = `Stay flat — ${notTradeableReason}.`;
  } else if (earningsToday.length > 0 && (regime === 'news-driven' || regime === 'volatile')) {
    const syms = earningsToday.slice(0, 3).map(e => e.symbol).join(', ');
    best_hunting_ground = `Best opportunity in earnings movers: ${syms}. Focus on post-announcement momentum with tight stops.`;
  } else if (leadingSectors.length > 0) {
    best_hunting_ground = `Best opportunity in leading sectors: ${leadingSectors.slice(0, 3).join(', ')}. Look for high-RS names pulling back to support.`;
  } else {
    best_hunting_ground = `Selective — scan for above-average volume and clear news catalysts. Keep positions small.`;
  }

  return {
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
}
