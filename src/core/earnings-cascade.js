/**
 * Earnings cascade alert.
 * Finds graph-tracked stocks reporting earnings in the next 1-3 days,
 * then surfaces connected companies likely to move in sympathy.
 */

import YahooFinance from 'yahoo-finance2';
import { getSympathyTrades, isGraphConfigured } from './graph.js';

const yf = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

const GRAPH_TICKERS = [
  'ASML','AMAT','LRCX','KLAC','TSM','INTC','NVDA','AMD','QCOM',
  'AVGO','ARM','MU','MSFT','META','GOOGL','AMZN','AAPL',
  'XOM','CVX','HAL','SLB','VST','CEG','ETR',
];

// Fetch next earnings date for one ticker. Returns { ticker, date, daysUntil } or null.
async function fetchEarningsDate(ticker) {
  try {
    const cal = await yf.quoteSummary(ticker, { modules: ['calendarEvents'] });
    const rawDates = cal?.calendarEvents?.earnings?.earningsDate ?? [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const future = rawDates
      .map(d => (d instanceof Date ? d : new Date(d)))
      .filter(d => !isNaN(d.getTime()) && d >= today)
      .sort((a, b) => a - b);
    if (!future.length) return null;
    const date      = future[0];
    const daysUntil = Math.round((date - today) / 86400000);
    return { ticker, date, daysUntil };
  } catch {
    return null;
  }
}

// Fetch earnings dates for all tickers in small parallel batches to avoid rate limits.
async function fetchAllEarningsDates(daysAhead = 3) {
  const BATCH = 5;
  const results = [];
  for (let i = 0; i < GRAPH_TICKERS.length; i += BATCH) {
    const batch = GRAPH_TICKERS.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(fetchEarningsDate));
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value && r.value.daysUntil <= daysAhead) {
        results.push(r.value);
      }
    }
  }
  return results.sort((a, b) => a.daysUntil - b.daysUntil);
}

function dayLabel(daysUntil) {
  if (daysUntil === 0) return 'today';
  if (daysUntil === 1) return 'tomorrow';
  return `in ${daysUntil} days`;
}

function formatAlert(ticker, daysUntil, date, sympathy) {
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  let msg = `📅 ${ticker} reports earnings ${dayLabel(daysUntil)} (${dateStr})\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;

  if (sympathy.length > 0) {
    msg += `👥 Connected stocks to watch:\n`;
    for (const s of sympathy.slice(0, 6)) {
      const relLabel = (s.rel_type || 'connected').replace(/_/g, ' ').toLowerCase();
      msg += `  • ${s.ticker} — ${relLabel}\n`;
    }
    const watchlist = sympathy.slice(0, 5).map(s => s.ticker).join(', ');
    msg += `📋 Watch: ${watchlist}`;
  } else {
    msg += `No graph connections found for ${ticker}.`;
  }

  return msg.trim();
}

export async function runEarningsCascadeScan({ daysAhead = 3 } = {}) {
  if (!isGraphConfigured()) return { skipped: true, reason: 'Neo4j not configured' };

  const upcoming = await fetchAllEarningsDates(daysAhead);
  if (upcoming.length === 0) return { upcoming: [], alerts: [] };

  const alerts = [];
  for (const { ticker, date, daysUntil } of upcoming) {
    const sympathy = await getSympathyTrades(ticker);
    const message  = formatAlert(ticker, daysUntil, date, sympathy);
    alerts.push({ ticker, date: date.toISOString().split('T')[0], daysUntil, sympathy, message });
  }

  return { upcoming, alerts };
}
