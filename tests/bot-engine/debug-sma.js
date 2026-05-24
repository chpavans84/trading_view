// One-off debug: dump last 25 equity values + cash/position state at each
import { runBacktest } from './replay-engine.js';
import { smaCrossStrategy } from './strategies/sma-cross.js';

const DEFAULT_BASKET = [
  'SPY','QQQ','IWM','DIA','XLF','XLE','XLU','XLK','XLV','XLI','XLB','XLP','XLY','XLRE','XLC',
  'AAPL','MSFT','NVDA','GOOGL','GOOG','AMZN','META','AVGO','ORCL','NFLX',
  'BRK-B','JPM','V','MA','BAC','WFC','MS','GS','AXP','BLK',
  'LLY','UNH','JNJ','ABBV','MRK','TMO','ABT','PFE','AMGN','GILD',
  'BMY','DHR','MDT','CI','CVS','ELV','HCA','SYK',
  'WMT','PG','HD','COST','PEP','KO','MCD','PM','MDLZ',
  'TGT','SBUX','NKE','BKNG','TJX',
  'XOM','CVX','COP','EOG','PSX','OXY',
  'CAT','DE','BA','GE','HON','UNP','RTX','LMT','GD','EMR',
  'CRM','ADBE','AMD','INTC','QCOM','TXN','IBM','CSCO','NOW','AMAT',
  'LRCX','MU','INTU',
  'NEE','SO','DUK','AMT','PLD','EQIX',
  'T','VZ','DIS','CMCSA',
  'LIN','ACN','SPGI','PYPL','SCHW','ICE','CB','AON',
  'F','GM',
];

const result = await runBacktest({
  startDate: '2023-04-01', endDate: '2026-05-22',
  universe: DEFAULT_BASKET, strategy: smaCrossStrategy,
  initialCapital: 100_000, maxPositions: 10, positionSizeUsd: 10_000, slippageBps: 5,
});

const eq = result.equityCurve;
console.log(`Total days: ${eq.length}`);
console.log(`Final value (eq[last]): $${eq[eq.length-1].toFixed(2)}`);
console.log(`Trades closed: ${result.trades.length}`);

// Find first big drop
let prev = eq[0];
let maxDrop = 0;
let maxDropIdx = -1;
for (let i = 1; i < eq.length; i++) {
  const dropPct = (eq[i] - prev) / prev;
  if (dropPct < maxDrop) {
    maxDrop = dropPct;
    maxDropIdx = i;
  }
  prev = eq[i];
}
console.log(`Biggest single-day drop: ${(maxDrop*100).toFixed(2)}% at index ${maxDropIdx}`);

// Print last 25 values
console.log('\nLast 25 equity points:');
for (let i = Math.max(0, eq.length - 25); i < eq.length; i++) {
  console.log(`  ${String(i).padStart(4)}: $${eq[i].toFixed(2)}`);
}

// Print biggest drop neighborhood
if (maxDropIdx > 0) {
  console.log(`\n10 points around biggest drop (idx ${maxDropIdx}):`);
  for (let i = Math.max(0, maxDropIdx - 3); i < Math.min(eq.length, maxDropIdx + 7); i++) {
    console.log(`  ${String(i).padStart(4)}: $${eq[i].toFixed(2)}${i === maxDropIdx ? '  <-- drop' : ''}`);
  }
}
