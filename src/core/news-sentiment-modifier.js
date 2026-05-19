import { query, isDbAvailable } from './db.js';

const CACHE_TTL_MS = 5 * 60_000;
const WINDOW_DAYS  = 3;
const _cache = new Map();

function _fromCache(sym) {
  const hit = _cache.get(sym);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  _cache.delete(sym);
  return null;
}

function _toCache(sym, value) {
  _cache.set(sym, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function _noData(symbol) {
  return {
    symbol,
    article_count: 0,
    positive: 0,
    negative: 0,
    neutral: 0,
    avg_sentiment: null,
    label: 'no_data',
    fetched_at: new Date().toISOString(),
  };
}

function _labelFor(avg, count) {
  if (count < 3)   return 'insufficient';
  if (avg >=  0.5) return 'strong_positive';
  if (avg >=  0.2) return 'positive';
  if (avg <= -0.5) return 'strong_negative';
  if (avg <= -0.2) return 'negative';
  return 'mixed';
}

export async function getNewsSentimentForSymbol(symbol) {
  if (!symbol) return _noData('');
  const sym = symbol.toUpperCase();
  const cached = _fromCache(sym);
  if (cached) return cached;
  if (!isDbAvailable()) return _noData(sym);
  try {
    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE sentiment = 'positive') AS positive,
         COUNT(*) FILTER (WHERE sentiment = 'negative') AS negative,
         COUNT(*) FILTER (WHERE sentiment = 'neutral')  AS neutral,
         COUNT(*) AS total
       FROM benzinga_news
       WHERE tickers @> $1::jsonb
         AND published_at > NOW() - ($2 || ' days')::interval`,
      [JSON.stringify([sym]), WINDOW_DAYS]
    );
    const r        = rows[0] || {};
    const positive = Number(r.positive) || 0;
    const negative = Number(r.negative) || 0;
    const neutral  = Number(r.neutral)  || 0;
    const total    = Number(r.total)    || 0;
    const scored   = positive + negative + neutral;
    const avg      = scored > 0 ? (positive - negative) / scored : null;
    const label    = total === 0 ? 'no_data' : _labelFor(avg ?? 0, total);
    const result = {
      symbol: sym,
      article_count: total,
      positive, negative, neutral,
      avg_sentiment: avg == null ? null : +avg.toFixed(4),
      label,
      fetched_at: new Date().toISOString(),
    };
    _toCache(sym, result);
    return result;
  } catch {
    return _noData(sym);
  }
}

// Bounds: +8 aligned, -10 conflicting (smaller than UW; news is noisier).
// Magnitude scaled by |avg_sentiment| * min(article_count / 10, 1).
export function computeNewsModifier(adjustedChangePct, sentiment) {
  if (!sentiment || sentiment.label === 'no_data' || sentiment.label === 'insufficient'
      || sentiment.label === 'mixed' || sentiment.avg_sentiment == null) {
    return { delta: 0, reason: 'no_news_data', news_label: null };
  }
  if (adjustedChangePct === 0) {
    return { delta: 0, reason: 'flat_forecast', news_label: sentiment.label };
  }

  const magnitude     = Math.abs(sentiment.avg_sentiment) * Math.min(sentiment.article_count / 10, 1);
  const isBullishPred = adjustedChangePct > 0;
  const isBearishPred = adjustedChangePct < 0;
  const isPositiveNews = sentiment.label === 'positive' || sentiment.label === 'strong_positive';
  const isNegativeNews = sentiment.label === 'negative' || sentiment.label === 'strong_negative';

  if ((isBullishPred && isPositiveNews) || (isBearishPred && isNegativeNews)) {
    return { delta: Math.min(8, Math.round(8 * magnitude)), reason: 'news_aligned', news_label: sentiment.label };
  }
  if ((isBullishPred && isNegativeNews) || (isBearishPred && isPositiveNews)) {
    return { delta: -Math.min(10, Math.round(10 * magnitude)), reason: 'news_conflicting', news_label: sentiment.label };
  }
  return { delta: 0, reason: 'no_news_data', news_label: null };
}
