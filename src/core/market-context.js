/**
 * Layer 1 — Market Context Engine
 * Answers: "What kind of trading day is today and should we be trading?"
 */

import Anthropic from '@anthropic-ai/sdk';
import { getMarketSentiment, getSectorPerformance, getTrendingStocks, getMarketMovers } from './sentiment.js';
import { getEarningsCalendar } from './news.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

  // ── Claude writes the narrative ───────────────────────────────────────────────
  let market_narrative = '';
  let best_hunting_ground = '';

  try {
    const rawData = {
      vix, vixChgPct, vixTrend,
      positiveSectors: positiveSectors.map(s => `${s.symbol} +${s.chg_pct?.toFixed(2)}%`).join(', '),
      negativeSectors: negativeSectors.map(s => `${s.symbol} ${s.chg_pct?.toFixed(2)}%`).join(', '),
      topMovers: movers?.gainers?.slice(0, 5).map(m => `${m.symbol} +${m.chg_pct?.toFixed(1)}%`).join(', '),
      bigDecliners: movers?.decliners?.slice(0, 3).map(m => `${m.symbol} ${m.chg_pct?.toFixed(1)}%`).join(', '),
      earningsToday: earningsToday.map(e => e.symbol).join(', ') || 'none',
      regime, direction, tradeable, notTradeableReason,
      timeET: timeET(),
    };

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are a professional day trader. Based on this market data, write:
1. market_narrative: 2-3 sentences describing what the market is doing RIGHT NOW and why
2. best_hunting_ground: 1-2 sentences on where the best trades are today (or "Stay flat" if not tradeable)

Market data at ${rawData.timeET} ET:
- VIX: ${rawData.vix} (${rawData.vixTrend}, ${rawData.vixChgPct?.toFixed(1)}% today)
- Leading sectors: ${rawData.positiveSectors || 'none'}
- Lagging sectors: ${rawData.negativeSectors || 'none'}
- Top movers: ${rawData.topMovers || 'none'}
- Big decliners: ${rawData.bigDecliners || 'none'}
- Earnings today: ${rawData.earningsToday}
- Regime: ${rawData.regime} | Direction: ${rawData.direction}
${rawData.notTradeableReason ? `- NOT TRADEABLE: ${rawData.notTradeableReason}` : ''}

Return ONLY valid JSON: {"market_narrative":"...","best_hunting_ground":"..."}`
      }],
    });

    const text = msg.content[0]?.text?.trim() ?? '';
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
    market_narrative    = json.market_narrative    ?? '';
    best_hunting_ground = json.best_hunting_ground ?? '';
  } catch {
    market_narrative    = `${direction} market with VIX at ${vix ?? 'unknown'}. ${regime} conditions.`;
    best_hunting_ground = tradeable ? `Focus on ${leadingSectors[0] ?? 'leading'} sector stocks.` : 'Stay flat today.';
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
