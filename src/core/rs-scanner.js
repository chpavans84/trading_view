/**
 * src/core/rs-scanner.js
 *
 * M4 — Relative Strength Scanner.
 * Computes per-symbol RS vs SPY and vs sector ETF for every symbol in
 * backtest_prices with recent price data.  Runs daily after market close.
 *
 * Exports:
 *   runRsScanner(calcDate?)  — compute + upsert RS for all symbols.
 *                              calcDate defaults to today (YYYY-MM-DD).
 *   getTopRsByDate(date, n)  — top n symbols by rs_vs_spy_5d on a given date.
 *   getRsForSymbol(symbol, days) — last `days` rows for one symbol.
 */

import { query } from './db.js';

// ─── Sector ETF map ───────────────────────────────────────────────────────────
// Yahoo Finance sector → SPDR sector ETF.  Symbols not in tradable_universe
// (or with null sector) fall back to SPY comparison only (sector_etf = null).
const SECTOR_ETF_MAP = {
  'Technology':             'XLK',
  'Healthcare':             'XLV',
  'Financial Services':     'XLF',
  'Industrials':            'XLI',
  'Consumer Cyclical':      'XLY',
  'Consumer Defensive':     'XLP',
  'Energy':                 'XLE',
  'Basic Materials':        'XLB',
  'Real Estate':            'XLRE',
  'Communication Services': 'XLC',
  'Utilities':              'XLU',
};

// ─── runRsScanner ─────────────────────────────────────────────────────────────

/**
 * Main entry point.  Queries backtest_prices, computes RS, upserts into
 * relative_strength.  Returns a summary object.
 */
