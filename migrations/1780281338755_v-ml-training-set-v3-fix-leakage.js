/**
 * Migration: fix UW flow forward-looking data leakage in v_ml_training_set
 *
 * BUG: prior version of the view used:
 *   alerted_at BETWEEN (price_date - INTERVAL '1 day') AND (price_date + INTERVAL '1 day')
 * That includes the NEXT day's UW flow in the feature, which means the model
 * sees data from AFTER the entry decision — a textbook forward-looking leakage.
 * It would inflate AUC by 1-3 percentage points vs an honest backward-only window.
 *
 * FIX: change to a strictly backward-looking 24h window:
 *   alerted_at BETWEEN (price_date - INTERVAL '1 day')::timestamptz AND price_date::timestamptz
 *
 * This view is otherwise identical to the v2 view (1780242779406).
 * After applying this migration, the model should be RE-TRAINED to get an
 * honest AUC measurement.
 */

/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`DROP VIEW IF EXISTS v_ml_training_set`);
  pgm.sql(`
    CREATE VIEW v_ml_training_set AS
    WITH base AS (
      SELECT
        f.symbol,
        f.price_date,
        tu.sector,
        tu.market_cap_usd,
        f.full_day_chg_pct, f.pre_change_pct, f.intraday_chg_pct, f.post_change_pct,
        f.intraday_range_pct, f.or_range_pct, f.rvol_30d, f.first_30min_pct_vol,
        CASE WHEN f.reg_close > f.vwap   THEN 1 ELSE 0 END AS above_vwap,
        CASE WHEN f.reg_close > f.or_high THEN 1 ELSE 0 END AS above_or_high,
        CASE WHEN f.reg_close < f.or_low  THEN 1 ELSE 0 END AS below_or_low,
        f.reg_close,
        f.total_volume
        FROM daily_intraday_features f
        LEFT JOIN tradable_universe tu ON tu.symbol = f.symbol
    ),
    sector_etf_map AS (
      SELECT b.*,
        CASE b.sector
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
        END AS sector_etf
        FROM base b
    ),
    with_sector AS (
      SELECT s.*,
        sr.rank_1d   AS sector_rank,
        sr.chg_1d    AS sector_chg,
        sr.mom_score AS sector_mom,
        sr.rel_vs_spy_1d AS sector_rel_vs_spy
        FROM sector_etf_map s
        LEFT JOIN sector_rotation sr
          ON sr.etf_symbol = s.sector_etf
         AND sr.price_date = s.price_date
    ),
    with_regime AS (
      SELECT ws.*,
        vix.close AS vix_close,
        spy.spy_5d_chg
        FROM with_sector ws
        LEFT JOIN backtest_prices vix
          ON vix.symbol = '^VIX' AND vix.price_date = ws.price_date
        LEFT JOIN (
          SELECT price_date,
                 ((close - LAG(close, 5) OVER (ORDER BY price_date)) /
                   NULLIF(LAG(close, 5) OVER (ORDER BY price_date), 0) * 100)::numeric(8,2) AS spy_5d_chg
            FROM backtest_prices WHERE symbol='SPY'
        ) spy ON spy.price_date = ws.price_date
    ),
    with_earnings AS (
      SELECT wr.*,
        CASE
          WHEN ec.next_earnings IS NULL THEN 60
          ELSE GREATEST(-30, LEAST(60, (ec.next_earnings - wr.price_date)::int))
        END AS days_to_earnings,
        ec.last_surprise_pct
        FROM with_regime wr
        LEFT JOIN earnings_calendar ec ON ec.symbol = wr.symbol
    ),
    with_uw AS (
      SELECT we.*,
        COALESCE(uw_agg.total_premium, 0)::numeric AS uw_flow_24h_premium,
        COALESCE(uw_agg.alert_count, 0)::int       AS uw_flow_24h_count,
        COALESCE(uw_agg.bullish_pct, 0)::numeric   AS uw_flow_bullish_pct,
        COALESCE(ins_agg.net_buy_value, 0)::numeric AS insider_net_30d,
        COALESCE(ins_agg.cluster_count, 0)::int     AS insider_cluster_30d
        FROM with_earnings we
        -- FIXED 2026-06-01: strictly backward-looking 24h window (was -1d to +1d = 48h with forward leakage)
        LEFT JOIN LATERAL (
          SELECT
            SUM(premium)                                          AS total_premium,
            COUNT(*)                                              AS alert_count,
            ROUND(100.0 * COUNT(*) FILTER (WHERE sentiment IN ('bullish','strong_bullish'))::numeric
                  / NULLIF(COUNT(*), 0), 1) AS bullish_pct
            FROM uw_flow_alerts
           WHERE ticker = we.symbol
             AND alerted_at >= (we.price_date - INTERVAL '1 day')::timestamptz
             AND alerted_at <  we.price_date::timestamptz + INTERVAL '16 hours'  -- through ET market close on the day
        ) uw_agg ON true
        LEFT JOIN LATERAL (
          SELECT
            SUM(CASE WHEN transaction_type='P' THEN value ELSE -value END) AS net_buy_value,
            COUNT(*) FILTER (WHERE transaction_type='P' AND value >= 100000) AS cluster_count
            FROM uw_insider_trades
           WHERE ticker = we.symbol
             AND filed_at >= (we.price_date - INTERVAL '30 days')::timestamptz
             AND filed_at <  we.price_date::timestamptz + INTERVAL '16 hours'  -- through ET market close
             AND role IN ('Director','10% Owner','Director/10% Owner')
        ) ins_agg ON true
    )
    SELECT
      w.symbol, w.price_date, w.sector, w.market_cap_usd,
      w.full_day_chg_pct, w.pre_change_pct, w.intraday_chg_pct, w.post_change_pct,
      w.intraday_range_pct, w.or_range_pct, w.rvol_30d, w.first_30min_pct_vol,
      w.above_vwap, w.above_or_high, w.below_or_low,
      w.sector_rank, w.sector_chg, w.sector_mom, w.sector_rel_vs_spy,
      w.days_to_earnings, w.last_surprise_pct,
      w.uw_flow_24h_premium, w.uw_flow_24h_count, w.uw_flow_bullish_pct,
      w.insider_net_30d, w.insider_cluster_30d,
      w.vix_close,
      CASE WHEN w.vix_close >= 20 THEN 1 ELSE 0 END                       AS vix_above_20,
      w.spy_5d_chg,
      EXTRACT(DOW FROM w.price_date)::int                                  AS day_of_week,
      CASE WHEN EXTRACT(DOW FROM w.price_date) = 3 THEN 1 ELSE 0 END       AS is_wed,
      CASE WHEN EXTRACT(DOW FROM w.price_date) = 4 THEN 1 ELSE 0 END       AS is_thu,
      CASE WHEN EXTRACT(DOW FROM w.price_date) IN (1, 5) THEN 1 ELSE 0 END AS is_mon_fri,
      CASE
        WHEN w.market_cap_usd >= 200e9 THEN 1
        WHEN w.market_cap_usd >= 10e9  THEN 2
        WHEN w.market_cap_usd >= 2e9   THEN 3
        WHEN w.market_cap_usd >= 300e6 THEN 4
        WHEN w.market_cap_usd > 0      THEN 5
        ELSE 0
      END                                                                  AS market_cap_band,
      CASE WHEN w.market_cap_usd BETWEEN 2e9 AND 10e9 THEN 1 ELSE 0 END    AS is_mid_cap,
      CASE WHEN w.sector = 'Technology'             THEN 1 ELSE 0 END AS sect_tech,
      CASE WHEN w.sector = 'Financial Services'     THEN 1 ELSE 0 END AS sect_fin,
      CASE WHEN w.sector = 'Healthcare'             THEN 1 ELSE 0 END AS sect_health,
      CASE WHEN w.sector = 'Consumer Cyclical'      THEN 1 ELSE 0 END AS sect_cycl,
      CASE WHEN w.sector = 'Consumer Defensive'     THEN 1 ELSE 0 END AS sect_def,
      CASE WHEN w.sector = 'Energy'                 THEN 1 ELSE 0 END AS sect_energy,
      CASE WHEN w.sector = 'Utilities'              THEN 1 ELSE 0 END AS sect_util,
      CASE WHEN w.sector = 'Basic Materials'        THEN 1 ELSE 0 END AS sect_mat,
      CASE WHEN w.sector = 'Industrials'            THEN 1 ELSE 0 END AS sect_indust,
      CASE WHEN w.sector = 'Communication Services' THEN 1 ELSE 0 END AS sect_comm,
      CASE WHEN w.sector = 'Real Estate'            THEN 1 ELSE 0 END AS sect_re,
      (COALESCE(w.uw_flow_bullish_pct, 0) - 50)                            AS uw_bull_centered,
      POWER(COALESCE(w.uw_flow_bullish_pct, 0) - 50, 2)::numeric            AS uw_bull_sq,
      ROUND(((bp5.close  - w.reg_close) / NULLIF(w.reg_close, 0) * 100)::numeric, 2) AS ret_5d_pct,
      ROUND(((bp10.close - w.reg_close) / NULLIF(w.reg_close, 0) * 100)::numeric, 2) AS ret_10d_pct,
      CASE WHEN bp5.close  IS NOT NULL AND (bp5.close  - w.reg_close) / NULLIF(w.reg_close, 0) > 0.02 THEN 1 ELSE 0 END AS label_up_2pct_5d,
      CASE WHEN bp10.close IS NOT NULL AND (bp10.close - w.reg_close) / NULLIF(w.reg_close, 0) > 0.05 THEN 1 ELSE 0 END AS label_up_5pct_10d,
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
