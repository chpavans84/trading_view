/**
 * tests/bot-engine/analytics/metrics.js
 *
 * Pure math — Sharpe, max drawdown, CAGR, Calmar, win rate, etc.
 * No DB or IO. Called by the replay engine after a run completes.
 */

const TRADING_DAYS_PER_YEAR = 252;

/**
 * Annualized Sharpe ratio. rf = 0 by convention.
 * @param {number[]} dailyReturns  — pct returns per trading day (e.g. 0.01 = +1%)
 * @returns {number}
 */
export function sharpe(dailyReturns) {
  if (!dailyReturns?.length) return 0;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length;
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return 0;
  return (mean / stdev) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Max drawdown — biggest peak-to-trough decline in equity.
 * Returns negative value (e.g. -0.25 = 25% drawdown).
 * @param {number[]} equityCurve  — portfolio value at each step
 */
export function maxDrawdown(equityCurve) {
  if (!equityCurve?.length) return 0;
  let peak = equityCurve[0];
  let maxDD = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD;
}

/**
 * CAGR — annualized return.
 * @param {number} startValue
 * @param {number} endValue
 * @param {number} years
 */
export function cagr(startValue, endValue, years) {
  if (years <= 0 || startValue <= 0) return 0;
  return Math.pow(endValue / startValue, 1 / years) - 1;
}

/**
 * Calmar ratio: CAGR / |max drawdown|. Higher is better.
 */
export function calmar(cagrValue, mddValue) {
  if (mddValue === 0) return 0;
  return cagrValue / Math.abs(mddValue);
}

/**
 * Compute daily returns from an equity curve.
 */
export function dailyReturns(equityCurve) {
  const r = [];
  for (let i = 1; i < equityCurve.length; i++) {
    if (equityCurve[i - 1] === 0) { r.push(0); continue; }
    r.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
  }
  return r;
}

/**
 * Trade-level metrics. trades = [{pnl_usd, opened_at, closed_at, ...}, ...]
 */
export function tradeStats(trades) {
  if (!trades?.length) {
    return {
      total_trades: 0, winning_trades: 0, losing_trades: 0, win_rate: 0,
      avg_pnl: 0, avg_winner: 0, avg_loser: 0, profit_factor: 0,
      best_trade: 0, worst_trade: 0, avg_hold_days: 0,
    };
  }
  const closed = trades.filter(t => t.closed_at && Number.isFinite(t.pnl_usd));
  const wins   = closed.filter(t => t.pnl_usd > 0);
  const losses = closed.filter(t => t.pnl_usd <= 0);
  const sumWins   = wins.reduce((a, t) => a + t.pnl_usd, 0);
  const sumLosses = Math.abs(losses.reduce((a, t) => a + t.pnl_usd, 0));
  const holdDays  = closed.map(t => (new Date(t.closed_at) - new Date(t.opened_at)) / 86_400_000);

  return {
    total_trades:   closed.length,
    winning_trades: wins.length,
    losing_trades:  losses.length,
    win_rate:       closed.length ? wins.length / closed.length : 0,
    avg_pnl:        closed.length ? closed.reduce((a, t) => a + t.pnl_usd, 0) / closed.length : 0,
    avg_winner:     wins.length ? sumWins / wins.length : 0,
    avg_loser:      losses.length ? -sumLosses / losses.length : 0,
    profit_factor:  sumLosses ? sumWins / sumLosses : (sumWins ? Infinity : 0),
    best_trade:     closed.length ? Math.max(...closed.map(t => t.pnl_usd)) : 0,
    worst_trade:    closed.length ? Math.min(...closed.map(t => t.pnl_usd)) : 0,
    avg_hold_days:  holdDays.length ? holdDays.reduce((a, b) => a + b, 0) / holdDays.length : 0,
  };
}

/**
 * One-shot full summary. Called by reporter after a run.
 * @param {object} result  — { equityCurve, trades, initialCapital, finalValue, startDate, endDate }
 */
export function summarize(result) {
  const yrs = (new Date(result.endDate) - new Date(result.startDate)) / (365.25 * 86_400_000);
  const dr  = dailyReturns(result.equityCurve);
  const mdd = maxDrawdown(result.equityCurve);
  const cg  = cagr(result.initialCapital, result.finalValue, yrs);
  const sh  = sharpe(dr);
  const cm  = calmar(cg, mdd);
  const ts  = tradeStats(result.trades);

  return {
    period: {
      start: result.startDate,
      end:   result.endDate,
      years: +yrs.toFixed(2),
    },
    returns: {
      initial_capital_usd: result.initialCapital,
      final_value_usd:     result.finalValue,
      total_return_pct:    +((result.finalValue / result.initialCapital - 1) * 100).toFixed(2),
      cagr_pct:            +(cg * 100).toFixed(2),
    },
    risk: {
      sharpe:           +sh.toFixed(2),
      max_drawdown_pct: +(mdd * 100).toFixed(2),
      calmar:           +cm.toFixed(2),
    },
    trades: ts,
  };
}
