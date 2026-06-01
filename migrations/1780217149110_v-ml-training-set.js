/**
 * Migration: v_ml_training_set (view)
 *
 * Per-(symbol, price_date) ML training row that joins ALL Phase A signals
 * with forward-return labels from backtest_prices.
 *
 * Sources (each LEFT JOIN — missing data → NULL feature, NOT row drop):
 *   - daily_intraday_features  → intraday momentum (VWAP, OR, RVOL, change%)
 *   - sector_rotation          → sector regime (rank, mom_score, rel_vs_spy)
 *   - earnings_calendar        → days-to-earnings, last_surprise_pct
 *   - uw_flow_alerts (agg 24h) → premium density, sentiment skew
 *   - uw_insider_trades (30d agg) → net buy value, cluster count
 *   - backtest_prices          → labels: forward 5d / 10d returns
 *
 * Labels:
 *   - ret_5d_pct  : (close_t+5 - close_t) / close_t * 100
 *   - ret_10d_pct
 *   - label_up_2pct_5d : binary, ret_5d_pct > 2
 *   - label_up_5pct_10d : binary, ret_10d_pct > 5
 *
 * Row count: ~500K (628K daily-features rows minus days near horizon edge).
 *
 * Used by scripts/train-model-v2.mjs which loads it, splits train/test by
 * date (newest 20% = test, no leakage), trains logistic regression, stores
 * weights in model_results.
 */

/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

// Static sector → ETF mapping baked into the view (no separate table for 11 rows)
const SECTOR_ETF_MAP = `
  CASE tu.sector
    WHEN 'Technology'             THEN 'XLK'
    WHEN 'Financial Services'     THEN 'XLF'
    WHEN 'Healthcare'             THEN 'XLV'
    WHEN 'Consumer Cyclical'      THEN 'XLY'
    WHEN 'Consumer Defensive'     THEN 'XLP'
    WHEN 'Energy'                 THEN 'XLE'
    WHEN 'Utilities'              THEN 'XLU'
    WHEN 'Basic Materials'        THEN 'XLB'
    WHEN 'Industrials'            THEN 'XLI'
    WHEN 'Communication Services' THEN 'XLC'
    WHEN 'Real Estate'            THEN 'XLRE'
    ELSE NULL
  END
`;

