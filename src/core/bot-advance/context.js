/**
 * src/core/bot-advance/context.js
 *
 * Build the per-candidate context object that rules' detect() functions consume.
 * Reads from the same DB tables as the existing bot but exposes a cleaner shape.
 *
 * The context shape is the rule's API contract:
 *   {
 *     symbol:     'AMD',
 *     composite:  73.5,              // composite score (if any)
 *     signals: {                      // pulled from conviction_scores.signals
 *       rsi, macd_hist, ema20, ema50, rvol, drift_5d_pct, ...
 *       insider:  { director_amt_30d, cluster_count, ... },
 *       congress: { amount, disclosure_lag_days, ... },
 *     },
 *     indicators: {                   // pulled from various sources
 *       liquidity: { last_price, adv_dollar_vol_30d, last_date, ... },
 *       distance_52w: { week_52_high, week_52_low, pct_off_high },
 *     },
 *   }
 */

import { query } from '../db.js';

/**
 * Fetch signal data for a candidate symbol.
 * All 5 DB queries run in parallel (Promise.allSettled) — was sequential (~250ms),
 * now ~50ms for the slowest query. Error in one source degrades gracefully.
 *
 * Fix A-5 (2026-05-29): parallel queries
 * Fix A-4 (2026-05-29): insider wrapped in allSettled (was not protected vs congress which was)
 * Fix A-1 (2026-05-29): congress transaction_type adds 'Buy' (UW API capitalisation)
 * Fix A-3 (2026-05-29): congress query adds amount filter — returns most recent QUALIFYING
 *                        filing (≥$250K) rather than most recent any buy
 */
export async function buildContext(symbol) {
  const sym = symbol.toUpperCase();

  // Run all 5 queries in parallel — they are completely independent.
  const [csResult, liqResult, uResult, insiderResult, congressResult] = await Promise.allSettled([

    // 1. Most recent conviction_scores row (composite + signal snapshot)
    query(`
      SELECT score, grade, signals, scored_at
        FROM conviction_scores
       WHERE symbol = $1
         AND scored_at > NOW() - INTERVAL '24 hours'
       ORDER BY scored_at DESC
       LIMIT 1
    `, [sym]),

    // 2. Last close from backtest_prices (last_price / last_date)
    query(`
      SELECT close AS last_price,
             price_date AS last_date
        FROM backtest_prices
       WHERE symbol = $1
       ORDER BY price_date DESC
       LIMIT 1
    `, [sym]),

    // 3. 52w high/low + volume from tradable_universe (already synced)
    query(`
      SELECT week_52_high, week_52_low, last_price AS universe_price,
             avg_volume_30d, day_volume, market_cap_usd, sector
        FROM tradable_universe
       WHERE symbol = $1
       LIMIT 1
    `, [sym]),

    // 4. Insider cluster summary (30d Director/10%-Owner P-code purchases ≥$100K)
    //    Fix A-4: now inside allSettled — a table error returns {} instead of throwing.
    query(`
      SELECT
        COALESCE(SUM(value), 0)::numeric AS director_amt_30d,
        COUNT(*)::int                    AS cluster_count
        FROM uw_insider_trades
       WHERE ticker = $1
         AND role IN ('Director', '10% Owner', 'Director/10% Owner')
         AND transaction_type = 'P'
         AND value >= 100000
         AND filed_at > NOW() - INTERVAL '30 days'
    `, [sym]),

    // 5. Most recent QUALIFYING congress buy (≥$250K amount range).
    //    Fix A-1: transaction_type list now includes 'Buy' (UW stores it capitalized).
    //    Fix A-3: amount_range filter added — fetches most recent HIGH-VALUE filing,
    //             not just the most recent any buy (which could be a small $50K trade
    //             that would silently fail the detect() amount check).
    query(`
      SELECT
        amount_range,
        CASE
          WHEN amount_range LIKE 'Over %' THEN
            (regexp_replace(amount_range, '[^0-9]', '', 'g'))::bigint
          WHEN amount_range LIKE '$%' THEN
            -- "$250,001 - $500,000" → extract first number (250001)
            (regexp_replace(split_part(amount_range, ' - ', 1), '[^0-9]', '', 'g'))::bigint
          ELSE 0
        END                                                                      AS amount_min_dollars,
        EXTRACT(EPOCH FROM (filed_at - traded_at::timestamptz)) / 86400          AS disclosure_lag_days,
        filed_at,
        member_name
        FROM uw_congressional_trades
       WHERE ticker = $1
         AND transaction_type IN ('buy', 'purchase', 'Purchase', 'Buy')
         AND amount_range IN (
             '$250,001 - $500,000',
             '$500,001 - $1,000,000',
             '$1,000,001 - $5,000,000',
             '$5,000,001 - $25,000,000',
             '$25,000,001 - $50,000,000',
             'Over $50,000,000'
         )
         AND filed_at > NOW() - INTERVAL '30 days'
       ORDER BY filed_at DESC
       LIMIT 1
    `, [sym]),
  ]);

  // Unpack results — allSettled never rejects; each slot is { status, value } or { status, reason }.
  const csRow    = csResult.status      === 'fulfilled' ? csResult.value.rows[0]      : null;
  const liqRow   = liqResult.status     === 'fulfilled' ? liqResult.value.rows[0]     : null;
  const uRow     = uResult.status       === 'fulfilled' ? uResult.value.rows[0]       : null;
  const insRow   = insiderResult.status === 'fulfilled' ? (insiderResult.value.rows[0] || {}) : {};
  const congress = congressResult.status === 'fulfilled' ? (congressResult.value.rows[0] || null) : null;

  // Log degraded data for debugging — never throw
  if (insiderResult.status   === 'rejected')
    console.warn(`[bot-advance/context] insider lookup failed for ${sym}: ${insiderResult.reason?.message}`);
  if (congressResult.status  === 'rejected')
    console.warn(`[bot-advance/context] congress lookup failed for ${sym}: ${congressResult.reason?.message}`);

  // 6. Compute derived fields
  const signals   = csRow?.signals || {};
  const composite = csRow?.score != null ? Number(csRow.score) : null;

  const week52High = uRow?.week_52_high    != null ? Number(uRow.week_52_high)    : null;
  const lastPrice  = liqRow?.last_price    != null ? Number(liqRow.last_price)
                     : (uRow?.universe_price != null ? Number(uRow.universe_price) : null);

  return {
    symbol:    sym,
    composite,
    signals: {
      ...signals,
      insider:  insRow,
      congress: congress,
    },
    indicators: {
      liquidity: {
        last_price:         lastPrice,
        last_date:          liqRow?.last_date ?? null,
        adv_dollar_vol_30d: uRow?.avg_volume_30d != null ? Number(uRow.avg_volume_30d) : null,
      },
      distance_52w: {
        week_52_high: week52High,
        week_52_low:  uRow?.week_52_low != null ? Number(uRow.week_52_low) : null,
        pct_off_high: (week52High && lastPrice) ? +((1 - lastPrice / week52High) * 100).toFixed(2) : null,
      },
      sector:     uRow?.sector         ?? null,
      market_cap: uRow?.market_cap_usd  != null ? Number(uRow.market_cap_usd)  : null,
      day_volume: uRow?.day_volume      != null ? Number(uRow.day_volume)      : null,
      avg_volume: uRow?.avg_volume_30d  != null ? Number(uRow.avg_volume_30d)  : null,
    },
  };
}