export async function runRsScanner(calcDate = null) {
  const dateStr = calcDate ?? new Date().toISOString().slice(0, 10);
  console.log(`[rs-scanner] starting scan for ${dateStr}`);

  // ── 1. Get latest price + 5d-ago price + 20d-ago price for every symbol ───
  // Only consider symbols in tradable_universe with adv_dollar_30d >= $1M and
  // last_price >= $3 to filter out penny stocks / illiquid names. Sector ETFs
  // (SPY, XLK…) are included unconditionally for benchmark computation.
  // Use ROW_NUMBER() so we don't need to know exact trading-day offsets.
  // row_num=1 → most recent close; row_num=6 → 5 trading days ago; row_num=21 → 20 days ago.
  const SECTOR_ETFS_SET = new Set(['SPY', ...Object.values(SECTOR_ETF_MAP)]);

  const { rows: priceRows } = await query(`
    WITH liquid AS (
      -- symbols that pass liquidity filter OR are benchmark ETFs
      SELECT tu.symbol
      FROM tradable_universe tu
      WHERE tu.adv_dollar_30d >= 1000000
        AND tu.last_price >= 3
      UNION
      SELECT unnest($2::text[]) AS symbol
    ),
    ranked AS (
      SELECT bp.symbol, bp.price_date, bp.close,
             ROW_NUMBER() OVER (PARTITION BY bp.symbol ORDER BY bp.price_date DESC) AS rn
      FROM backtest_prices bp
      JOIN liquid l ON l.symbol = bp.symbol
      WHERE bp.price_date <= $1::date
    )
    SELECT
      symbol,
      MAX(CASE WHEN rn = 1  THEN close END) AS close_now,
      MAX(CASE WHEN rn = 6  THEN close END) AS close_5d,
      MAX(CASE WHEN rn = 21 THEN close END) AS close_20d
    FROM ranked
    WHERE rn <= 21
    GROUP BY symbol
    HAVING MAX(CASE WHEN rn = 1 THEN price_date END) >= $1::date - INTERVAL '3 days'
       -- require close >= $5 now AND >= $3 five days ago to filter penny-stock parabolas
       AND MAX(CASE WHEN rn = 1 THEN close END) >= 5
       AND (MAX(CASE WHEN rn = 6 THEN close END) IS NULL
            OR MAX(CASE WHEN rn = 6 THEN close END) >= 3)
  `, [dateStr, ['SPY', ...Object.values(SECTOR_ETF_MAP)]]);

  if (!priceRows.length) {
    console.warn(`[rs-scanner] no price data for ${dateStr}`);
    return { calcDate: dateStr, symbolsProcessed: 0, inserted: 0 };
  }

  // Build a lookup: symbol → { close_now, close_5d, close_20d }
  const prices = {};
  for (const r of priceRows) {
    prices[r.symbol] = {
      now:  r.close_now  != null ? Number(r.close_now)  : null,
      d5:   r.close_5d   != null ? Number(r.close_5d)   : null,
      d20:  r.close_20d  != null ? Number(r.close_20d)  : null,
    };
  }

  // ── 2. SPY benchmark returns ──────────────────────────────────────────────
  const spy = prices['SPY'];
  if (!spy?.now || !spy?.d5) {
    console.warn('[rs-scanner] SPY price data missing — aborting');
    return { calcDate: dateStr, symbolsProcessed: 0, inserted: 0 };
  }
  const spyRet5d  = spy.d5  > 0 ? (spy.now - spy.d5)  / spy.d5  * 100 : null;
  const spyRet20d = spy.d20 > 0 ? (spy.now - spy.d20) / spy.d20 * 100 : null;

  // ── 3. Sector ETF benchmark returns ──────────────────────────────────────
  const etfRet5d = {};
  for (const etf of Object.values(SECTOR_ETF_MAP)) {
    const p = prices[etf];
    if (p?.now && p?.d5 && p.d5 > 0) {
      etfRet5d[etf] = (p.now - p.d5) / p.d5 * 100;
    }
  }

  // ── 4. Symbol → sector ETF map (from tradable_universe) ──────────────────
  const { rows: univRows } = await query(
    `SELECT symbol, sector FROM tradable_universe WHERE sector IS NOT NULL`
  );
  const symbolSector = {};
  for (const r of univRows) {
    symbolSector[r.symbol] = SECTOR_ETF_MAP[r.sector] ?? null;
  }

  // ── 5. Compute RS for every symbol with data ──────────────────────────────
  const records = [];
  for (const [sym, p] of Object.entries(prices)) {
    if (sym === 'SPY' || !p.now || !p.d5 || p.d5 <= 0) continue;

    const ret5d  = (p.now - p.d5)  / p.d5  * 100;
    const ret20d = (p.d20 && p.d20 > 0)
      ? (p.now - p.d20) / p.d20 * 100
      : null;

    const rs5d  = spyRet5d  != null ? ret5d  - spyRet5d  : null;
    const rs20d = (spyRet20d != null && ret20d != null) ? ret20d - spyRet20d : null;

    const etf   = symbolSector[sym] ?? null;
    const rsSec = (etf && etfRet5d[etf] != null) ? ret5d - etfRet5d[etf] : null;

    records.push({
      symbol:          sym,
      return_5d:       +ret5d.toFixed(4),
      return_20d:      ret20d != null ? +ret20d.toFixed(4) : null,
      rs_vs_spy_5d:    rs5d   != null ? +rs5d.toFixed(4)   : null,
      rs_vs_spy_20d:   rs20d  != null ? +rs20d.toFixed(4)  : null,
      rs_vs_sector_5d: rsSec  != null ? +rsSec.toFixed(4)  : null,
      sector_etf:      etf,
    });
  }

  if (!records.length) {
    console.warn('[rs-scanner] no RS records computed');
    return { calcDate: dateStr, symbolsProcessed: 0, inserted: 0 };
  }

  // ── 6. Compute ranks ──────────────────────────────────────────────────────
  // overall rank by rs_vs_spy_5d (descending, nulls last)
  const withRs = records.filter(r => r.rs_vs_spy_5d != null);
  withRs.sort((a, b) => b.rs_vs_spy_5d - a.rs_vs_spy_5d);
  withRs.forEach((r, i) => { r.rank_overall = i + 1; });

  // sector rank by rs_vs_sector_5d within each sector_etf
  const bySector = {};
  for (const r of records) {
    if (!r.sector_etf || r.rs_vs_sector_5d == null) continue;
    if (!bySector[r.sector_etf]) bySector[r.sector_etf] = [];
    bySector[r.sector_etf].push(r);
  }
  for (const arr of Object.values(bySector)) {
    arr.sort((a, b) => b.rs_vs_sector_5d - a.rs_vs_sector_5d);
    arr.forEach((r, i) => { r.rank_sector = i + 1; });
  }

  // ── 7. Upsert into relative_strength ────────────────────────────────────
  let inserted = 0;
  const BATCH = 500;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    // Build multi-row INSERT … ON CONFLICT DO UPDATE
    const vals  = [];
    const params = [];
    let   pIdx  = 1;
    for (const r of batch) {
      vals.push(
        `($${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++})`
      );
      params.push(
        r.symbol, dateStr,
        r.return_5d, r.return_20d,
        r.rs_vs_spy_5d, r.rs_vs_spy_20d,
        r.rs_vs_sector_5d, r.sector_etf,
        r.rank_sector ?? null, r.rank_overall ?? null
      );
    }
    await query(
      `INSERT INTO relative_strength
         (symbol, calc_date, return_5d, return_20d,
          rs_vs_spy_5d, rs_vs_spy_20d,
          rs_vs_sector_5d, sector_etf,
          rank_sector, rank_overall)
       VALUES ${vals.join(',')}
       ON CONFLICT (symbol, calc_date) DO UPDATE SET
         return_5d       = EXCLUDED.return_5d,
         return_20d      = EXCLUDED.return_20d,
         rs_vs_spy_5d    = EXCLUDED.rs_vs_spy_5d,
         rs_vs_spy_20d   = EXCLUDED.rs_vs_spy_20d,
         rs_vs_sector_5d = EXCLUDED.rs_vs_sector_5d,
         sector_etf      = EXCLUDED.sector_etf,
         rank_sector     = EXCLUDED.rank_sector,
         rank_overall    = EXCLUDED.rank_overall,
         computed_at     = NOW()`,
      params
    );
    inserted += batch.length;
  }

  console.log(`[rs-scanner] ${dateStr}: ${inserted} symbols upserted (SPY 5d=${spyRet5d?.toFixed(2)}%)`);
  return { calcDate: dateStr, symbolsProcessed: records.length, inserted, spyRet5d, spyRet20d };
}

