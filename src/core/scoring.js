/**
 * Multi-factor conviction scoring engine.
 * Combines earnings quality, momentum, relative strength, insider activity,
 * and market conditions into a single 0–100 score.
 */

import { getPreEarningsDrift, getEarnings, getSymbolNews, getInsiderBuying, getEarningsSurprise } from './news.js';
import { getRelativeStrength, getMarketSentiment, SECTOR_MAP } from './sentiment.js';
import { isBadTradingTime } from './trader.js';

export async function getConvictionScore({ symbol } = {}) {
  const ticker = symbol.toUpperCase().replace(/^(NASDAQ:|NYSE:|AMEX:)/, '');
  const sectorEtf = SECTOR_MAP[ticker] || 'SPY';

  // Fetch all signals in parallel — individual failures don't abort scoring
  const [driftRes, rsRes, newsRes, earningsRes, sentimentRes, insiderRes, surpriseRes] =
    await Promise.allSettled([
      getPreEarningsDrift({ symbol: ticker }),
      getRelativeStrength({ symbol: ticker, sector_etf: sectorEtf }),
      getSymbolNews({ symbol: ticker, limit: 10 }),
      getEarnings({ symbol: ticker }),
      getMarketSentiment(),
      getInsiderBuying({ symbol: ticker }),
      getEarningsSurprise({ symbol: ticker }),
    ]);

  const drift    = driftRes.status    === 'fulfilled' ? driftRes.value    : null;
  const rs       = rsRes.status       === 'fulfilled' ? rsRes.value       : null;
  const news     = newsRes.status     === 'fulfilled' ? newsRes.value     : null;
  const earnings = earningsRes.status === 'fulfilled' ? earningsRes.value : null;
  const sentiment= sentimentRes.status=== 'fulfilled' ? sentimentRes.value: null;
  const insider  = insiderRes.status  === 'fulfilled' ? insiderRes.value  : null;
  const surprise = surpriseRes.status === 'fulfilled' ? surpriseRes.value : null;

  // Extract signal values
  const beat_streak       = surprise?.beat_streak        ?? 0;
  const earnings_quality  = earnings?.history?.[0]?.earnings_quality ?? null;
  const guidance_signal   = news?.guidance_signal        ?? 'neutral';
  const drift_direction   = drift?.drift_direction       ?? 'flat';
  const rs_signal         = rs?.signal                   ?? 'neutral';
  const insider_buys_60d  = insider?.insider_buys_60d    ?? 0;
  const vix               = sentiment?.vix?.value        ?? null;
  const badTime           = isBadTradingTime();

  // Score each factor
  const breakdown = {
    beat_streak_3plus:    beat_streak >= 3             ?  25 : 0,
    earnings_quality:     earnings_quality === 'strong' ?  20 : 0,
    guidance_raised:      guidance_signal === 'raised'  ?  15 : 0,
    pre_earnings_drift:   drift_direction === 'up'      ?  15 : 0,
    relative_strength:    rs_signal === 'strong'        ?  15 : 0,
    insider_buying:       insider_buys_60d >= 2         ?  10 : 0,
    guidance_lowered:     guidance_signal === 'lowered' ? -15 : 0,
    drift_down:           drift_direction === 'down'    ? -10 : 0,
    rs_weak:              rs_signal === 'weak'          ? -10 : 0,
    high_vix:             vix != null && vix > 25       ? -20 : 0,
    bad_trading_time:     badTime.bad                   ? -10 : 0,
  };

  const raw   = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const score = Math.min(100, Math.max(0, raw));
  const grade = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'F';
  const recommendation =
    score >= 70 ? 'strong_buy' :
    score >= 50 ? 'buy' :
    score >= 30 ? 'skip' : 'avoid';

  return {
    success: true,
    symbol: ticker,
    score,
    grade,
    recommendation,
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
    },
  };
}
