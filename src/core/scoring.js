/**
 * Multi-factor conviction scoring engine.
 * Combines earnings quality, momentum, relative strength, insider activity,
 * and market conditions into a single 0–100 score.
 */

import { getPreEarningsDrift, getEarnings, getSymbolNews, getInsiderBuying, getEarningsSurprise } from './news.js';
import { getRelativeStrength, getMarketSentiment, SECTOR_MAP } from './sentiment.js';
import { isBadTradingTime } from './trader.js';
import { getChartTechnicals, getPriceLevels } from './tradingview-bridge.js';

export function checkSectorConcentration({ symbol, positions = [] }) {
  const ticker = symbol.toUpperCase();
  const targetSector = SECTOR_MAP[ticker];
  if (!targetSector) return { concentrated: false };

  for (const pos of positions) {
    const posSym = (pos.symbol || '').toUpperCase();
    if (posSym === ticker) continue; // same symbol, not a concentration issue
    if (SECTOR_MAP[posSym] === targetSector) {
      return { concentrated: true, existing_symbol: posSym, sector: targetSector };
    }
  }
  return { concentrated: false };
}

export async function getConvictionScore({ symbol, positions = [] } = {}) {
  const ticker = symbol.toUpperCase().replace(/^(NASDAQ:|NYSE:|AMEX:)/, '');
  const sectorEtf = SECTOR_MAP[ticker] || 'SPY';

  // Fetch all signals in parallel — individual failures don't abort scoring
  const [driftRes, rsRes, newsRes, earningsRes, sentimentRes, insiderRes, surpriseRes, techRes, levelsRes] =
    await Promise.allSettled([
      getPreEarningsDrift({ symbol: ticker }),
      getRelativeStrength({ symbol: ticker, sector_etf: sectorEtf }),
      getSymbolNews({ symbol: ticker, limit: 10 }),
      getEarnings({ symbol: ticker }),
      getMarketSentiment(),
      getInsiderBuying({ symbol: ticker }),
      getEarningsSurprise({ symbol: ticker }),
      getChartTechnicals({ symbol: ticker }),
      getPriceLevels({ symbol: ticker }),
    ]);

  const drift    = driftRes.status    === 'fulfilled' ? driftRes.value    : null;
  const rs       = rsRes.status       === 'fulfilled' ? rsRes.value       : null;
  const news     = newsRes.status     === 'fulfilled' ? newsRes.value     : null;
  const earnings = earningsRes.status === 'fulfilled' ? earningsRes.value : null;
  const sentiment= sentimentRes.status=== 'fulfilled' ? sentimentRes.value: null;
  const insider  = insiderRes.status  === 'fulfilled' ? insiderRes.value  : null;
  const surprise = surpriseRes.status === 'fulfilled' ? surpriseRes.value : null;
  const tech     = techRes.status     === 'fulfilled' ? techRes.value     : null;
  const levels   = levelsRes.status   === 'fulfilled' ? levelsRes.value   : null;

  // Extract signal values
  const beat_streak       = surprise?.beat_streak        ?? 0;
  const earnings_quality  = earnings?.history?.[0]?.earnings_quality ?? null;
  const guidance_signal   = news?.guidance_signal        ?? 'neutral';
  const drift_direction   = drift?.drift_direction       ?? 'flat';
  const rs_signal         = rs?.signal                   ?? 'neutral';
  const insider_buys_60d  = insider?.insider_buys_60d    ?? 0;
  const vix               = sentiment?.vix?.value        ?? null;
  const badTime           = isBadTradingTime();
  const tvAvailable       = tech?.available === true;
  const sectorCheck       = checkSectorConcentration({ symbol: ticker, positions });

  // Score each factor
  const breakdown = {
    // Graduated beat streak — partial credit for 1-2 quarters
    beat_streak:          beat_streak >= 3 ? 25 : beat_streak === 2 ? 15 : beat_streak === 1 ? 8 : 0,
    // Earnings quality
    earnings_quality:     earnings_quality === 'strong' ? 20 : earnings_quality === 'moderate' ? 8 : 0,
    // Guidance
    guidance_raised:      guidance_signal === 'raised'  ?  15 : 0,
    guidance_lowered:     guidance_signal === 'lowered' ? -15 : 0,
    // Momentum signals
    pre_earnings_drift:   drift_direction === 'up'      ?  15 : drift_direction === 'down' ? -10 : 0,
    relative_strength:    rs_signal === 'strong'        ?  15 : rs_signal === 'weak'       ? -10 : 0,
    // Insider activity — 1 buy counts for something
    insider_buying:       insider_buys_60d >= 2 ? 10 : insider_buys_60d === 1 ? 5 : 0,
    // VIX — graduated, only extreme fear is a hard penalty
    high_vix:             vix == null ? 0 : vix > 35 ? -20 : vix > 28 ? -10 : vix > 25 ? -5 : 0,
    // Time of day — only penalise true lunch chop (12:30–1:30 PM ET)
    bad_trading_time:     badTime.bad                   ?  -5 : 0,
    // Sector concentration remains a hard penalty
    sector_concentrated:  sectorCheck.concentrated      ? -25 : 0,
    // Base score — any stock worth scanning starts with credit
    base:                 30,
  };

  // TradingView technical factors (only applied when chart data is live)
  let technical_summary = 'TradingView not connected';
  if (tvAvailable) {
    const { rsi, macd_hist, ema20, ema50, bb_upper, bb_mid, current_price, distance_to_support_pct, distance_to_resistance_pct } = tech;
    const lvlDist = levels?.available ? {
      support_pct:    levels.distance_to_support_pct,
      resistance_pct: levels.distance_to_resistance_pct,
    } : {};

    if (rsi != null && rsi < 40)  breakdown.rsi_oversold         =  20;
    if (rsi != null && rsi > 70)  breakdown.rsi_overbought       = -20;
    if (current_price != null && ema20 != null && ema50 != null) {
      if (current_price > ema20 && current_price > ema50) breakdown.above_both_emas =  15;
      if (current_price < ema20 && current_price < ema50) breakdown.below_both_emas = -15;
    }
    if (macd_hist != null && macd_hist > 0) breakdown.macd_positive =  10;
    if (macd_hist != null && macd_hist < 0) breakdown.macd_negative = -10;
    if (lvlDist.support_pct != null    && lvlDist.support_pct < 2)    breakdown.near_support    =  15;
    if (lvlDist.resistance_pct != null && lvlDist.resistance_pct < 2) breakdown.near_resistance = -15;
    if (current_price != null && bb_mid != null && current_price < bb_mid) breakdown.below_bb_mid  =  10;
    if (current_price != null && bb_upper != null && current_price > bb_upper) breakdown.above_bb_upper = -10;

    // One-sentence technical summary
    const rsiNote = rsi != null ? (rsi < 40 ? 'oversold RSI' : rsi > 70 ? 'overbought RSI' : `RSI ${rsi.toFixed(0)}`) : '';
    const trendNote = (current_price && ema20 && ema50)
      ? (current_price > ema20 && current_price > ema50 ? 'above EMA20/50 uptrend'
        : current_price < ema20 && current_price < ema50 ? 'below EMA20/50 downtrend' : 'mixed EMA signals')
      : '';
    const macdNote = macd_hist != null ? (macd_hist > 0 ? 'MACD positive' : 'MACD negative') : '';
    technical_summary = [rsiNote, trendNote, macdNote].filter(Boolean).join(', ') || 'chart data read';
  } else if (tech?.available === false) {
    breakdown.tv_unavailable = 0; // marker — no penalty
  }

  const raw   = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const score = Math.min(100, Math.max(0, raw));
  const grade = score >= 75 ? 'A' : score >= 50 ? 'B' : score >= 35 ? 'C' : 'F';
  const recommendation =
    score >= 75 ? 'strong_buy' :
    score >= 50 ? 'buy' :
    score >= 35 ? 'skip' : 'avoid';

  return {
    success: true,
    symbol: ticker,
    score,
    grade,
    recommendation,
    tv_available: tvAvailable,
    technical_summary,
    breakdown,
    signals: {
      beat_streak,
      earnings_quality,
      guidance_signal,
      drift_5d_pct:    drift?.drift_5d_pct    ?? null,
      drift_direction,
      rs_score:        rs?.rs_score           ?? null,
      rs_signal,
      insider_buys_60d,
      vix,
      bad_trading_time: badTime.bad,
      bad_time_reason:  badTime.reason,
      rsi:             tech?.rsi             ?? null,
      macd_hist:       tech?.macd_hist       ?? null,
      ema20:           tech?.ema20           ?? null,
      ema50:           tech?.ema50           ?? null,
      current_price:   tech?.current_price   ?? null,
      sector_concentration: sectorCheck,
    },
  };
}
