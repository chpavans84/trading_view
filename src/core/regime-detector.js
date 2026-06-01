/**
 * src/core/regime-detector.js
 *
 * Market-wide regime detector. Observational only — does NOT change
 * bot entry/exit logic. Computes and persists regime snapshots.
 *
 * Exports:
 *   computeRegime()         — compute a fresh regime object from backtest_prices
 *   saveRegimeSnapshot(obj) — persist to regime_snapshots table
 *   getCurrentRegime()      — read most recent snapshot (or compute if stale > 24h)
 */

import { query } from './db.js';

const SECTOR_ETFS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLB', 'XLP', 'XLY', 'XLRE', 'XLC', 'XLU'];

// ─── Math helpers ─────────────────────────────────────────────────────────────

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ─── computeRegime ─────────────────────────────────────────────────────────────

/**
 * Queries backtest_prices for SPY + sector ETFs and returns a regime object.
 * Never throws — returns a best-effort result with notes on any data gaps.
 */
export async function computeRegime() {
  const notes = [];

  // ── 1. Fetch last 60 SPY closes ─────────────────────────────────────────────
  const { rows: spyRows } = await query(
    `SELECT price_date, close
     FROM backtest_prices
     WHERE symbol = 'SPY'
     ORDER BY price_date DESC
     LIMIT 60`,
    []
  );

  if (spyRows.length < 14) {
    return {
      regime: 'neutral',
      strength: 20,
      spy_slope_50d: null,
      spy_pct_from_50d: null,
      vix_proxy: null,
      vix_5d_change: null,
      sector_leaders: [],
      sector_laggers: [],
      notes: 'insufficient_spy_data',
    };
  }

  // spyRows[0] is most recent
  const closes = spyRows.map(r => Number(r.close));
  const currentClose = closes[0];

  // ── 2. SPY 50d MA + slope ────────────────────────────────────────────────────
  let spy_ma50 = null;
  let spy_slope_50d = null;
  let spy_pct_from_50d = null;

  if (closes.length >= 50) {
    const last50 = closes.slice(0, 50);
    spy_ma50 = mean(last50);
    // Simple slope: (first price chronologically = last50[49]) to (most recent = last50[0])
    const oldest = last50[49]; // 50 days ago
    const newest = last50[0];  // today
    spy_slope_50d = oldest > 0
      ? Number(((newest - oldest) / (50 * oldest)).toFixed(6))
      : null;
    spy_pct_from_50d = spy_ma50 > 0
      ? Number(((currentClose - spy_ma50) / spy_ma50 * 100).toFixed(4))
      : null;
  } else {
    notes.push('less_than_50d_spy_data');
    const usableCloses = closes;
    spy_ma50 = mean(usableCloses);
    spy_pct_from_50d = spy_ma50 > 0
      ? Number(((currentClose - spy_ma50) / spy_ma50 * 100).toFixed(4))
      : null;
  }

  // ── 3. VIX proxy: 5d realized vol (annualized) ──────────────────────────────
  // Need at least 6 closes for 5 daily returns
  let vix_proxy = null;
  let vix_5d_change = null;

  if (closes.length >= 6) {
    // Current 5d vol: last 5 daily returns (closes[0..5])
    const returns5d = [];
    for (let i = 0; i < 5; i++) {
      if (closes[i + 1] > 0) returns5d.push((closes[i] - closes[i + 1]) / closes[i + 1]);
    }
    if (returns5d.length >= 4) {
      vix_proxy = Number((stdev(returns5d) * Math.sqrt(252) * 100).toFixed(4));
    }
  }

  // "Old" vix proxy: 5 returns starting 10 days ago (closes[10..15])
  if (closes.length >= 16 && vix_proxy !== null) {
    const returns5dOld = [];
    for (let i = 10; i < 15; i++) {
      if (closes[i + 1] > 0) returns5dOld.push((closes[i] - closes[i + 1]) / closes[i + 1]);
    }
    if (returns5dOld.length >= 4) {
      const oldVix = stdev(returns5dOld) * Math.sqrt(252) * 100;
      vix_5d_change = oldVix > 0
        ? Number(((vix_proxy - oldVix) / oldVix * 100).toFixed(4))
        : null;
    }
  }

  // ── 4. Sector ETF RS scores ──────────────────────────────────────────────────
  // For each sector ETF: 5d return vs SPY 5d return = RS score
  const spy5dReturn = closes[5] > 0 ? (closes[0] - closes[5]) / closes[5] : null;

  const sectorRS = [];

  if (spy5dReturn !== null) {
    // Fetch last 6 closes for all sector ETFs in one query
    const { rows: etfRows } = await query(
      `SELECT symbol, price_date, close
       FROM backtest_prices
       WHERE symbol = ANY($1)
       ORDER BY symbol, price_date DESC`,
      [SECTOR_ETFS]
    );

    // Group by symbol, keep most recent 6
    const bySymbol = {};
    for (const r of etfRows) {
      if (!bySymbol[r.symbol]) bySymbol[r.symbol] = [];
      if (bySymbol[r.symbol].length < 6) {
        bySymbol[r.symbol].push(Number(r.close));
      }
    }

    for (const sym of SECTOR_ETFS) {
      const etfCloses = bySymbol[sym];
      if (!etfCloses || etfCloses.length < 6) {
        notes.push(`missing_etf_data:${sym}`);
        continue;
      }
      const etf5dReturn = etfCloses[5] > 0
        ? (etfCloses[0] - etfCloses[5]) / etfCloses[5]
        : null;
      if (etf5dReturn === null) continue;
      sectorRS.push({ symbol: sym, rs: etf5dReturn - spy5dReturn });
    }
  }

  // Sort by RS
  sectorRS.sort((a, b) => b.rs - a.rs);
  const sector_leaders = sectorRS.slice(0, 3).map(r => r.symbol);
  const sector_laggers = sectorRS.slice(-3).reverse().map(r => r.symbol);

  // ── 5. Classify regime ──────────────────────────────────────────────────────
  const effectiveVix    = vix_proxy ?? 20;
  const effectiveSlope  = spy_slope_50d ?? 0;
  const effectivePctMa  = spy_pct_from_50d ?? 0;
  const effectiveChange = vix_5d_change ?? 0;

  // Slope formula: (newest - oldest) / (50 × oldest) — a per-day price change
  // normalized by the 50-day-ago price.  Typical values: ±0.0002 – ±0.003.
  // Threshold calibration (2026-05-29):
  //   +0.0005 ≈ +2.5% over 50 days = mild uptrend  → risk_on candidate
  //   -0.0005 ≈ -2.5% over 50 days = mild downtrend → risk_off candidate
  // Previous thresholds (0.05 / -0.05) were off by 100× and could never fire.
  let regime;
  if (effectiveVix > 35 || effectiveChange > 40) {
    regime = 'vol_spike';
  } else if (effectiveSlope < -0.0005 || effectivePctMa < -2) {
    regime = 'risk_off';
  } else if (effectiveSlope > 0.0005 && effectivePctMa > 0 && effectiveVix < 22) {
    regime = 'risk_on';
  } else {
    regime = 'neutral';
  }

  // ── 6. Strength ─────────────────────────────────────────────────────────────
  let strength;
  if (regime === 'vol_spike') {
    strength = 100;
  } else {
    strength = clamp(
      Math.abs(effectiveSlope) * 1000 + Math.abs(effectivePctMa) * 5,
      20,
      95
    );
  }
  strength = Number(strength.toFixed(2));

  return {
    regime,
    strength,
    spy_slope_50d: spy_slope_50d !== null ? Number(spy_slope_50d.toFixed(4)) : null,
    spy_pct_from_50d: spy_pct_from_50d !== null ? Number(spy_pct_from_50d.toFixed(4)) : null,
    vix_proxy: vix_proxy !== null ? Number(vix_proxy.toFixed(4)) : null,
    vix_5d_change: vix_5d_change !== null ? Number(vix_5d_change.toFixed(4)) : null,
    sector_leaders,
    sector_laggers,
    notes: notes.length > 0 ? notes.join('; ') : null,
  };
}