// ─── Query helpers ────────────────────────────────────────────────────────────

/**
 * Return top n symbols by rs_vs_spy_5d on a given date (default today).
 * maxRs caps the RS to exclude corporate-event outliers (SPACs, reverse mergers).
 * Defaults to 150% — filters stocks that 10×+ in a week (events, not momentum).
 */
export async function getTopRsByDate({ date = null, n = 20, sectorEtf = null, maxRs = 150 } = {}) {
  const d = date ?? new Date().toISOString().slice(0, 10);
  const { rows } = await query(
    `SELECT symbol, return_5d, rs_vs_spy_5d, rs_vs_sector_5d, sector_etf,
            rank_sector, rank_overall
     FROM relative_strength
     WHERE calc_date = $1
       AND rs_vs_spy_5d IS NOT NULL
       AND rs_vs_spy_5d <= $3
       ${sectorEtf ? 'AND sector_etf = $4' : ''}
     ORDER BY rs_vs_spy_5d DESC
     LIMIT $2`,
    sectorEtf ? [d, n, maxRs, sectorEtf] : [d, n, maxRs]
  );
  return rows;
}

/**
 * Return RS history for a single symbol (most recent `days` entries).
 */
export async function getRsForSymbol(symbol, days = 30) {
  const { rows } = await query(
    `SELECT calc_date, return_5d, rs_vs_spy_5d, rs_vs_sector_5d,
            sector_etf, rank_sector, rank_overall
     FROM relative_strength
     WHERE symbol = $1
     ORDER BY calc_date DESC
     LIMIT $2`,
    [symbol.toUpperCase(), days]
  );
  return rows;
}

/**
 * Return the latest RS snapshot for every symbol in a given sector ETF,
 * sorted by rs_vs_sector_5d descending.
 */
export async function getSectorLeaderboard(sectorEtf) {
  const { rows } = await query(
    `SELECT DISTINCT ON (symbol)
            symbol, calc_date, return_5d,
            rs_vs_spy_5d, rs_vs_sector_5d, rank_sector, rank_overall
     FROM relative_strength
     WHERE sector_etf = $1
     ORDER BY symbol, calc_date DESC`,
    [sectorEtf.toUpperCase()]
  );
  rows.sort((a, b) => Number(b.rs_vs_sector_5d ?? -999) - Number(a.rs_vs_sector_5d ?? -999));
  return rows;
}
