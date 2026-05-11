/**
 * Pre-market impact scanner.
 * Runs 7:00–9:25 AM ET on trading days.
 * Detects stocks in the graph moving >3% in pre-market,
 * then calculates contagion impact on all connected companies.
 */

import { getContagionImpact, getSympathyTrades, isGraphConfigured } from './graph.js';

const ALPACA_DATA = 'https://data.alpaca.markets/v2';

function alpacaHeaders() {
  return {
    'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY    || '',
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY || '',
    'Accept': 'application/json',
  };
}

// All tickers we track in the graph
const GRAPH_TICKERS = [
  // Semiconductor Equipment
  'ASML','AMAT','LRCX','KLAC',
  // Chips / Semis
  'TSM','INTC','NVDA','AMD','QCOM','AVGO','ARM','MU','TXN','MRVL','ON','ADI','NXPI','SMCI',
  // Big Tech
  'MSFT','META','GOOGL','AMZN','AAPL','TSLA','NFLX','ORCL','CRM','ADBE','NOW','CSCO','IBM',
  // Cloud / Cybersecurity / AI
  'CRWD','PANW','ZS','NET','DDOG','SNOW','PLTR','AI','PATH',
  // Finance
  'JPM','BAC','GS','MS','WFC','V','MA','PYPL','SQ','COIN',
  // Healthcare / Pharma
  'LLY','JNJ','UNH','PFE','ABBV','MRK','AMGN','GILD','REGN',
  // Consumer / Retail
  'COST','WMT','HD','TGT','NKE','DIS','SBUX','MCD',
  // EV / Auto
  'RIVN','F','GM',
  // Energy
  'XOM','CVX','HAL','SLB','OXY','BP',
  // Utilities
  'VST','CEG','ETR',
  // Telecom / Media
  'T','VZ','SPOT','UBER','ABNB',
];

// Fetch pre-market snapshot for all tickers at once
async function fetchPremarketSnapshots() {
  const symbols = GRAPH_TICKERS.filter(t => t !== 'SAMSUNG').join(',');
  const url = `${ALPACA_DATA}/stocks/snapshots?symbols=${symbols}&feed=iex`;
  const res = await fetch(url, { headers: alpacaHeaders(), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Alpaca snapshots HTTP ${res.status}`);
  return res.json();
}

// Calculate % change: pre-market price vs previous close
function calcChange(snapshot) {
  const prevClose = snapshot?.prevDailyBar?.c;
  const current   = snapshot?.minuteBar?.c ?? snapshot?.latestTrade?.p;
  if (!prevClose || !current) return null;
  return +((current - prevClose) / prevClose * 100).toFixed(2);
}

// Format the alert message for the dashboard
function formatAlert(mover, impacts, sympathy) {
  const dir    = mover.change_pct > 0 ? '🟢' : '🔴';
  const sign   = mover.change_pct > 0 ? '+' : '';
  let msg = `${dir} ${mover.ticker} ${sign}${mover.change_pct}% pre-market\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;

  if (impacts.length > 0) {
    msg += `📡 Contagion Impact:\n`;
    for (const imp of impacts.slice(0, 5)) {
      const arrow = imp.impact_pct > 0 ? '↑' : '↓';
      const hops  = imp.hops === 1 ? 'direct' : `${imp.hops} hops`;
      msg += `  ${arrow} ${imp.ticker} ${imp.impact_pct > 0 ? '+' : ''}${imp.impact_pct}% — ${imp.relationship} (${hops})\n`;
    }
  }

  if (sympathy.length > 0) {
    const peers = sympathy.slice(0, 3).map(p => p.ticker).join(', ');
    msg += `👥 Sympathy watch: ${peers}\n`;
  }

  const watchlist = [...new Set([
    ...impacts.slice(0, 4).map(i => i.ticker),
    ...sympathy.slice(0, 2).map(s => s.ticker),
  ])].join(', ');
  if (watchlist) msg += `📋 Watch: ${watchlist}`;

  return msg.trim();
}

export async function runPremarketScan() {
  if (!isGraphConfigured()) return { skipped: true, reason: 'Neo4j not configured' };

  // Only run during pre-market window: 7:00–9:25 AM ET Mon–Fri
  const now = new Date();
  const etHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const etMin  = now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' });
  const day    = now.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });

  if (['Sat', 'Sun'].includes(day)) return { skipped: true, reason: 'Weekend' };
  if (etHour < 7 || etHour >= 9 || (etHour === 9 && parseInt(etMin) >= 25))
    return { skipped: true, reason: 'Outside pre-market window (7:00–9:25 AM ET)' };

  const snapshots  = await fetchPremarketSnapshots();
  const movers     = [];

  for (const ticker of GRAPH_TICKERS) {
    if (ticker === 'SAMSUNG') continue;
    const snap      = snapshots[ticker];
    const changePct = calcChange(snap);
    if (changePct === null) continue;
    if (Math.abs(changePct) >= 3) {
      movers.push({ ticker, change_pct: changePct, price: snap?.minuteBar?.c ?? snap?.latestTrade?.p });
    }
  }

  if (movers.length === 0) return { movers: [], alerts: [] };

  // Sort by absolute move size, biggest first
  movers.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));

  const alerts = [];
  for (const mover of movers.slice(0, 5)) {
    const [impacts, sympathy] = await Promise.all([
      getContagionImpact(mover.ticker, mover.change_pct),
      getSympathyTrades(mover.ticker),
    ]);
    const message = formatAlert(mover, impacts, sympathy);
    alerts.push({ mover, impacts, sympathy, message });
  }

  return { movers, alerts };
}