// ─── saveRegimeSnapshot ────────────────────────────────────────────────────────

/**
 * Persist a regime object to regime_snapshots.
 * Returns the new row's id.
 */
export async function saveRegimeSnapshot(r) {
  const { rows } = await query(
    `INSERT INTO regime_snapshots
       (regime, strength, spy_slope_50d, spy_pct_from_50d, vix_proxy, vix_5d_change,
        sector_leaders, sector_laggers, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, snapshot_at`,
    [
      r.regime,
      r.strength ?? null,
      r.spy_slope_50d ?? null,
      r.spy_pct_from_50d ?? null,
      r.vix_proxy ?? null,
      r.vix_5d_change ?? null,
      r.sector_leaders?.length ? r.sector_leaders : null,
      r.sector_laggers?.length ? r.sector_laggers : null,
      r.notes ?? null,
    ]
  );
  return rows[0];
}

// ─── getCurrentRegime ──────────────────────────────────────────────────────────

/**
 * Returns the most recent regime_snapshots row.
 * If the most recent row is older than 24 hours (or the table is empty),
 * computes a fresh snapshot, saves it, and returns it.
 */
export async function getCurrentRegime() {
  const { rows } = await query(
    `SELECT * FROM regime_snapshots ORDER BY snapshot_at DESC LIMIT 1`,
    []
  );

  if (rows.length > 0) {
    const ageMs = Date.now() - new Date(rows[0].snapshot_at).getTime();
    if (ageMs < 24 * 60 * 60 * 1000) {
      return rows[0];
    }
  }

  // Stale or empty — compute and save
  const regimeObj = await computeRegime();
  const saved = await saveRegimeSnapshot(regimeObj);
  return { ...regimeObj, id: saved.id, snapshot_at: saved.snapshot_at };
}
