/**
 * Bot Setup Classifier — B-3.7
 *
 * Classifies a scoring candidate into one of five setup types.
 * Five classifiers run in priority order; first match wins.
 * Returns null when no setup matches → bot rejects the trade.
 *
 * Setup priority order:
 *   1. CATALYST        — news + volume + same-day move + UW flow
 *   2. BREAKOUT        — new 52w high, volume expansion
 *   3. MOMENTUM        — near 52w high, positive 5d return
 *   4. VALUE_CONTRARIAN — quality pullback + insider net buying
 *   5. MEAN_REVERSION  — oversold + below 50d MA
 */

import { query } from './db.js';

// ── Data helpers ──────────────────────────────────────────────────────────────

export async function computeLast5dReturn(symbol) {
  const { rows } = await query(
    `SELECT close FROM backtest_prices
     WHERE symbol = $1 AND close IS NOT NULL
     ORDER BY price_date DESC LIMIT 6`,
    [symbol.toUpperCase()]
  );
  if (rows.length < 5) return null;
  const latest = Number(rows[0].close);
  const oldest = Number(rows[4].close);
  if (!oldest) return null;
  return (latest - oldest) / oldest;
}

export async function computeRsi14(symbol) {
  const { rows } = await query(
    `SELECT close FROM backtest_prices
     WHERE symbol = $1 AND close IS NOT NULL
     ORDER BY price_date DESC LIMIT 16`,
    [symbol.toUpperCase()]
  );
  if (rows.length < 15) return null;
  const closes = rows.map(r => Number(r.close)).reverse();
  let gains = 0, losses = 0;
  for (let i = 1; i <= 14; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses += Math.abs(diff);
  }
  let avgGain = gains / 14;
  let avgLoss = losses / 14;
  for (let i = 15; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * 13 + Math.max(diff, 0)) / 14;
    avgLoss = (avgLoss * 13 + Math.max(-diff, 0)) / 14;
  }
  if (!avgLoss) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export async function getFundamentalsGrowth(symbol) {
  const { rows } = await query(
    `SELECT period_end, revenue, eps_diluted
     FROM fundamentals
     WHERE symbol = $1 AND period_type = 'quarterly'
     ORDER BY period_end DESC LIMIT 5`,
    [symbol.toUpperCase()]
  );
  if (rows.length < 5) return null;
  const latest = rows[0];
  // Compare against same quarter ~1yr ago (index 4 = 4 quarters back)
  const yearAgo = rows[4];
  const revenueGrowth = yearAgo.revenue
    ? (Number(latest.revenue) - Number(yearAgo.revenue)) / Math.abs(Number(yearAgo.revenue))
    : null;
  const epsGrowth = yearAgo.eps_diluted != null && Number(yearAgo.eps_diluted) !== 0
    ? (Number(latest.eps_diluted) - Number(yearAgo.eps_diluted)) / Math.abs(Number(yearAgo.eps_diluted))
    : null;
  return { revenueGrowth, epsGrowth };
}

async function _new52wHighWithin5d(symbol) {
  try {
    const { rows } = await query(
      `SELECT 1 FROM backtest_prices
       WHERE symbol = $1
         AND price_date >= NOW() - INTERVAL '7 days'
         AND high = (
           SELECT MAX(high) FROM backtest_prices
           WHERE symbol = $1 AND price_date > NOW() - INTERVAL '365 days'
         )
       LIMIT 1`,
      [symbol.toUpperCase()]
    );
    return rows.length > 0;
  } catch { return false; }
}

async function _volumeOnBreakoutDay(symbol) {
  try {
    const { rows } = await query(
      `SELECT volume FROM backtest_prices
       WHERE symbol = $1
         AND price_date >= NOW() - INTERVAL '7 days'
         AND high = (
           SELECT MAX(high) FROM backtest_prices
           WHERE symbol = $1 AND price_date > NOW() - INTERVAL '365 days'
         )
       LIMIT 1`,
      [symbol.toUpperCase()]
    );
    return rows[0]?.volume ? Number(rows[0].volume) : null;
  } catch { return null; }
}

// ── Thesis builders ───────────────────────────────────────────────────────────

function _catalystThesis({ articleCount, todayChangePct, uwScore, flowPremium }) {
  return {
    text: `Catalyst-driven entry. ${articleCount} positive articles in last 24h, price up ${(todayChangePct * 100).toFixed(1)}%, UW flow at ${uwScore ?? 'n/a'} with premium $${Math.round((flowPremium ?? 0) / 1000)}K. Move already underway, exit when momentum exhausts.`,
    articleCount, todayChangePct, uwScore, flowPremium,
  };
}

function _breakoutThesis({ breakoutDate, volumeRatio, uwLabel }) {
  return {
    text: `Breakout setup. Made new 52w high near ${breakoutDate ?? 'recently'}, volume ${volumeRatio?.toFixed(1) ?? '?'}x average. UW ${uwLabel ?? 'neutral'}. Holding for trend continuation.`,
    breakoutDate, volumeRatio, uwLabel,
  };
}

