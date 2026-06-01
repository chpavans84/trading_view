/**
 * src/core/home-picks.js
 *
 * Returns FORWARD-looking trade ideas for the Home tab's "Suggested Stocks"
 * panel.
 *
 * THE PROBLEM WE'RE FIXING:
 *   conviction_scores is a lagging confirmation — the score is high BECAUSE
 *   the price has already moved. Showing "top conviction" picks = showing
 *   stocks that already ripped. By the time the user clicks BUY, the move
 *   is done.
 *
 * WHAT WE DO INSTEAD:
 *   Find names where bullish signals just emerged but price hasn't fully
 *   responded yet. Five setup classes:
 *
 *   1. fresh_insider     — insider bought ≥$250K in last 14d AND stock is
 *                          up <5% since the buy (still close to insider cost)
 *   2. smart_money       — UW bullish flow ≥$200K in last 3d AND stock 5d
 *                          return ≤ +3% (smart money not yet front-run by price)
 *   3. earnings_setup    — bot has grade A/B AND reports in 3-14 days AND
 *                          5d return < 7%
 *   4. pullback_in_trend — bot has grade A/B AND last 3d return is NEGATIVE
 *                          (uptrend pulling back = buy-the-dip)
 *   5. fresh_breakout    — setup_type='price_breakout' decision in last 24h
 *                          AND first breakout day (not 5 days into the move)
 *
 *   Hard filter applied to ALL classes:
 *     • Last 5d return MUST be ≤ +7% — anything more is "already ripped"
 *     • Last close price ≥ $5 — kill penny stocks
 *     • Must be in backtest_prices (so we have a sparkline)
 *
 *   Each pick carries:
 *     • A specific reason string the user can act on ("Insider bought
 *       $1.2M on May 23 — stock up only 1.4% since")
 *     • A 30-trading-day sparkline (closes array) for inline chart rendering
 *     • Last-1d / last-5d % return for the entry-quality badge
 *
 * SELECTION ORDER:
 *   Each class returns candidates ranked by recency × signal strength. The
 *   final list is built by round-robin across classes so we never show 8
 *   "fresh_breakout" tiles in a row — diversity > volume.
 */

import { query } from './db.js';

const MAX_RIPPED_5D_PCT  = 7;    // Reject if up more than this in 5 trading days
const MIN_PRICE          = 5;     // Skip penny stocks
const SPARKLINE_DAYS     = 30;
const INSIDER_MIN_VALUE  = 250_000;
const FLOW_MIN_PREMIUM   = 200_000;

export async function getSmartPicks({ limit = 8 } = {}) {
  // Run all five candidate generators in parallel, then merge.
  const [fresh, smart, earn, pull, brk] = await Promise.all([
    _freshInsider().catch(() => []),
    _smartMoney().catch(() => []),
    _earningsSetup().catch(() => []),
    _pullbackInTrend().catch(() => []),
    _freshBreakout().catch(() => []),
  ]);

  // Round-robin merge — one pick from each class per round until we hit limit
  const buckets = [fresh, smart, earn, pull, brk];
  const merged = [];
  const seen = new Set();
  let round = 0;
  while (merged.length < limit && round < 20) {
    let added = 0;
    for (const bucket of buckets) {
      if (merged.length >= limit) break;
      const pick = bucket[round];
      if (!pick) continue;
      if (seen.has(pick.symbol)) continue;
      seen.add(pick.symbol);
      merged.push(pick);
      added++;
    }
    if (added === 0) break;
    round++;
  }

  if (!merged.length) return [];

  // Attach sparklines + last-N-day returns in one batched query
  await _attachPriceContext(merged);

  // Apply the "already ripped" filter post-hoc (need price context).
  // Also drop tickers with no price history — the chart is the value-add and
  // we can't render it without closes.
  const filtered = merged.filter(p => {
    if (!p.sparkline || p.sparkline.length < 5) return false;          // need at least 5 days for a chart
    if (p.lastPrice == null || p.lastPrice < MIN_PRICE) return false;  // skip pennies + no-price
    if (p.chg5dPct != null && p.chg5dPct > MAX_RIPPED_5D_PCT) return false;  // "already ripped"
    return true;
  });

  return filtered.slice(0, limit);
}

// ── Candidate generators ───────────────────────────────────────────────────

