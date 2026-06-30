#!/usr/bin/env node
/**
 * scripts/refresh-sector-rotation.mjs
 * Rebuilds/refreshes `sector_rotation` from backtest_prices for any missing dates.
 *
 * WHY THIS EXISTS: the table was populated once during the 2026-06-01 ML-pipeline
 * session and the writer was never committed/scheduled — it silently froze on
 * 2026-05-29 while v_ml_training_set and sector-context features kept LEFT-JOINing
 * NULLs. (Found in the 2026-06-12 data-gap audit.)
 *
 * Faithful to the original computation (verified against existing rows):
 *   chg_Nd        = pct change vs N trading days back
 *   rel_vs_spy_Nd = chg_Nd − SPY chg_Nd
 *   mom_score     = chg_1d − chg_20d          (short-term vs 20d reversal spread)
 *   rank_Nd       = rank among SECTOR ETFs only (1 = best), NULL for index ETFs
 *
 * ETF set + labels are read from the table's own existing rows, so additions
 * only require inserting one seed row. Idempotent (ON CONFLICT DO UPDATE).
 *
 * Usage: node scripts/refresh-sector-rotation.mjs [--days 40]
 */
import 'dotenv/config';
import { query, initDb } from '../src/core/db.js';

const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 40;

async function main() {
  await initDb();
  const { rows } = await query(`
    WITH etfs AS (
      SELECT DISTINCT etf_symbol, sector_label, is_sector FROM sector_rotation
    ),
    px AS (
      SELECT bp.symbol, bp.price_date, bp.close,
             lag(bp.close, 1)  OVER w AS c1,
             lag(bp.close, 5)  OVER w AS c5,
             lag(bp.close, 20) OVER w AS c20
      FROM backtest_prices bp
      JOIN etfs e ON e.etf_symbol = bp.symbol
      WHERE bp.price_date > CURRENT_DATE - ($1::int + 45)
      WINDOW w AS (PARTITION BY bp.symbol ORDER BY bp.price_date)
    ),
    chg AS (
      SELECT p.symbol, p.price_date, p.close,
             round((100*(p.close - c1)/NULLIF(c1,0))::numeric, 2)  AS chg_1d,
             round((100*(p.close - c5)/NULLIF(c5,0))::numeric, 2)  AS chg_5d,
             round((100*(p.close - c20)/NULLIF(c20,0))::numeric, 2) AS chg_20d
      FROM px p WHERE p.price_date > CURRENT_DATE - $1::int
    ),
    spy AS (SELECT price_date, chg_1d AS s1, chg_5d AS s5 FROM chg WHERE symbol = 'SPY'),
    full_calc AS (
      SELECT c.price_date, c.symbol AS etf_symbol, e.sector_label, c.close,
             c.chg_1d, c.chg_5d, c.chg_20d,
             CASE WHEN e.is_sector THEN rank() OVER (PARTITION BY c.price_date, e.is_sector ORDER BY c.chg_1d  DESC NULLS LAST) END AS rank_1d,
             CASE WHEN e.is_sector THEN rank() OVER (PARTITION BY c.price_date, e.is_sector ORDER BY c.chg_5d  DESC NULLS LAST) END AS rank_5d,
             CASE WHEN e.is_sector THEN rank() OVER (PARTITION BY c.price_date, e.is_sector ORDER BY c.chg_20d DESC NULLS LAST) END AS rank_20d,
             round((c.chg_1d - spy.s1)::numeric, 2) AS rel_vs_spy_1d,
             round((c.chg_5d - spy.s5)::numeric, 2) AS rel_vs_spy_5d,
             round((c.chg_1d - c.chg_20d)::numeric, 2) AS mom_score,
             e.is_sector
      FROM chg c
      JOIN etfs e ON e.etf_symbol = c.symbol
      LEFT JOIN spy ON spy.price_date = c.price_date
    )
    INSERT INTO sector_rotation
      (price_date, etf_symbol, sector_label, close, chg_1d, chg_5d, chg_20d,
       rank_1d, rank_5d, rank_20d, rel_vs_spy_1d, rel_vs_spy_5d, mom_score, is_sector, computed_at)
    SELECT price_date, etf_symbol, sector_label, close, chg_1d, chg_5d, chg_20d,
           rank_1d, rank_5d, rank_20d, rel_vs_spy_1d, rel_vs_spy_5d, mom_score, is_sector, now()
    FROM full_calc
    ON CONFLICT (price_date, etf_symbol) DO UPDATE SET
      close=EXCLUDED.close, chg_1d=EXCLUDED.chg_1d, chg_5d=EXCLUDED.chg_5d, chg_20d=EXCLUDED.chg_20d,
      rank_1d=EXCLUDED.rank_1d, rank_5d=EXCLUDED.rank_5d, rank_20d=EXCLUDED.rank_20d,
      rel_vs_spy_1d=EXCLUDED.rel_vs_spy_1d, rel_vs_spy_5d=EXCLUDED.rel_vs_spy_5d,
      mom_score=EXCLUDED.mom_score, computed_at=now()
    RETURNING price_date`, [DAYS]);
  const dates = [...new Set(rows.map(r => String(r.price_date instanceof Date ? r.price_date.toISOString() : r.price_date).slice(0, 10)))].sort();
  console.log(`[sector-rotation] upserted ${rows.length} rows across ${dates.length} dates (${dates[0]} → ${dates.at(-1)})`);
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