function _momentumThesis({ pctOff52w, last5dReturn, uwLabel, uwScore }) {
  return {
    text: `Momentum continuation. Price ${(pctOff52w * 100).toFixed(1)}% from 52w high, +${(last5dReturn * 100).toFixed(1)}% last 5d, UW ${uwLabel ?? 'neutral'} at score ${uwScore ?? 'n/a'}. Tight trail, watch for signal flip.`,
    pctOff52w, last5dReturn, uwLabel, uwScore,
  };
}

function _valueThesis({ grade, score, pctOff52w, insiderNetUsd, fundamentals }) {
  const fundSummary = fundamentals
    ? [
        fundamentals.revenueGrowth != null ? `revenue ${fundamentals.revenueGrowth >= 0 ? '+' : ''}${(fundamentals.revenueGrowth * 100).toFixed(0)}% YoY` : null,
        fundamentals.epsGrowth != null ? `EPS ${fundamentals.epsGrowth >= 0 ? '+' : ''}${(fundamentals.epsGrowth * 100).toFixed(0)}% YoY` : null,
      ].filter(Boolean).join(', ')
    : 'fundamentals unavailable';
  return {
    text: `Value pullback in quality name. Conviction grade ${grade} (${score?.toFixed(0) ?? '?'}), price ${(pctOff52w * 100).toFixed(1)}% off 52w high, insider net buying $${Math.round((insiderNetUsd ?? 0) / 1_000_000 * 10) / 10}M. Fundamentals: ${fundSummary}. Wide stop, patient hold.`,
    grade, score, pctOff52w, insiderNetUsd, fundSummary,
  };
}