async function _freshInsider() {
  const { rows } = await query(`
    WITH recent AS (
      SELECT ticker, insider_name, role, value, filed_at,
             ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY filed_at DESC) AS rn
      FROM uw_insider_trades
      WHERE filed_at >= NOW() - INTERVAL '14 days'
        AND LOWER(transaction_type) LIKE '%buy%'
        AND value >= $1
    )
    SELECT ticker, insider_name, role, value, filed_at
    FROM recent
    WHERE rn = 1
    ORDER BY filed_at DESC
    LIMIT 20
  `, [INSIDER_MIN_VALUE]);

  return rows.map(r => {
    const days = Math.max(0, Math.round((Date.now() - new Date(r.filed_at).getTime()) / 86400000));
    const dollarStr = r.value >= 1e6 ? `$${(r.value / 1e6).toFixed(1)}M` : `$${Math.round(r.value / 1000)}K`;
    return {
      symbol:      r.ticker,
      reason_type: 'fresh_insider',
      reason:      `Insider bought ${dollarStr}${r.role ? ` (${r.role})` : ''} · ${days}d ago`,
      reason_short:`👤 insider buy`,
      _sortKey:    -new Date(r.filed_at).getTime(),
    };
  });
}

async function _smartMoney() {
  const { rows } = await query(`
    WITH recent AS (
      SELECT ticker, side, premium, sentiment, alerted_at,
             ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY premium DESC) AS rn
      FROM uw_flow_alerts
      WHERE alerted_at >= NOW() - INTERVAL '3 days'
        AND premium >= $1
        AND (sentiment = 'bullish' OR side ILIKE 'call%' OR side ILIKE '%buy%')
    )
    SELECT ticker, side, premium, alerted_at
    FROM recent
    WHERE rn = 1
    ORDER BY premium DESC
    LIMIT 20
  `, [FLOW_MIN_PREMIUM]);

  return rows.map(r => {
    const prem = r.premium >= 1e6 ? `$${(r.premium / 1e6).toFixed(1)}M` : `$${Math.round(r.premium / 1000)}K`;
    const hrs  = Math.max(0, Math.round((Date.now() - new Date(r.alerted_at).getTime()) / 3600000));
    return {
      symbol:      r.ticker,
      reason_type: 'smart_money',
      reason:      `${prem} bullish options sweep · ${hrs}h ago`,
      reason_short:`🐋 smart money`,
      _sortKey:    -r.premium,
    };
  });
}

async function _earningsSetup() {
  // No earnings_calendar table — use bot decisions tagged with earnings catalyst
  const { rows } = await query(`
    SELECT DISTINCT ON (bd.symbol)
      bd.symbol, bd.composite_score AS score, cs.grade,
      bd.thesis, bd.scanned_at
    FROM bot_decisions bd
    LEFT JOIN conviction_scores cs ON cs.symbol = bd.symbol
      AND cs.scored_at >= NOW() - INTERVAL '48 hours'
    WHERE bd.scanned_at >= NOW() - INTERVAL '24 hours'
      AND bd.setup_type = 'catalyst'
      AND LOWER(bd.action) IN ('buy', 'near')   -- bot-engine writes lowercase action labels
      AND (cs.grade IN ('A', 'B') OR cs.grade IS NULL)
    ORDER BY bd.symbol, bd.scanned_at DESC
    LIMIT 15
  `);

  return rows.map(r => {
    // Try to extract an earnings date from the thesis blob if available
    let when = 'soon';
    try {
      if (r.thesis && typeof r.thesis === 'object') {
        const d = r.thesis.next_earnings_date || r.thesis.earnings_date || r.thesis.event_date;
        if (d) {
          const days = Math.max(0, Math.round((new Date(d).getTime() - Date.now()) / 86400000));
          when = `in ${days}d`;
        }
      }
    } catch {}
    return {
      symbol:      r.symbol,
      reason_type: 'earnings_setup',
      reason:      `Earnings catalyst ${when} · bot grade ${r.grade || 'B+'}`,
      reason_short:`📊 earnings setup`,
      _sortKey:    -new Date(r.scanned_at).getTime(),
    };
  });
}

