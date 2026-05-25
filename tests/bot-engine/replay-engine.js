/**
 * tests/bot-engine/replay-engine.js
 *
 * Core simulator. Iterates trading days, calls the strategy function on each,
 * simulates fills against next-bar opens, tracks positions, accumulates equity.
 *
 * Designed to be data-source agnostic — pass in a `marketData` object that
 * exposes `getDailyBars(symbol)`, `getOpenAt(symbol, ts)`, etc. The actual
 * data layer (databento_ohlcv_1m vs backtest_prices) is injected.
 */

import pg from 'pg';

const { Pool } = pg;

// ─── Portfolio ───────────────────────────────────────────────────────────────
class Portfolio {
  constructor({ initialCapital, maxPositions, positionSizeUsd }) {
    this.cash             = initialCapital;
    this.initialCapital   = initialCapital;
    this.maxPositions     = maxPositions ?? 10;
    this.positionSizeUsd  = positionSizeUsd ?? 10_000;
    this.positions        = new Map();   // symbol → { qty, entryPrice, openedAt, stopPrice, peakPnl }
    this.closedTrades     = [];
    this.equityCurve      = [];
  }

  has(symbol) { return this.positions.has(symbol); }
  positionCount() { return this.positions.size; }
  availableSlots() { return this.maxPositions - this.positions.size; }

  /** Open a position at fillPrice. Returns the position object or null if no cash/slots.
   *
   *  Extra fields (all optional, for day-trade / take-profit support):
   *    - stopPrice / takeProfitPrice: absolute prices (legacy interface)
   *    - stopPct / takeProfitPct:     percentages computed against the actual
   *                                    fill price. Use these when entry fills
   *                                    may differ from the strategy's reference
   *                                    price (e.g. day-trade strategies that
   *                                    open on next bar's open after a gap).
   *                                    These OVERRIDE the absolute prices.
   *    - forceCloseEod:               close at today's close regardless of P&L
   */
  open({ symbol, fillPrice, day, stopPrice, takeProfitPrice, stopPct, takeProfitPct, forceCloseEod }) {
    if (this.positions.has(symbol)) return null;       // already holding
    if (this.positionCount() >= this.maxPositions) return null;
    const qty = Math.floor(this.positionSizeUsd / fillPrice);
    if (qty < 1) return null;
    const cost = qty * fillPrice;
    if (cost > this.cash) return null;
    this.cash -= cost;
    // Percentage-based TP/SL (computed against actual fill price)
    const effStopPrice  = stopPct != null
      ? fillPrice * (1 - Math.abs(stopPct))
      : (stopPrice ?? null);
    const effTpPrice    = takeProfitPct != null
      ? fillPrice * (1 + Math.abs(takeProfitPct))
      : (takeProfitPrice ?? null);
    const pos = {
      symbol, qty, entryPrice: fillPrice, openedAt: day,
      stopPrice:       effStopPrice,
      takeProfitPrice: effTpPrice,
      forceCloseEod:   !!forceCloseEod,
      peakPnl: 0,
    };
    this.positions.set(symbol, pos);
    return pos;
  }

  /** Close a position at fillPrice. Returns the closed-trade record. */
  close({ symbol, fillPrice, day, reason }) {
    const pos = this.positions.get(symbol);
    if (!pos) return null;
    this.cash += pos.qty * fillPrice;
    this.positions.delete(symbol);
    const pnlUsd = (fillPrice - pos.entryPrice) * pos.qty;
    const pnlPct = (fillPrice - pos.entryPrice) / pos.entryPrice;
    const rec = {
      symbol: pos.symbol,
      qty:    pos.qty,
      entry_price: pos.entryPrice,
      exit_price:  fillPrice,
      opened_at:   pos.openedAt,
      closed_at:   day,
      pnl_usd:     +pnlUsd.toFixed(2),
      pnl_pct:     +pnlPct.toFixed(4),
      hold_days:   (new Date(day) - new Date(pos.openedAt)) / 86_400_000,
      exit_reason: reason ?? 'strategy',
    };
    this.closedTrades.push(rec);
    return rec;
  }

