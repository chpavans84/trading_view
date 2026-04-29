/**
 * Computes historical conviction scores for every symbol/date in backtest_prices.
 * Uses the same scoring logic as scoring.js but from DB price data (no live TV needed).
 *
 * Factors included:  RSI, EMA20/50, MACD, Bollinger Bands, Relative Strength vs SPY, VIX penalty, base
 * Factors excluded:  Guidance (needs NLP), Insider buying (needs SEC), Pine levels (needs TradingView)
 *
 * Run:  npm run research:scores
 */

import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BATCH_SIZE = 20; // symbols processed in parallel

// ── Technical indicator calculations ─────────────────────────────────────────

function sma(prices, period) {
  if (prices.length < period) return null;
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function ema(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let e = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
  return e;
}

function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const changes = prices.slice(1).map((p, i) => p - prices[i]);
  let gains = 0, losses = 0;
  changes.slice(0, period).forEach(c => c > 0 ? gains += c : losses -= c);
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period; i < changes.length; i++) {
    const c = changes[i];
    avgGain = (avgGain * (period - 1) + (c > 0 ? c : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (c < 0 ? -c : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function macdHistogram(prices) {
  const e12 = ema(prices, 12);
  const e26 = ema(prices, 26);
  if (e12 == null || e26 == null) return null;
  const macdLine = e12 - e26;
  // signal = 9-day EMA of MACD — approximate using last 9 MACD values
  const macdValues = [];
  for (let i = Math.max(0, prices.length - 35); i <= prices.length - 1; i++) {
    const slice = prices.slice(0, i + 1);
    const m12 = ema(slice, 12), m26 = ema(slice, 26);
    if (m12 != null && m26 != null) macdValues.push(m12 - m26);
  }
  const signal = ema(macdValues, 9);
  return signal != null ? macdLine - signal : null;
}

function bollingerBands(prices, period = 20, mult = 2) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mid   = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  return { upper: mid + mult * std, mid, lower: mid - mult * std };
}

// ── Score from indicators ─────────────────────────────────────────────────────

function computeScore({ close, ema20, ema50, rsiVal, macdHist, bb, rsVsSpy, vix }) {
  const breakdown = { base: 30 };

  if (rsiVal != null) {
    if (rsiVal < 40) breakdown.rsi_oversold   =  20;
    if (rsiVal > 70) breakdown.rsi_overbought = -20;
  }
  if (close != null && ema20 != null && ema50 != null) {
    if (close > ema20 && close > ema50) breakdown.above_both_emas =  15;
    if (close < ema20 && close < ema50) breakdown.below_both_emas = -15;
  }
  if (macdHist != null) {
    if (macdHist > 0) breakdown.macd_positive =  10;
    if (macdHist < 0) breakdown.macd_negative = -10;
  }
  if (bb != null && close != null) {
    if (close < bb.mid)   breakdown.below_bb_mid    =  10;
    if (close > bb.upper) breakdown.above_bb_upper  = -10;
  }
  // Relative strength vs SPY over 20 days
  if (rsVsSpy != null) {
    if (rsVsSpy >  0.03) breakdown.relative_strength_strong =  15;
    if (rsVsSpy < -0.03) breakdown.relative_strength_weak   = -10;
  }
  // VIX penalty
  if (vix != null) {
    if (vix > 35) breakdown.high_vix = -20;
    else if (vix > 28) breakdown.high_vix = -10;
    else if (vix > 25) breakdown.high_vix = -5;
  }

  const raw   = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const score = Math.min(100, Math.max(0, raw));
  const grade = score >= 75 ? 'A' : score >= 50 ? 'B' : score >= 35 ? 'C' : 'F';
  return { score, grade, breakdown };
}

// ── Process one symbol ────────────────────────────────────────────────────────

async function processSymbol(symbol) {
  // Load all prices for this symbol sorted by date
  const { rows: prices } = await pool.query(
    `SELECT price_date, open, high, low, close, adj_close
     FROM backtest_prices WHERE symbol=$1 ORDER BY price_date ASC`,
    [symbol]
  );
  if (prices.length < 50) return 0; // need enough history for indicators

  // Load SPY prices for relative strength
  const { rows: spyPrices } = await pool.query(
    `SELECT price_date, close FROM backtest_prices WHERE symbol='SPY' ORDER BY price_date ASC`
  );
  const spyMap = Object.fromEntries(spyPrices.map(r => [r.price_date.toISOString().split('T')[0], parseFloat(r.close)]));

  // Load VIX prices
  const { rows: vixPrices } = await pool.query(
    `SELECT price_date, close FROM backtest_prices WHERE symbol='^VIX' ORDER BY price_date ASC`
  );
  const vixMap = Object.fromEntries(vixPrices.map(r => [r.price_date.toISOString().split('T')[0], parseFloat(r.close)]));

  let inserted = 0;
  const closes = prices.map(r => parseFloat(r.adj_close || r.close));

  for (let i = 50; i < prices.length; i++) {
    const row    = prices[i];
    const dateStr = row.price_date.toISOString().split('T')[0];
    const slice  = closes.slice(0, i + 1);
    const close  = closes[i];

    const ema20Val   = ema(slice, 20);
    const ema50Val   = ema(slice, 50);
    const rsiVal     = rsi(slice, 14);
    const macdHist   = macdHistogram(slice);
    const bb         = bollingerBands(slice, 20);
    const vix        = vixMap[dateStr] ?? null;

    // RS vs SPY: compare 20-day return of stock vs SPY
    const spy20      = spyMap[prices[i - 20]?.price_date?.toISOString()?.split('T')[0]];
    const spy0       = spyMap[dateStr];
    const stock20    = closes[i - 20];
    const rsVsSpy    = (spy20 && spy0 && stock20)
      ? ((close - stock20) / stock20) - ((spy0 - spy20) / spy20)
      : null;

    const { score, grade, breakdown } = computeScore({
      close, ema20: ema20Val, ema50: ema50Val, rsiVal, macdHist, bb, rsVsSpy, vix,
    });

    await pool.query(
      `INSERT INTO backtest_scores
         (symbol, score_date, score, grade, rsi, macd_hist, ema20, ema50,
          bb_upper, bb_mid, above_emas, rs_vs_spy, vix_close, breakdown)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (symbol, score_date) DO UPDATE SET
         score=EXCLUDED.score, grade=EXCLUDED.grade, rsi=EXCLUDED.rsi,
         macd_hist=EXCLUDED.macd_hist, ema20=EXCLUDED.ema20, ema50=EXCLUDED.ema50,
         bb_upper=EXCLUDED.bb_upper, bb_mid=EXCLUDED.bb_mid, above_emas=EXCLUDED.above_emas,
         rs_vs_spy=EXCLUDED.rs_vs_spy, vix_close=EXCLUDED.vix_close, breakdown=EXCLUDED.breakdown`,
      [
        symbol, dateStr, score, grade,
        rsiVal != null ? rsiVal.toFixed(2) : null,
        macdHist != null ? macdHist.toFixed(4) : null,
        ema20Val != null ? ema20Val.toFixed(4) : null,
        ema50Val != null ? ema50Val.toFixed(4) : null,
        bb?.upper != null ? bb.upper.toFixed(4) : null,
        bb?.mid   != null ? bb.mid.toFixed(4)   : null,
        (close != null && ema20Val != null && ema50Val != null) ? close > ema20Val && close > ema50Val : null,
        rsVsSpy != null ? rsVsSpy.toFixed(4) : null,
        vix,
        JSON.stringify(breakdown),
      ]
    );
    inserted++;
  }
  return inserted;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const { rows: syms } = await pool.query(
    `SELECT DISTINCT symbol FROM backtest_prices
     WHERE symbol NOT IN ('^VIX') ORDER BY symbol`
  );
  const symbols = syms.map(r => r.symbol);
  const total   = symbols.length;
  let done = 0, totalRows = 0;

  console.log(`\n🧮  Computing historical scores for ${total} symbols...\n`);

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch   = symbols.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async sym => {
      const count = await processSymbol(sym);
      return { sym, count };
    }));

    for (const { sym, count } of results) {
      done++;
      totalRows += count;
      const pct = ((done / total) * 100).toFixed(1);
      console.log(`  ✓ [${pct}%] ${sym.padEnd(8)} ${count} scored dates`);
    }
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*) as rows, COUNT(DISTINCT symbol) as syms FROM backtest_scores`
  );
  console.log(`\n✅  Done. ${rows[0].rows} total score records across ${rows[0].syms} symbols.\n`);
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