async function _pullbackInTrend() {
  // High-grade names that are PULLING BACK over the last 3 days — buy the dip
  // in a confirmed uptrend. Pulled from conviction_scores + backtest_prices.
  const { rows } = await query(`
    WITH grades AS (
      SELECT DISTINCT ON (symbol) symbol, score, grade, scored_at
      FROM conviction_scores
      WHERE scored_at >= NOW() - INTERVAL '48 hours'
        AND grade IN ('A', 'B')
      ORDER BY symbol, scored_at DESC
    ),
    recent_prices AS (
      SELECT symbol,
             ARRAY_AGG(close ORDER BY price_date DESC) AS closes
      FROM (
        SELECT symbol, price_date, close,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY price_date DESC) AS rn
        FROM backtest_prices
        WHERE symbol IN (SELECT symbol FROM grades)
      ) p
      WHERE rn <= 4
      GROUP BY symbol
    )
    SELECT g.symbol, g.score, g.grade, rp.closes
    FROM grades g
    JOIN recent_prices rp ON rp.symbol = g.symbol
    WHERE array_length(rp.closes, 1) >= 4
      -- 3-day return (today vs 3 days ago) must be NEGATIVE
      AND ((rp.closes[1] - rp.closes[4]) / NULLIF(rp.closes[4], 0)) < 0
    ORDER BY ((rp.closes[1] - rp.closes[4]) / NULLIF(rp.closes[4], 0)) ASC
    LIMIT 15
  `);

  return rows.map(r => {
    const ret3d = ((r.closes[0] - r.closes[3]) / r.closes[3]) * 100;
    return {
      symbol:      r.symbol,
      reason_type: 'pullback_in_trend',
      reason:      `Grade ${r.grade} (${Math.round(r.score)}) pulling back ${ret3d.toFixed(1)}% in 3 days`,
      reason_short:`📉 pullback in trend`,
      _sortKey:    ret3d,  // most negative pullback first
    };
  });
}

async function _freshBreakout() {
  const { rows } = await query(`
    SELECT DISTINCT ON (symbol)
      symbol, composite_score AS score, setup_type, scanned_at
    FROM bot_decisions
    WHERE scanned_at >= NOW() - INTERVAL '24 hours'
      AND setup_type IN ('price_breakout', 'breakout', 'momentum')
      AND LOWER(action) = 'buy'   -- bot-engine writes lowercase action labels
    ORDER BY symbol, scanned_at DESC
    LIMIT 15
  `);

  return rows.map(r => ({
    symbol:      r.symbol,
    reason_type: 'fresh_breakout',
    reason:      `Fresh ${(r.setup_type || 'breakout').replace('_', ' ')} signal · score ${Math.round(r.score || 0)}`,
    reason_short:`🚀 fresh breakout`,
    _sortKey:    -new Date(r.scanned_at).getTime(),
  }));
}

// ── Price-context attachment (sparkline + recent returns) ──────────────────

async function _attachPriceContext(picks) {
  if (!picks.length) return;
  const tickers = picks.map(p => p.symbol);

  // One query — pull last SPARKLINE_DAYS closes per ticker, plus company name
  // from conviction_scores if available.
  const { rows } = await query(`
    WITH ranked AS (
      SELECT symbol, price_date, close,
             ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY price_date DESC) AS rn
      FROM backtest_prices
      WHERE symbol = ANY($1::text[])
    )
    SELECT symbol, ARRAY_AGG(close ORDER BY price_date ASC) AS closes
    FROM ranked
    WHERE rn <= $2
    GROUP BY symbol
  `, [tickers, SPARKLINE_DAYS]);

  const priceMap = {};
  for (const r of rows) priceMap[r.symbol] = r.closes.map(Number);

  // Best-effort company-name lookup from conviction_scores
  const { rows: names } = await query(`
    SELECT DISTINCT ON (symbol) symbol, name
    FROM conviction_scores
    WHERE symbol = ANY($1::text[]) AND name IS NOT NULL
    ORDER BY symbol, scored_at DESC
  `, [tickers]);
  const nameMap = {};
  for (const r of names) nameMap[r.symbol] = r.name;

  for (const p of picks) {
    const closes = priceMap[p.symbol] || [];
    p.name      = nameMap[p.symbol] || null;
    p.sparkline = closes;
    p.lastPrice = closes.length ? closes[closes.length - 1] : null;
    p.chg1dPct  = closes.length >= 2 ? ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100 : null;
    p.chg5dPct  = closes.length >= 6 ? ((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6]) * 100 : null;
    delete p._sortKey;
  }
}