  /** Mark-to-market: compute total equity given current prices.
   *  If priceFor returns null/0/NaN for a held position (data gap, late
   *  ingestion, etc.), fall back to the position's entry price — never
   *  treat a held position as zero. */
  totalEquity(priceFor) {
    let openValue = 0;
    for (const pos of this.positions.values()) {
      const px = priceFor(pos.symbol);
      const usable = Number.isFinite(px) && px > 0 ? px : pos.entryPrice;
      openValue += pos.qty * usable;
    }
    return this.cash + openValue;
  }

  /** Append today's equity to the curve. */
  recordEquity(priceFor) {
    this.equityCurve.push(this.totalEquity(priceFor));
  }
}

// ─── Market Data Adapter (postgres backed) ───────────────────────────────────
/**
 * Provides day-by-day market state to strategies + the engine.
 * Loads daily OHLCV from backtest_prices (consolidated, free, reliable).
 * Use databento_ohlcv_1m for fine-grained intraday simulation when needed.
 */
export class MarketData {
  constructor(pool) {
    this.pool = pool;
    this._priceCache = new Map();  // symbol → {date → bar}
  }

  async preload(symbols, startDate, endDate) {
    const { rows } = await this.pool.query(
      `SELECT symbol, price_date, open, high, low, close, volume, adj_close
       FROM backtest_prices
       WHERE symbol = ANY($1::text[])
         AND price_date BETWEEN $2 AND $3
       ORDER BY symbol, price_date`,
      [symbols, startDate, endDate]
    );
    for (const r of rows) {
      const dateStr = r.price_date instanceof Date
        ? r.price_date.toISOString().split('T')[0]
        : String(r.price_date);
      if (!this._priceCache.has(r.symbol)) this._priceCache.set(r.symbol, new Map());
      this._priceCache.get(r.symbol).set(dateStr, {
        date:   dateStr,
        open:   Number(r.open),
        high:   Number(r.high),
        low:    Number(r.low),
        close:  Number(r.adj_close ?? r.close),
        volume: Number(r.volume) || 0,
      });
    }
  }

  /** Returns bar for symbol on date, or null. */
  getBar(symbol, dateStr) {
    return this._priceCache.get(symbol)?.get(dateStr) ?? null;
  }

  /** Returns NEXT trading day's bar (used for execution simulation). */
  getNextBar(symbol, dateStr) {
    const sym = this._priceCache.get(symbol);
    if (!sym) return null;
    const dates = [...sym.keys()].sort();
    const idx = dates.findIndex(d => d > dateStr);
    return idx === -1 ? null : sym.get(dates[idx]);
  }

  /**
   * Last known close on or before dateStr. Used for mark-to-market when a
   * held position has no bar on a given day (e.g. Yahoo data gap, ingestion
   * lag at window edge). Zeroing the position would be wrong — it'd show a
   * phantom 100% loss that reverses next day, blowing up max drawdown.
   */
  lastCloseAt(symbol, dateStr) {
    const sym = this._priceCache.get(symbol);
    if (!sym) return null;
    // Exact match first (the common case)
    const exact = sym.get(dateStr);
    if (exact) return exact.close;
    // Otherwise walk back to find most recent date ≤ dateStr
    const dates = [...sym.keys()].sort();
    let last = null;
    for (const d of dates) {
      if (d > dateStr) break;
      last = sym.get(d).close;
    }
    return last;
  }

  /** All trading dates available for a symbol within the loaded window. */
  tradingDates(symbol) {
    const sym = this._priceCache.get(symbol);
    if (!sym) return [];
    return [...sym.keys()].sort();
  }

  /** Trading dates across the union of all loaded symbols. */
  allTradingDates() {
    const set = new Set();
    for (const sym of this._priceCache.values()) {
      for (const d of sym.keys()) set.add(d);
    }
    return [...set].sort();
  }

  /** SMA of `window` days ending on `dateStr` (inclusive). */
  sma(symbol, dateStr, window) {
    const sym = this._priceCache.get(symbol);
    if (!sym) return null;
    const dates = [...sym.keys()].sort();
    const idx = dates.indexOf(dateStr);
    if (idx === -1 || idx + 1 < window) return null;
    const slice = dates.slice(idx + 1 - window, idx + 1);
    const sum = slice.reduce((a, d) => a + sym.get(d).close, 0);
    return sum / window;
  }

