/**
 * Stock Prediction Engine — 5 deterministic algorithms, zero LLM calls.
 * All math is pure JS: linear regression, ATR, RSI, EMA, MACD.
 */

import YahooFinance from 'yahoo-finance2';
import { query, isDbAvailable } from './db.js';

// ─── Result cache (15-min TTL per symbol) ────────────────────────────────────
const _cache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

// ─── OHLCV fetch ──────────────────────────────────────────────────────────────
async function fetchOHLCV(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Yahoo OHLCV ${r.status}`);
  const d = await r.json();
  const res = d?.chart?.result?.[0];
  if (!res) throw new Error('No OHLCV data');
  const q   = res.indicators?.quote?.[0] ?? {};
  const tss = res.timestamp ?? [];
  const bars = tss.map((ts, i) => ({
    date:   new Date(ts * 1000).toISOString().split('T')[0],
    open:   (q.open   ?? [])[i],
    high:   (q.high   ?? [])[i],
    low:    (q.low    ?? [])[i],
    close:  (q.close  ?? [])[i],
    volume: (q.volume ?? [])[i] ?? 0,
  })).filter(b => b.close != null && b.high != null && b.low != null);
  return bars;
}

// ─── Pure math helpers ────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) val = closes[i] * k + val * (1 - k);
  return val;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcATR(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const { high: h, low: l } = bars[i];
    const pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return null;
  let val = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) val = (val * (period - 1) + trs[i]) / period;
  return val;
}

function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;
  const kf = 2 / (fast + 1), ks = 2 / (slow + 1), kg = 2 / (signalPeriod + 1);

  let ef = closes.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
  let es = closes.slice(0, slow).reduce((a, b) => a + b, 0) / slow;
  for (let i = fast; i < slow; i++) ef = closes[i] * kf + ef * (1 - kf);

  const macdLine = [];
  for (let i = slow; i < closes.length; i++) {
    ef = closes[i] * kf + ef * (1 - kf);
    es = closes[i] * ks + es * (1 - ks);
    macdLine.push(ef - es);
  }
  if (macdLine.length < signalPeriod) return null;

  let sig = macdLine.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
  for (let i = signalPeriod; i < macdLine.length; i++) sig = macdLine[i] * kg + sig * (1 - kg);

  const last = macdLine.at(-1);
  const prev = macdLine.at(-2) ?? last;
  const hist = last - sig;
  const prevHist = prev - sig;
  return { macd: last, signal: sig, histogram: hist, bullish: last > sig && hist >= prevHist };
}

function calcLinearRegression(closes) {
  const n = closes.length;
  const meanX = (n - 1) / 2;
  const meanY = closes.reduce((a, b) => a + b, 0) / n;
  let ssXX = 0, ssXY = 0, ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX, dy = closes[i] - meanY;
    ssXX += dx * dx;
    ssXY += dx * dy;
    ssTot += dy * dy;
  }
  const slope = ssXY / ssXX;
  const intercept = meanY - slope * meanX;
  for (let i = 0; i < n; i++) ssRes += (closes[i] - (slope * i + intercept)) ** 2;
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const stdErr   = Math.sqrt(ssRes / Math.max(n - 2, 1));
  return { slope, intercept, rSquared, stdErr, n };
}

// ─── Algorithm 1: Linear Regression Trend ────────────────────────────────────
function algoTrend(bars) {
  const closes = bars.slice(-50).map(b => b.close);
  if (closes.length < 20) throw new Error('Not enough bars for regression');
  const price = closes.at(-1);
  const { slope, intercept, rSquared, stdErr, n } = calcLinearRegression(closes);
  const day5  = intercept + slope * (n + 4);
  const day10 = intercept + slope * (n + 9);
  const confidenceBandPct = +((1.5 * stdErr / price) * 100).toFixed(2);
  const direction = slope > 0.05 ? 'up' : slope < -0.05 ? 'down' : 'flat';
  return {
    direction,
    slope_per_day:      +slope.toFixed(4),
    r_squared:          +rSquared.toFixed(4),
    projected_day5:     +day5.toFixed(2),
    projected_day10:    +day10.toFixed(2),
    confidence_band_pct: confidenceBandPct,
    reliability: rSquared > 0.7 ? 'high' : rSquared > 0.4 ? 'medium' : 'low',
  };
}

// ─── Algorithm 2: ATR Expected Move ──────────────────────────────────────────
function algoExpectedMove(bars) {
  const price = bars.at(-1).close;
  const atr14 = calcATR(bars, 14);
  if (!atr14) throw new Error('Not enough bars for ATR');
  const atrPct = +((atr14 / price) * 100).toFixed(2);
  const fmt = v => +v.toFixed(2);
  return {
    atr14:   +atr14.toFixed(4),
    atr_pct: atrPct,
    day1:  { high: fmt(price + 1.0 * atr14), low: fmt(price - 1.0 * atr14) },
    day5:  { high: fmt(price + 2.2 * atr14), low: fmt(price - 2.2 * atr14) },
    day10: { high: fmt(price + 3.2 * atr14), low: fmt(price - 3.2 * atr14) },
  };
}

// ─── Algorithm 3: Momentum Score ─────────────────────────────────────────────
function algoMomentum(bars) {
  const closes  = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume ?? 0);
  const price   = closes.at(-1);
  let score = 0;

  // RSI
  const rsiVal = calcRSI(closes, 14);
  let rsiLabel = 'neutral';
  if (rsiVal != null) {
    if (rsiVal >= 50 && rsiVal <= 70)     { score += 2; rsiLabel = 'bullish'; }
    else if (rsiVal > 70)                 { score -= 1; rsiLabel = 'overbought'; }
    else if (rsiVal >= 30 && rsiVal < 50) { score -= 2; rsiLabel = 'bearish'; }
    else                                  { score += 1; rsiLabel = 'oversold'; }
  }

  // EMA alignment
  const ema9  = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  let emaAlignment = 'mixed', emaScore = 0;
  if (ema9 && ema20 && ema50) {
    if (price > ema9 && ema9 > ema20 && ema20 > ema50)      { emaScore = 3;  emaAlignment = 'fully bullish'; }
    else if (price < ema9 && ema9 < ema20 && ema20 < ema50) { emaScore = -3; emaAlignment = 'fully bearish'; }
    else {
      if (price > ema9)  emaScore += 1; else emaScore -= 1;
      if (ema9 > ema20)  emaScore += 1; else emaScore -= 1;
      if (ema20 > ema50) emaScore += 1; else emaScore -= 1;
      emaAlignment = emaScore > 0 ? 'slightly bullish' : emaScore < 0 ? 'slightly bearish' : 'neutral';
    }
  }
  score += emaScore;

  // MACD
  const macdResult = calcMACD(closes);
  let macdSignal = 'neutral';
  if (macdResult) {
    if (macdResult.bullish) { score += 2; macdSignal = 'bullish'; }
    else                    { score -= 2; macdSignal = 'bearish'; }
  }

  // Volume trend (5-day vs 20-day avg)
  const vol5  = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const vol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  let volumeTrend = 'distribution';
  if (vol5 > vol20) { score += 1; volumeTrend = 'accumulation'; }
  else              { score -= 1; }

  // Price vs 20-day SMA (VWAP proxy)
  const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  if (price > sma20) score += 1; else score -= 1;

  const normalized   = Math.round(((score + 10) / 20) * 100);
  const momentumScore = Math.max(0, Math.min(100, normalized));
  const label = momentumScore >= 70 ? 'Strong Bullish'
    : momentumScore >= 55 ? 'Bullish'
    : momentumScore >= 45 ? 'Neutral'
    : momentumScore >= 30 ? 'Bearish'
    : 'Strong Bearish';

  return {
    score:        momentumScore,
    label,
    rsi:          rsiVal != null ? +rsiVal.toFixed(1) : null,
    rsi_label:    rsiLabel,
    ema_alignment: emaAlignment,
    macd_signal:  macdSignal,
    volume_trend: volumeTrend,
  };
}

// ─── Algorithm 4: Personal Trade Pattern Analysis ────────────────────────────
async function algoPersonalEdge(symbol) {
  if (!isDbAvailable()) return { insufficient_data: true, reason: 'Database unavailable' };

  const { rows } = await query(
    `SELECT symbol, side, entry_price, exit_price, pnl_usd,
            opened_at, closed_at, conviction_score
     FROM trades
     WHERE symbol = $1 AND status = 'closed'
     ORDER BY opened_at DESC`,
    [symbol]
  );

  if (!rows || rows.length < 3) {
    return { insufficient_data: true, trades_count: rows?.length ?? 0,
             reason: 'Fewer than 3 closed trades for this symbol' };
  }

  const wins   = rows.filter(t => (t.pnl_usd ?? 0) > 0);
  const losses = rows.filter(t => (t.pnl_usd ?? 0) <= 0);
  const winRate     = wins.length / rows.length;
  const avgWin      = wins.length   ? wins.reduce((a, t) => a + (+t.pnl_usd), 0) / wins.length       : 0;
  const avgLoss     = losses.length ? losses.reduce((a, t) => a + (+t.pnl_usd), 0) / losses.length   : 0;
  const sumWins     = wins.reduce((a, t) => a + (+t.pnl_usd), 0);
  const sumLosses   = Math.abs(losses.reduce((a, t) => a + (+t.pnl_usd), 0));
  const profitFactor = sumLosses > 0 ? +(sumWins / sumLosses).toFixed(2) : (sumWins > 0 ? 99 : 0);

  // Best hour bucket
  const hourMap = {};
  for (const t of rows) {
    if (!t.opened_at) continue;
    const h = new Date(t.opened_at).getUTCHours(); // ET offset not critical for pattern
    const bkt = `${h}:00-${h + 1}:00`;
    if (!hourMap[bkt]) hourMap[bkt] = { wins: 0, total: 0 };
    hourMap[bkt].total++;
    if ((t.pnl_usd ?? 0) > 0) hourMap[bkt].wins++;
  }
  const bestTimeOfDay = Object.entries(hourMap)
    .filter(([, v]) => v.total >= 2)
    .sort(([, a], [, b]) => b.wins / b.total - a.wins / a.total)[0]?.[0] ?? 'insufficient data';

  // Best day of week
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayMap = {};
  for (const t of rows) {
    if (!t.opened_at) continue;
    const day = DAYS[new Date(t.opened_at).getDay()];
    if (!dayMap[day]) dayMap[day] = { wins: 0, total: 0 };
    dayMap[day].total++;
    if ((t.pnl_usd ?? 0) > 0) dayMap[day].wins++;
  }
  const bestDayOfWeek = Object.entries(dayMap)
    .sort(([, a], [, b]) => b.wins / b.total - a.wins / a.total)[0]?.[0] ?? 'insufficient data';

  // Avg hold time
  const holds = rows
    .filter(t => t.opened_at && t.closed_at)
    .map(t => (new Date(t.closed_at) - new Date(t.opened_at)) / 60000);
  const avgHoldMinutes = holds.length
    ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length)
    : null;

  // Last 3 trades
  const last3 = rows.slice(0, 3).map(t => ({
    date:   t.opened_at ? new Date(t.opened_at).toISOString().split('T')[0] : null,
    side:   t.side,
    pnl:    t.pnl_usd != null ? +parseFloat(t.pnl_usd).toFixed(2) : null,
    result: (t.pnl_usd ?? 0) > 0 ? 'win' : 'loss',
  }));

  const personalEdgeScore = winRate > 0.6 && profitFactor > 1.5 ? 'Strong Edge'
    : winRate > 0.5 ? 'Slight Edge'
    : 'No Edge / Need More Data';

  return {
    trades_count:        rows.length,
    win_rate:            +winRate.toFixed(3),
    avg_win:             +avgWin.toFixed(2),
    avg_loss:            +avgLoss.toFixed(2),
    profit_factor:       profitFactor,
    avg_hold_minutes:    avgHoldMinutes,
    best_time_of_day:    bestTimeOfDay,
    best_day_of_week:    bestDayOfWeek,
    last_3_trades:       last3,
    personal_edge_score: personalEdgeScore,
  };
}

// ─── Algorithm 5: Earnings Catalyst Model ────────────────────────────────────
async function algoEarnings(symbol) {
  // Fundamentals from PostgreSQL
  let rows = [];
  if (isDbAvailable()) {
    try {
      const res = await query(
        `SELECT period_end, revenue, net_income, eps_diluted
         FROM fundamentals WHERE symbol = $1
         ORDER BY period_end DESC LIMIT 8`,
        [symbol]
      );
      rows = res.rows ?? [];
    } catch (_) {}
  }

  // Revenue growth trend (oldest→newest, QoQ deltas)
  let revenueGrowthTrend = 'insufficient data';
  if (rows.length >= 4) {
    const revs = rows.slice(0, 4).map(r => Number(r.revenue ?? 0)).reverse();
    const growths = [];
    for (let i = 1; i < revs.length; i++) {
      if (revs[i - 1] > 0) growths.push((revs[i] - revs[i - 1]) / revs[i - 1]);
    }
    if (growths.length >= 2) {
      const delta = growths.at(-1) - growths.at(-2);
      revenueGrowthTrend = delta > 0.01 ? 'accelerating' : delta < -0.01 ? 'decelerating' : 'flat';
    }
  }

  // Earnings momentum score (0-100)
  let earningsMomentumScore = 50;
  if (rows.length >= 4) {
    let raw = 0;
    if (revenueGrowthTrend === 'accelerating') raw += 2;

    const niVals  = rows.slice(0, 4).map(r => Number(r.net_income ?? 0)).reverse();
    const niPos   = niVals.every(v => v > 0);
    const niGrow  = niVals.length >= 2 && niVals.at(-1) > niVals.at(-2);
    if (niPos && niGrow) raw += 2;

    const epsVals = rows.slice(0, 4).map(r => Number(r.eps_diluted ?? 0)).reverse();
    const epsBeats = epsVals.filter((e, i) => i > 0 && e > epsVals[i - 1]).length;
    if (epsBeats >= 3) raw += 3;
    else if (epsBeats >= 2) raw += 1;

    earningsMomentumScore = Math.round((raw / 7) * 100);
  }

  // Next earnings date via yahoo-finance2 (handles crumb auth)
  let daysToNext = null, nextEarningsDate = null;
  try {
    const yf = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });
    const cal = await yf.quoteSummary(symbol, { modules: ['calendarEvents'] });
    const rawDates = cal?.calendarEvents?.earnings?.earningsDate ?? [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const future = rawDates
      .map(d => (d instanceof Date ? d : new Date(d)))
      .filter(d => !isNaN(d.getTime()) && d >= today)
      .sort((a, b) => a - b);
    if (future.length) {
      nextEarningsDate = future[0].toISOString().split('T')[0];
      daysToNext = Math.round((future[0] - today) / 86400000);
    }
  } catch (_) {}

  let preEarningsSetup = null;
  if (daysToNext != null) {
    if (daysToNext <= 3)
      preEarningsSetup = 'Earnings imminent — high risk, high reward';
    else if (daysToNext <= 14 && earningsMomentumScore >= 60)
      preEarningsSetup = 'Pre-earnings long candidate';
  }

  return {
    days_to_next:            daysToNext,
    next_earnings_date:      nextEarningsDate,
    eps_surprise_avg:        null, // estimates not stored in fundamentals table
    revenue_growth_trend:    revenueGrowthTrend,
    earnings_momentum_score: earningsMomentumScore,
    pre_earnings_setup:      preEarningsSetup,
  };
}

// ─── Combined prediction ──────────────────────────────────────────────────────
export async function getStockPrediction(symbol) {
  const ticker = symbol.toUpperCase();

  const hit = _cache.get(ticker);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.result;

  // Fetch OHLCV once — shared by algos 1, 2, 3
  let bars = null, ohlcvErr = null;
  try { bars = await fetchOHLCV(ticker); }
  catch (err) { ohlcvErr = err.message; }

  const currentPrice = bars?.at(-1)?.close ?? null;

  // Run all 5 algorithms in parallel
  const [trendR, moveR, momR, edgeR, earningsR] = await Promise.allSettled([
    bars ? Promise.resolve(algoTrend(bars))         : Promise.reject(new Error(ohlcvErr)),
    bars ? Promise.resolve(algoExpectedMove(bars))  : Promise.reject(new Error(ohlcvErr)),
    bars ? Promise.resolve(algoMomentum(bars))      : Promise.reject(new Error(ohlcvErr)),
    algoPersonalEdge(ticker),
    algoEarnings(ticker),
  ]);

  const trend    = trendR.status    === 'fulfilled' ? trendR.value    : { error: trendR.reason?.message };
  const move     = moveR.status     === 'fulfilled' ? moveR.value     : { error: moveR.reason?.message };
  const momentum = momR.status      === 'fulfilled' ? momR.value      : { error: momR.reason?.message };
  const edge     = edgeR.status     === 'fulfilled' ? edgeR.value     : { error: edgeR.reason?.message };
  const earnings = earningsR.status === 'fulfilled' ? earningsR.value : { error: earningsR.reason?.message };

  // ── Overall signal (0-100) ────────────────────────────────────────────────
  const mScore  = momentum?.score                     ?? 50;
  const eScore  = earnings?.earnings_momentum_score   ?? 50;
  const rSq     = trend?.r_squared                    ?? 0.3;
  const trendUp = trend?.direction === 'up';
  const pWinRate = edge?.insufficient_data ? 0.5 : (edge?.win_rate ?? 0.5);

  let overall = 50;
  overall += (mScore - 50)  * 0.3;
  overall += trendUp ? +15 : -15;
  overall += rSq * 10;
  overall += (eScore - 50) * 0.2;
  overall += pWinRate > 0.5 ? +10 : -5;
  const overallSignal = Math.round(Math.max(0, Math.min(100, overall)));

  const overallLabel = overallSignal >= 75 ? 'Strong Buy Setup'
    : overallSignal >= 60 ? 'Buy Setup'
    : overallSignal >= 45 ? 'Neutral / Wait'
    : overallSignal >= 30 ? 'Caution'
    : 'Avoid';

  // ── Human-readable summary ────────────────────────────────────────────────
  const parts = [];

  if (!trend.error) {
    parts.push(
      `Regression trend is ${trend.direction} (R²=${trend.r_squared}, ${trend.reliability} reliability), ` +
      `projecting $${trend.projected_day5} in 5 days and $${trend.projected_day10} in 10 days ` +
      `(±${trend.confidence_band_pct}% band).`
    );
  }

  if (!momentum.error) {
    parts.push(
      `Momentum is ${momentum.label} (${momentum.score}/100): ` +
      `RSI ${momentum.rsi ?? 'N/A'} (${momentum.rsi_label}), ` +
      `EMAs ${momentum.ema_alignment}, MACD ${momentum.macd_signal}, ` +
      `volume ${momentum.volume_trend}.`
    );
  }

  if (!move.error) {
    parts.push(
      `ATR14=$${move.atr14} (${move.atr_pct}% of price). ` +
      `5-day range: $${move.day5.low}–$${move.day5.high}.`
    );
  }

  if (!earnings.error) {
    if (earnings.next_earnings_date) {
      parts.push(
        `Next earnings ${earnings.next_earnings_date} (${earnings.days_to_next} days away)` +
        (earnings.pre_earnings_setup ? ` — ${earnings.pre_earnings_setup}` : '') + '.'
      );
    } else {
      parts.push('No upcoming earnings date found.');
    }
  }

  if (!edge.error) {
    if (edge.insufficient_data) {
      parts.push(`Personal ${ticker} history: insufficient data (${edge.trades_count ?? 0} closed trades).`);
    } else {
      parts.push(
        `Your personal ${ticker} win rate: ${Math.round((edge.win_rate ?? 0) * 100)}% ` +
        `over ${edge.trades_count} trades (profit factor ${edge.profit_factor}, ` +
        `edge: ${edge.personal_edge_score}).`
      );
    }
  }

  const result = {
    symbol:        ticker,
    generated_at:  new Date().toISOString(),
    current_price: currentPrice,
    trend,
    expected_move: move,
    momentum,
    personal_edge: edge,
    earnings,
    overall_signal: overallSignal,
    overall_label:  overallLabel,
    summary: parts.join(' '),
  };

  _cache.set(ticker, { result, ts: Date.now() });
  return result;
}
