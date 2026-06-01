/**
 * Historical impact analysis for graph-connected stocks.
 * For a given ticker, fetches 1-year daily price history for it and all
 * connected peers, then computes:
 *   - Pearson return correlation
 *   - Avg peer move on days the origin stock moved ≥ THRESHOLD %
 *   - Avg peer move on the day after origin's past earnings reports
 *   - A log of the 6 most recent real events
 */

import YahooFinance from 'yahoo-finance2';
import { getSympathyTrades } from './graph.js';
import { query, isDbAvailable } from './db.js';

const yf = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

const THRESHOLD = 3; // % move considered "significant"

// ── Math helpers ─────────────────────────────────────────────────────────────

function dailyReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) r.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return r;
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 15) return null;
  const a = xs.slice(0, n), b = ys.slice(0, n);
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, y) => s + y, 0) / n;
  const num = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0);
  const den = Math.sqrt(
    a.reduce((s, x) => s + (x - ma) ** 2, 0) *
    b.reduce((s, y) => s + (y - mb) ** 2, 0)
  );
  return den === 0 ? 0 : +(num / den).toFixed(3);
}

function avg(arr) {
  if (!arr.length) return null;
  return +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(2);
}

function corrLabel(c) {
  if (c === null) return 'n/a';
  const a = Math.abs(c);
  return a >= 0.7 ? 'strong' : a >= 0.4 ? 'moderate' : 'weak';
}

// ── Data fetching ─────────────────────────────────────────────────────────────