  /** % off 52-week (252-trading-day) high as of dateStr. */
  pctOff52w(symbol, dateStr) {
    const sym = this._priceCache.get(symbol);
    if (!sym) return null;
    const dates = [...sym.keys()].sort();
    const idx = dates.indexOf(dateStr);
    if (idx === -1) return null;
    const start = Math.max(0, idx - 251);
    const window = dates.slice(start, idx + 1);
    const hi = Math.max(...window.map(d => sym.get(d).high));
    const px = sym.get(dateStr).close;
    return (px - hi) / hi;   // negative when below high
  }

  /** Returns the bar from N trading days before dateStr (1 = previous trading day). */
  getBarNDaysBefore(symbol, dateStr, n = 1) {
    const sym = this._priceCache.get(symbol);
    if (!sym) return null;
    const dates = [...sym.keys()].sort();
    const idx = dates.indexOf(dateStr);
    if (idx === -1 || idx < n) return null;
    return sym.get(dates[idx - n]);
  }

  /** Last N-day percentage return as of dateStr (close-to-close). */
  lastNdReturn(symbol, dateStr, n = 5) {
    const sym = this._priceCache.get(symbol);
    if (!sym) return null;
    const dates = [...sym.keys()].sort();
    const idx = dates.indexOf(dateStr);
    if (idx === -1 || idx < n) return null;
    const today = sym.get(dateStr).close;
    const past  = sym.get(dates[idx - n]).close;
    if (!past) return null;
    return (today - past) / past;
  }

