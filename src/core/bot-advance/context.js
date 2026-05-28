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
 * Single batched query — we want this fast since we call it once per candidate.
 */
export async function buildContext(symbol) {
  const sym = symbol.toUpperCase();

  // 1. Most recent conviction_scores row for this symbol (has signals + composite)
  const cs = await query(`
    SELECT score, grade, signals, scored_at
      FROM conviction_scores
     WHERE symbol = $1
       AND scored_at > NOW() - INTERVAL '24 hours'
     ORDER BY scored_at DESC
     LIMIT 1
  `, [sym]);
  const csRow = cs.rows[0];
  const signals = csRow?.signals || {};
  const composite = csRow?.score != null ? Number(csRow.score) : null;

  // 2. Liquidity (price + ADV + last_date for freshness gate)
  const liq = await query(`
    SELECT close AS last_price,
           price_date AS last_date
      FROM backtest_prices
     WHERE symbol = $1
     ORDER BY price_date DESC
     LIMIT 1
  `, [sym]);
  const liqRow = liq.rows[0];

  // 3. 52w high/low from tradable_universe (already synced)
  const u = await query(`
    SELECT week_52_high, week_52_low, last_price AS universe_price,
           avg_volume_30d, day_volume, market_cap_usd, sector
      FROM tradable_universe
     WHERE symbol = $1
     LIMIT 1
  `, [sym]);
  const uRow = u.rows[0];

  // 4. Insider cluster summary (30d Director/10%-Owner buys)
  const insider = await query(`
    SELECT
      COALESCE(SUM(value), 0)::numeric AS director_amt_30d,
      COUNT(*)::int                    AS cluster_count
    FROM uw_insider_trades
   WHERE ticker = $1
     AND role IN ('Director', '10% Owner', 'Director/10% Owner')
     AND transaction_type = 'P'
     AND value >= 100000
     AND filed_at > NOW() - INTERVAL '30 days'
  `, [sym]);
  const insRow = insider.rows[0] || {};

  // 5. Congress — uw_congressional_trades stores amount as a TEXT bucket range.
  //    We extract the lower bound numerically for the detect() comparison.
  //    "$250,001 - $500,000" → amount_min_dollars=250001
  //    "Over $50,000,000"    → amount_min_dollars=50000000
  let congress = null;
  try {
    const c = await query(`
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
       AND transaction_type IN ('buy', 'purchase', 'Purchase')
       AND filed_at > NOW() - INTERVAL '30 days'
     ORDER BY filed_at DESC
     LIMIT 1
    `, [sym]);
    congress = c.rows[0] || null;
  } catch (e) {
    console.warn(`[bot-advance/context] congress lookup failed for ${sym}: ${e.message}`);
  }

  // 6. Compute derived fields
  const week52High = uRow?.week_52_high != null ? Number(uRow.week_52_high) : null;
  const lastPrice  = liqRow?.last_price != null ? Number(liqRow.last_price)
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
        last_price: lastPrice,
        last_date:  liqRow?.last_date ?? null,
        adv_dollar_vol_30d: uRow?.avg_volume_30d != null ? Number(uRow.avg_volume_30d) : null,
      },
      distance_52w: {
        week_52_high: week52High,
        week_52_low:  uRow?.week_52_low != null ? Number(uRow.week_52_low) : null,
        pct_off_high: (week52High && lastPrice) ? +((1 - lastPrice / week52High) * 100).toFixed(2) : null,
      },
      sector:       uRow?.sector ?? null,
      market_cap:   uRow?.market_cap_usd != null ? Number(uRow.market_cap_usd) : null,
      day_volume:   uRow?.day_volume   != null ? Number(uRow.day_volume)   : null,
      avg_volume:   uRow?.avg_volume_30d != null ? Number(uRow.avg_volume_30d) : null,
    },
  };
}