// Prefer our local PostgreSQL `backtest_prices` table — 3 years of daily OHLCV
// already loaded for S&P 500 + Nasdaq 100. Yahoo's `chart()` rate-limits us
// after a few hundred requests per process, and impact analysis fans out 6+
// peers per lookup, so a single user clicking around the Earnings tab burns
// our quota. The DB is local + reliable; fall back to Yahoo only when the
// ticker isn't in our universe.
async function fetchHistory(ticker, days) {
  // DB path (fast + reliable)
  if (isDbAvailable()) {
    try {
      const { rows } = await query(
        `SELECT TO_CHAR(price_date, 'YYYY-MM-DD') AS date, close
         FROM backtest_prices
         WHERE symbol = $1 AND price_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
         ORDER BY price_date ASC`,
        [ticker, days + 30]
      );
      if (rows.length >= 20) {
        return rows
          .map(r => ({ date: r.date, close: Number(r.close) }))
          .filter(d => d.close > 0);
      }
    } catch { /* fall through to Yahoo */ }
  }

  // Yahoo fallback for tickers not in backtest_prices (foreign ADRs, micro-caps).
  const period1 = new Date(Date.now() - (days + 30) * 86_400_000);
  try {
    const result = await yf.chart(ticker, { period1, interval: '1d' });
    return (result.quotes || [])
      .map(d => ({ date: d.date.toISOString().split('T')[0], close: d.adjclose ?? d.close }))
      .filter(d => d.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

async function fetchPastEarnings(ticker) {
  try {
    const r = await yf.quoteSummary(ticker, { modules: ['earningsHistory'] });
    return (r?.earningsHistory?.history ?? [])
      .map(e => ({
        date: e.quarter instanceof Date ? e.quarter.toISOString().split('T')[0] : null,
        surprisePct: e.surprisePercent ?? null,
      }))
      .filter(e => e.date)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

function buildMap(history) {
  const m = {};
  for (const d of history) m[d.date] = d.close;
  return m;
}

// Given a reference date, find the price on or after that date in the map
function priceOnOrAfter(refDate, sortedDates, map, offset = 0) {
  const idx = sortedDates.findIndex(d => d >= refDate);
  if (idx === -1) return null;
  const d = sortedDates[idx + offset];
  return d ? { date: d, price: map[d] } : null;
}

function pct(from, to) {
  if (!from || !to || from === 0) return null;
  return +((to - from) / from * 100).toFixed(2);
}

// ── Core analysis ─────────────────────────────────────────────────────────────

export async function getImpactAnalysis(ticker, days = 365) {
  const peers = await getSympathyTrades(ticker);
  if (!peers.length) return { ticker, days, peers: [], noGraph: true };

  // Fetch history for origin + all peers in parallel batches
  const allTickers = [ticker, ...peers.map(p => p.ticker)];
  const BATCH = 6;
  const histByTicker = {};
  for (let i = 0; i < allTickers.length; i += BATCH) {
    const batch = allTickers.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(t => fetchHistory(t, days)));
    for (let j = 0; j < batch.length; j++) {
      histByTicker[batch[j]] = results[j].status === 'fulfilled' ? results[j].value : [];
    }
  }

  // Fetch past earnings for origin
  const pastEarnings = await fetchPastEarnings(ticker);

  const originHist  = histByTicker[ticker] ?? [];
  const originMap   = buildMap(originHist);
  const originDates = Object.keys(originMap).sort();

  // Find big-move days for origin
  const bigMoves = [];
  for (let i = 1; i < originHist.length; i++) {
    const p = pct(originHist[i - 1].close, originHist[i].close);
    if (p !== null && Math.abs(p) >= THRESHOLD) {
      bigMoves.push({ date: originHist[i].date, pct: p });
    }
  }

  // Per-peer analysis
  const peerResults = [];
  for (const peer of peers) {
    const ph = histByTicker[peer.ticker] ?? [];
    if (ph.length < 20) {
      peerResults.push({ ticker: peer.ticker, name: peer.ticker, rel_type: peer.rel_type,
        strength: peer.strength, error: 'insufficient_data' });
      continue;
    }

    const pm = buildMap(ph);
    const pd = Object.keys(pm).sort();

    // Align closes by common dates for correlation
    const common = originDates.filter(d => pm[d]);
    const oc = [], pc2 = [];
    for (const d of common) {
      const oi = originHist.findIndex(h => h.date === d);
      const pi = ph.findIndex(h => h.date === d);
      if (oi > 0 && pi > 0) { oc.push(originHist[oi].close); pc2.push(ph[pi].close); }
    }
    const corr = pearson(dailyReturns(oc), dailyReturns(pc2));

    // Big-move impact: what did peer do on the same day and next day?
    const bmSameDay = [], bmNextDay = [];
    const bmEvents = [];
    for (const { date, pct: originPct } of bigMoves) {
      const s = priceOnOrAfter(date, pd, pm, 0);
      const n = priceOnOrAfter(date, pd, pm, 1);
      if (!s) continue;
      const prevIdx = pd.indexOf(s.date) - 1;
      const prevPrice = prevIdx >= 0 ? pm[pd[prevIdx]] : null;
      const sameDayPct = pct(prevPrice, s.price);
      const nextDayPct = n ? pct(s.price, n.price) : null;
      if (sameDayPct !== null) {
        bmSameDay.push(sameDayPct);
        if (nextDayPct !== null) bmNextDay.push(nextDayPct);
        bmEvents.push({ date, type: 'big_move', originPct, peerSameDay: sameDayPct, peerNextDay: nextDayPct });
      }
    }

    // Earnings impact: what did peer do the day after origin's earnings?
    const earnNextDay = [], earn2Day = [];
    const earnEvents = [];
    for (const { date: eDate, surprisePct } of pastEarnings) {
      const s  = priceOnOrAfter(eDate, pd, pm, 0);
      const n1 = priceOnOrAfter(eDate, pd, pm, 1);
      const n2 = priceOnOrAfter(eDate, pd, pm, 2);
      if (!s || !n1) continue;
      const d1 = pct(s.price, n1.price);
      const d2 = n2 ? pct(s.price, n2.price) : null;
      // Also get origin move on earnings day
      const os  = priceOnOrAfter(eDate, originDates, originMap, 0);
      const os1 = priceOnOrAfter(eDate, originDates, originMap, 1);
      const originEarnPct = os && os1 ? pct(os.price, os1.price) : null;
      if (d1 !== null) {
        earnNextDay.push(d1);
        if (d2 !== null) earn2Day.push(d2);
        earnEvents.push({ date: eDate, type: 'earnings', surprisePct, originPct: originEarnPct,
          peerDay1: d1, peerDay2: d2 });
      }
    }

    // Most recent 6 events mixed
    const allEvents = [...bmEvents, ...earnEvents]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 6);

    peerResults.push({
      ticker:   peer.ticker,
      name:     peer.name ?? peer.ticker,
      rel_type: peer.rel_type,
      strength: peer.strength,
      correlation: corr,
      corrLabel:   corrLabel(corr),
      bigMove: {
        count:       bmSameDay.length,
        avgSameDay:  avg(bmSameDay),
        avgNextDay:  avg(bmNextDay),
      },
      earnings: {
        count:    earnNextDay.length,
        avgDay1:  avg(earnNextDay),
        avgDay2:  avg(earn2Day),
      },
      events: allEvents,
    });
  }

  peerResults.sort((a, b) => Math.abs(b.correlation ?? 0) - Math.abs(a.correlation ?? 0));

  return {
    ticker,
    days,
    bigMoveDays:    bigMoves.length,
    pastEarnings:   pastEarnings.length,
    peers:          peerResults,
  };
}