  /**
   * Wilder RSI-14 as of dateStr. Uses Wilder's smoothing (EMA-equivalent
   * with alpha=1/period). Matches the B-3.7 production implementation.
   */
  rsi(symbol, dateStr, period = 14) {
    const sym = this._priceCache.get(symbol);
    if (!sym) return null;
    const dates = [...sym.keys()].sort();
    const idx = dates.indexOf(dateStr);
    if (idx === -1 || idx < period) return null;
    const closes = dates.slice(0, idx + 1).map(d => sym.get(d).close);
    let avgGain = 0, avgLoss = 0;
    // Seed with simple average over first `period` deltas
    for (let i = 1; i <= period; i++) {
      const delta = closes[i] - closes[i - 1];
      if (delta > 0) avgGain += delta;
      else           avgLoss -= delta;
    }
    avgGain /= period;
    avgLoss /= period;
    // Wilder smoothing for the rest
    for (let i = period + 1; i < closes.length; i++) {
      const delta = closes[i] - closes[i - 1];
      const gain  = delta > 0 ?  delta : 0;
      const loss  = delta < 0 ? -delta : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /** % distance of close from 50-day SMA as of dateStr. Negative = below MA. */
  ma50Distance(symbol, dateStr) {
    const ma = this.sma(symbol, dateStr, 50);
    if (ma == null) return null;
    const bar = this.getBar(symbol, dateStr);
    if (!bar) return null;
    return (bar.close - ma) / ma;
  }
}

// ─── Engine ──────────────────────────────────────────────────────────────────
/**
 * Run a backtest.
 * @param {object} opts
 * @param {string} opts.startDate
 * @param {string} opts.endDate
 * @param {string[]} opts.universe
 * @param {function} opts.strategy  async (day, market, portfolio) → [orders]
 * @param {number} [opts.initialCapital=100000]
 * @param {number} [opts.maxPositions=10]
 * @param {number} [opts.positionSizeUsd=10000]
 * @param {number} [opts.slippageBps=5]
 * @param {boolean} [opts.verbose=false]
 * @returns {Promise<object>}  results object
 */
export async function runBacktest(opts) {
  const {
    startDate, endDate, universe, strategy,
    initialCapital = 100_000,
    maxPositions   = 10,
    positionSizeUsd = 10_000,
    slippageBps    = 5,
    verbose        = false,
  } = opts;

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const market = new MarketData(pool);

  if (verbose) console.log(`[replay] preloading prices for ${universe.length} symbols, ${startDate} → ${endDate}…`);
  await market.preload(universe, startDate, endDate);
  if (verbose) console.log(`[replay]   ${market.allTradingDates().length} trading days loaded.`);

  const portfolio = new Portfolio({ initialCapital, maxPositions, positionSizeUsd });
  const days = market.allTradingDates();

  const slipMult = slippageBps / 10_000;

  for (const day of days) {
    // Strategy emits orders to execute next bar
    const orders = await strategy({ day, market, portfolio, universe });

    for (const order of (orders ?? [])) {
      if (order.action === 'enter_long') {
        const nextBar = market.getNextBar(order.symbol, day);
        if (!nextBar) continue;
        const fillPrice = nextBar.open * (1 + slipMult);
        portfolio.open({
          symbol: order.symbol, fillPrice, day: nextBar.date,
          stopPrice:       order.stopPrice,
          takeProfitPrice: order.takeProfitPrice,
          stopPct:         order.stopPct,
          takeProfitPct:   order.takeProfitPct,
          forceCloseEod:   order.forceCloseEod,
        });
      } else if (order.action === 'exit_long') {
        const nextBar = market.getNextBar(order.symbol, day);
        if (!nextBar) continue;
        const fillPrice = nextBar.open * (1 - slipMult);
        portfolio.close({ symbol: order.symbol, fillPrice, day: nextBar.date, reason: order.reason ?? 'strategy' });
      }
    }

    // ── Intraday exit checks for all open positions ────────────────────────
    // CRITICAL: orders processed above CREATE positions with openedAt =
    // nextBar.date (the NEXT trading day). Those positions don't yet exist
    // on `day` — their bar is the one we're checking on the next iteration.
    // Skip them here to avoid checking yesterday's bar against tomorrow's
    // position (the bug that produced negative hold_days in v1).
    //
    // Order: take-profit FIRST (winners exit first), then stop-loss, then EOD.
    // When both TP and SL would have fired (gap-day), this is a tie-break;
    // assuming TP first is OPTIMISTIC.
    for (const pos of [...portfolio.positions.values()]) {
      if (pos.openedAt > day) continue;          // position opens NEXT iteration; skip
      const bar = market.getBar(pos.symbol, day);
      if (!bar) continue;

      // 1. Take profit (intraday)
      if (pos.takeProfitPrice != null && bar.high >= pos.takeProfitPrice) {
        const fillPrice = pos.takeProfitPrice * (1 - slipMult);
        portfolio.close({ symbol: pos.symbol, fillPrice, day, reason: 'take_profit' });
        continue;
      }

      // 2. Stop loss (intraday)
      if (pos.stopPrice != null && bar.low <= pos.stopPrice) {
        const fillPrice = pos.stopPrice * (1 - slipMult);
        portfolio.close({ symbol: pos.symbol, fillPrice, day, reason: 'stop_loss' });
        continue;
      }

      // 3. End-of-day force close (day-trade mode) — exits at today's close
      //    if position was opened today (i.e., this morning). Multi-day
      //    positions ignore this flag.
      if (pos.forceCloseEod && pos.openedAt === day) {
        const fillPrice = bar.close * (1 - slipMult);
        portfolio.close({ symbol: pos.symbol, fillPrice, day, reason: 'eod_force_close' });
      }
    }

    // Mark-to-market at close. If the bar is missing for this day (Yahoo
    // ingestion lag, holiday-mismatch, etc.) we carry forward the last
    // known close — see MarketData.lastCloseAt. Zeroing a held position
    // would produce phantom drawdowns at data gaps.
    portfolio.recordEquity(sym => market.lastCloseAt(sym, day));
  }

  // Close any remaining positions at last close
  const lastDay = days[days.length - 1];
  for (const pos of [...portfolio.positions.values()]) {
    const bar = market.getBar(pos.symbol, lastDay);
    if (bar) {
      portfolio.close({ symbol: pos.symbol, fillPrice: bar.close, day: lastDay, reason: 'eob_close' });
    }
  }

  await pool.end();

  return {
    startDate,
    endDate,
    initialCapital,
    finalValue: portfolio.equityCurve[portfolio.equityCurve.length - 1] ?? initialCapital,
    equityCurve: portfolio.equityCurve,
    trades: portfolio.closedTrades,
    config: {
      universe_size: universe.length,
      max_positions: maxPositions,
      position_size_usd: positionSizeUsd,
      slippage_bps: slippageBps,
    },
  };
}