function _meanReversionThesis({ pctOff52w, rsi14, ma50Distance }) {
  return {
    text: `Mean reversion bounce. Price ${(pctOff52w * 100).toFixed(1)}% off high, RSI ${rsi14?.toFixed(0) ?? '?'}, ${(ma50Distance * 100).toFixed(1)}% below 50d MA. Target: return to 50d MA or +8%.`,
    pctOff52w, rsi14, ma50Distance,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {object} params.signals      — from _scoreCandidate
 * @param {object} params.indicators   — from getAllBotIndicators
 * @param {number|null} params.rsi     — Wilder RSI-14
 * @param {object|null} params.fundamentals — { revenueGrowth, epsGrowth }
 * @param {number|null} params.last5dReturn — decimal (e.g. 0.04 = 4%)
 * @returns {{ setup_type, thesis, expected_hold_days_min, expected_hold_days_max } | null}
 */
export async function classifySetup({ signals, indicators, rsi, fundamentals, last5dReturn }) {
  const sym = indicators?.symbol ?? null;

  const news    = signals?.news       ?? {};
  const uw      = signals?.uw_options ?? {};
  const insider = signals?.insider    ?? {};
  const conv    = signals?.conviction ?? {};
  const dist52w = signals?.distance_52w ?? {};

  const articleCount   = news.article_count ?? 0;
  const newsLabel      = news.label ?? 'no_data';
  const uwLabel        = uw.label  ?? 'no_data';
  const uwScore        = uw.score  ?? null;
  const pctOff52w      = dist52w.pct_off_52w_high ?? null;   // negative = below high
  const todayChangePct = indicators?.premarket?.gap_pct ?? null;

  // Latest UW flow premium for this symbol (last 6h)
  let recentFlowPremium = null;
  if (sym) {
    try {
      const { rows } = await query(
        `SELECT SUM(premium) AS total FROM uw_flow_alerts
         WHERE ticker=$1 AND sentiment IN ('bullish','strong_bullish')
           AND alerted_at > NOW() - INTERVAL '6 hours'`,
        [sym.toUpperCase()]
      );
      recentFlowPremium = rows[0]?.total ? Number(rows[0].total) : null;
    } catch { /* graceful degrade */ }
  }

  // Insider net buying
  let insiderNetUsd = null;
  if (sym) {
    try {
      const { rows } = await query(
        `SELECT
           COALESCE(SUM(CASE WHEN transaction_type='buy' THEN value ELSE 0 END), 0) AS buy_usd,
           COALESCE(SUM(CASE WHEN transaction_type='sell' THEN value ELSE 0 END), 0) AS sell_usd
         FROM uw_insider_trades
         WHERE ticker=$1 AND filed_at > NOW() - INTERVAL '30 days'`,
        [sym.toUpperCase()]
      );
      if (rows[0]) {
        insiderNetUsd = Number(rows[0].buy_usd) - Number(rows[0].sell_usd);
      }
    } catch { /* graceful degrade */ }
  }

  // MA50 distance from backtest_prices
  let ma50Distance = null;
  let lastClosePrice = null;
  if (sym) {
    try {
      const { rows } = await query(
        `SELECT AVG(close) AS ma50, (SELECT close FROM backtest_prices WHERE symbol=$1 ORDER BY price_date DESC LIMIT 1) AS last_close
         FROM (SELECT close FROM backtest_prices WHERE symbol=$1 ORDER BY price_date DESC LIMIT 50) s`,
        [sym.toUpperCase()]
      );
      if (rows[0]?.ma50 && rows[0]?.last_close) {
        lastClosePrice = Number(rows[0].last_close);
        ma50Distance = (lastClosePrice - Number(rows[0].ma50)) / Number(rows[0].ma50);
      }
    } catch { /* graceful degrade */ }
  }

  // Average 30d volume from tradable_universe
  let avgVol30d = null;
  if (sym) {
    try {
      const { rows } = await query(
        'SELECT avg_volume_30d FROM tradable_universe WHERE symbol=$1',
        [sym.toUpperCase()]
      );
      avgVol30d = rows[0]?.avg_volume_30d ? Number(rows[0].avg_volume_30d) : null;
    } catch { /* graceful degrade */ }
  }

  // ── 1. CATALYST ────────────────────────────────────────────────────────────
  if (
    articleCount >= 3 &&
    (newsLabel === 'positive' || (news.avg_sentiment ?? 0) > 0.3) &&
    todayChangePct != null && todayChangePct >= 0.03 &&
    (uwScore != null && uwScore >= 60 || recentFlowPremium != null && recentFlowPremium >= 200_000) &&
    indicators?.liquidity
  ) {
    // Volume today >= 2x avg — approximated via UW flow presence as proxy when direct bar unavailable
    const volumeOk = recentFlowPremium != null && recentFlowPremium >= 200_000;
    if (volumeOk) {
      return {
        setup_type: 'catalyst',
        thesis: _catalystThesis({ articleCount, todayChangePct, uwScore, flowPremium: recentFlowPremium }),
        expected_hold_days_min: 1,
        expected_hold_days_max: 3,
      };
    }
  }

  // ── 2. BREAKOUT ────────────────────────────────────────────────────────────
  if (
    pctOff52w != null && pctOff52w >= -0.03 &&
    uwLabel !== 'bearish' && uwLabel !== 'strong_bearish' &&
    sym
  ) {
    const is52wHigh = await _new52wHighWithin5d(sym).catch(() => false);
    if (is52wHigh) {
      const breakoutVol  = await _volumeOnBreakoutDay(sym).catch(() => null);
      const volumeRatio  = (breakoutVol != null && avgVol30d)
        ? breakoutVol / avgVol30d : null;
      if (volumeRatio != null && volumeRatio >= 1.5) {
        return {
          setup_type: 'breakout',
          thesis: _breakoutThesis({ breakoutDate: null, volumeRatio, uwLabel }),
          expected_hold_days_min: 5,
          expected_hold_days_max: 21,
        };
      }
    }
  }

  // ── 3. MOMENTUM ───────────────────────────────────────────────────────────
  if (
    pctOff52w != null && pctOff52w >= -0.10 &&
    last5dReturn != null && last5dReturn >= 0.02 &&
    (uwScore != null && uwScore >= 40 || ['bullish', 'strong_bullish'].includes(uwLabel)) &&
    newsLabel !== 'negative'
  ) {
    return {
      setup_type: 'momentum',
      thesis: _momentumThesis({ pctOff52w, last5dReturn, uwLabel, uwScore }),
      expected_hold_days_min: 2,
      expected_hold_days_max: 7,
    };
  }

  // ── 4. VALUE_CONTRARIAN ───────────────────────────────────────────────────
  const grade = conv.grade;
  const score = conv.score ?? (conv.value != null ? conv.value / 2 + 50 : null);
  if (
    (grade === 'A' || grade === 'B') &&
    pctOff52w != null && pctOff52w <= -0.05 && pctOff52w >= -0.25 &&
    insiderNetUsd != null && insiderNetUsd >= 1_000_000 &&
    uwLabel !== 'bearish' && uwLabel !== 'strong_bearish' &&
    (newsLabel !== 'negative' || articleCount < 3)
  ) {
    // Require at least one fundamentals growth signal
    const fundOk = fundamentals != null &&
      ((fundamentals.revenueGrowth != null && fundamentals.revenueGrowth > 0) ||
       (fundamentals.epsGrowth     != null && fundamentals.epsGrowth     > 0));
    if (fundOk) {
      return {
        setup_type: 'value_contrarian',
        thesis: _valueThesis({ grade, score, pctOff52w, insiderNetUsd, fundamentals }),
        expected_hold_days_min: 10,
        expected_hold_days_max: 30,
      };
    }
  }

  // ── 5. MEAN_REVERSION ────────────────────────────────────────────────────
  if (
    pctOff52w != null && pctOff52w <= -0.15 &&
    rsi != null && rsi <= 30 &&
    ma50Distance != null && ma50Distance <= -0.05 &&
    uwLabel !== 'bearish' && uwLabel !== 'strong_bearish' &&
    !(newsLabel === 'negative' && articleCount >= 3)
  ) {
    return {
      setup_type: 'mean_reversion',
      thesis: _meanReversionThesis({ pctOff52w, rsi14: rsi, ma50Distance }),
      expected_hold_days_min: 5,
      expected_hold_days_max: 15,
    };
  }

  return null;
}