export const up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE VIEW v_ml_training_set AS
    WITH base AS (
      SELECT
        f.symbol,
        f.price_date,
        tu.sector,
        tu.market_cap_usd,
        -- ── Intraday features (from daily_intraday_features) ──
        f.full_day_chg_pct,
        f.pre_change_pct,
        f.intraday_chg_pct,
        f.post_change_pct,
        f.intraday_range_pct,
        f.or_range_pct,
        f.rvol_30d,
        f.first_30min_pct_vol,
        CASE WHEN f.reg_close > f.vwap   THEN 1 ELSE 0 END AS above_vwap,
        CASE WHEN f.reg_close > f.or_high THEN 1 ELSE 0 END AS above_or_high,
        CASE WHEN f.reg_close < f.or_low  THEN 1 ELSE 0 END AS below_or_low,
        f.reg_close,
        f.total_volume
        FROM daily_intraday_features f
        LEFT JOIN tradable_universe tu ON tu.symbol = f.symbol
    ),
    with_sector AS (
      SELECT b.*,
        sr.rank_1d   AS sector_rank,
        sr.chg_1d    AS sector_chg,
        sr.mom_score AS sector_mom,
        sr.rel_vs_spy_1d AS sector_rel_vs_spy
        FROM base b
        LEFT JOIN sector_rotation sr
          ON sr.etf_symbol = (${SECTOR_ETF_MAP.replace(/tu\./g, 'b.')})
         AND sr.price_date = b.price_date
    ),
    with_earnings AS (
      SELECT ws.*,
        CASE
          WHEN ec.next_earnings IS NULL THEN 60
          ELSE GREATEST(-30, LEAST(60, (ec.next_earnings - ws.price_date)::int))
        END AS days_to_earnings,
        ec.last_surprise_pct
        FROM with_sector ws
        LEFT JOIN earnings_calendar ec ON ec.symbol = ws.symbol
    ),
    with_uw AS (
      SELECT we.*,
        COALESCE(uw_agg.total_premium, 0)::numeric AS uw_flow_24h_premium,
        COALESCE(uw_agg.alert_count, 0)::int       AS uw_flow_24h_count,
        COALESCE(uw_agg.bullish_pct, 0)::numeric   AS uw_flow_bullish_pct,
        COALESCE(ins_agg.net_buy_value, 0)::numeric AS insider_net_30d,
        COALESCE(ins_agg.cluster_count, 0)::int     AS insider_cluster_30d
        FROM with_earnings we
        LEFT JOIN LATERAL (
          SELECT
            SUM(premium)                                          AS total_premium,
            COUNT(*)                                              AS alert_count,
            ROUND(100.0 * COUNT(*) FILTER (WHERE sentiment IN ('bullish','strong_bullish'))::numeric
                  / NULLIF(COUNT(*), 0), 1) AS bullish_pct
            FROM uw_flow_alerts
           WHERE ticker = we.symbol
             AND alerted_at BETWEEN (we.price_date - INTERVAL '1 day')::timestamptz
                                AND (we.price_date + INTERVAL '1 day')::timestamptz
        ) uw_agg ON true
        LEFT JOIN LATERAL (
          SELECT
            SUM(CASE WHEN transaction_type='P' THEN value ELSE -value END) AS net_buy_value,
            COUNT(*) FILTER (WHERE transaction_type='P' AND value >= 100000) AS cluster_count
            FROM uw_insider_trades
           WHERE ticker = we.symbol
             AND filed_at BETWEEN (we.price_date - INTERVAL '30 days')::timestamptz
                              AND we.price_date::timestamptz
             AND role IN ('Director','10% Owner','Director/10% Owner')
        ) ins_agg ON true
    )
    SELECT
      w.symbol,
      w.price_date,
      w.sector,
      w.market_cap_usd,
      -- Features
      w.full_day_chg_pct, w.pre_change_pct, w.intraday_chg_pct, w.post_change_pct,
      w.intraday_range_pct, w.or_range_pct, w.rvol_30d, w.first_30min_pct_vol,
      w.above_vwap, w.above_or_high, w.below_or_low,
      w.sector_rank, w.sector_chg, w.sector_mom, w.sector_rel_vs_spy,
      w.days_to_earnings, w.last_surprise_pct,
      w.uw_flow_24h_premium, w.uw_flow_24h_count, w.uw_flow_bullish_pct,
      w.insider_net_30d, w.insider_cluster_30d,
      -- Labels: forward returns from backtest_prices
      ROUND(((bp5.close  - w.reg_close) / NULLIF(w.reg_close, 0) * 100)::numeric, 2) AS ret_5d_pct,
      ROUND(((bp10.close - w.reg_close) / NULLIF(w.reg_close, 0) * 100)::numeric, 2) AS ret_10d_pct,
      CASE WHEN bp5.close  IS NOT NULL AND (bp5.close  - w.reg_close) / NULLIF(w.reg_close, 0) > 0.02 THEN 1 ELSE 0 END AS label_up_2pct_5d,
      CASE WHEN bp10.close IS NOT NULL AND (bp10.close - w.reg_close) / NULLIF(w.reg_close, 0) > 0.05 THEN 1 ELSE 0 END AS label_up_5pct_10d,
      -- price context for label computation
      w.reg_close,
      bp5.close  AS close_5d,
      bp10.close AS close_10d
      FROM with_uw w
      LEFT JOIN LATERAL (
        SELECT close FROM backtest_prices
         WHERE symbol = w.symbol AND price_date > w.price_date
         ORDER BY price_date ASC OFFSET 4 LIMIT 1
      ) bp5  ON true
      LEFT JOIN LATERAL (
        SELECT close FROM backtest_prices
         WHERE symbol = w.symbol AND price_date > w.price_date
         ORDER BY price_date ASC OFFSET 9 LIMIT 1
      ) bp10 ON true
  `);
};

export const down = (pgm) => {
  pgm.sql(`DROP VIEW IF EXISTS v_ml_training_set`);
};
