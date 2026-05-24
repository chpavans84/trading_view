/**
 * tests/bot-engine/would-bot-pick.js
 *
 * Quick diagnostic: would the (price-based subset of) bot pick this symbol
 * RIGHT NOW based on the most recent close in backtest_prices?
 *
 * Usage:
 *   node --env-file=.env tests/bot-engine/would-bot-pick.js NVDA
 *   node --env-file=.env tests/bot-engine/would-bot-pick.js AAPL,MSFT,NVDA
 *
 * Reports per-setup verdict for the price-checkable rules:
 *   - momentum  (price-based subset)
 *   - mean_reversion (price-based subset)
 *   - breakout (partial — checks 52w high + price proximity, can't check volume confirmation)
 *
 * NOT checked (require UW/news/insider/fundamentals history not loaded):
 *   - catalyst
 *   - value_contrarian
 *   - UW flow gate on momentum
 *   - news sentiment gate
 *   - earnings proximity
 */

import { MarketData } from './replay-engine.js';
import pg from 'pg';

const { Pool } = pg;

const symbols = (process.argv[2] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
if (!symbols.length) {
  console.error('Usage: node tests/bot-engine/would-bot-pick.js SYMBOL[,SYMBOL,...]');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const market = new MarketData(pool);

// Load ~14 months of history so 52w + 200d SMA + RSI work
const today    = new Date();
const fromDate = new Date(today.getTime() - 425 * 86_400_000).toISOString().slice(0, 10);
const toDate   = today.toISOString().slice(0, 10);

await market.preload(symbols, fromDate, toDate);

function YN(v) { return v ? '✅ YES' : '❌ NO'; }
function fmtPct(v) { return v == null ? '   n/a' : ((v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%'); }
function fmtNum(v) { return v == null ? 'n/a' : v.toFixed(2); }
function fmtUsd(v) { return v == null ? 'n/a' : '$' + v.toFixed(2); }

console.log();
console.log('═'.repeat(80));
console.log(`  Bot pickability check  (price-based gates only)`);
console.log('═'.repeat(80));

for (const sym of symbols) {
  const dates = market.tradingDates(sym);
  if (!dates.length) {
    console.log(`\n▸ ${sym}  — no price history in backtest_prices`);
    continue;
  }
  const lastDate = dates[dates.length - 1];
  const bar      = market.getBar(sym, lastDate);
  const pctOff52w = market.pctOff52w(sym, lastDate);
  const r5         = market.lastNdReturn(sym, lastDate, 5);
  const r20        = market.lastNdReturn(sym, lastDate, 20);
  const rsi14      = market.rsi(sym, lastDate, 14);
  const ma50d      = market.ma50Distance(sym, lastDate);
  const sma50      = market.sma(sym, lastDate, 50);
  const sma200     = market.sma(sym, lastDate, 200);

  console.log(`\n▸ ${sym}  ·  data through ${lastDate}  ·  close ${fmtUsd(bar?.close)}`);
  console.log('─'.repeat(80));
  console.log(`  pctOff52w (close vs 52w high)  ${fmtPct(pctOff52w)}`);
  console.log(`  Last 5-day return              ${fmtPct(r5)}`);
  console.log(`  Last 20-day return             ${fmtPct(r20)}`);
  console.log(`  RSI-14                         ${fmtNum(rsi14)}`);
  console.log(`  MA50 distance                  ${fmtPct(ma50d)}`);
  console.log(`  SMA50 / SMA200                 ${fmtUsd(sma50)} / ${fmtUsd(sma200)}  →  ${sma50 > sma200 ? 'BULL trend' : 'BEAR trend'}`);

  console.log();
  console.log(`  Setup checks (price-only subset):`);

  // ─── MOMENTUM ──────────────────────────────────────────────────
  const momPctOk = pctOff52w != null && pctOff52w >= -0.10;
  const mom5dOk  = r5 != null && r5 >= 0.02;
  const momFires = momPctOk && mom5dOk;
  console.log(`    momentum:        ${YN(momFires)}`);
  console.log(`      • pctOff52w ≥ -10%        ${YN(momPctOk)}  (actual ${fmtPct(pctOff52w)})`);
  console.log(`      • last5dReturn ≥ +2%      ${YN(mom5dOk)}  (actual ${fmtPct(r5)})`);
  console.log(`      • UW score ≥ 40 / news ≠ neg                    (not checked — live data only)`);

  // ─── MEAN REVERSION ────────────────────────────────────────────
  const mrDeepOk = pctOff52w != null && pctOff52w <= -0.15;
  const mrRsiOk  = rsi14 != null && rsi14 <= 30;
  const mrMaOk   = ma50d != null && ma50d <= -0.05;
  const mrFires  = mrDeepOk && mrRsiOk && mrMaOk;
  console.log(`    mean_reversion:  ${YN(mrFires)}`);
  console.log(`      • pctOff52w ≤ -15%        ${YN(mrDeepOk)}  (actual ${fmtPct(pctOff52w)})`);
  console.log(`      • RSI-14 ≤ 30             ${YN(mrRsiOk)}  (actual ${fmtNum(rsi14)})`);
  console.log(`      • MA50 distance ≤ -5%     ${YN(mrMaOk)}  (actual ${fmtPct(ma50d)})`);
  console.log(`      • UW not bearish, news not neg                   (not checked — live data only)`);

  // ─── BREAKOUT (partial) ────────────────────────────────────────
  const brAtHigh = pctOff52w != null && pctOff52w >= -0.03;
  console.log(`    breakout (partial): ${YN(brAtHigh)}`);
  console.log(`      • Within 3% of 52w high   ${YN(brAtHigh)}  (actual ${fmtPct(pctOff52w)})`);
  console.log(`      • New 52w high in last 5d                       (not checked — needs daily scan)`);
  console.log(`      • Volume on breakout ≥ 1.5× avg                 (not checked — needs volume)`);

  console.log();
  console.log(`  catalyst, value_contrarian: NOT checked — need UW + news + insider history`);
  console.log();

  // ─── DEPLOYED MOMENTUM CONFIG SUMMARY ──────────────────────────
  if (momFires) {
    const stop = bar?.close * (1 - 0.06);
    const trail = bar?.close;
    console.log(`  ─── If bot enters as MOMENTUM today (using deployed 6% SL) ───`);
    console.log(`      Entry price:   ~${fmtUsd(bar?.close)}  (next bar open)`);
    console.log(`      Hard stop:     ${fmtUsd(stop)}  (-6%)`);
    console.log(`      Trail:         30% from peak gain`);
    console.log(`      Time stop:     7 days`);
    console.log(`      Earnings exit: yes (within 3 days)`);
  }
}

console.log();
console.log('═'.repeat(80));
console.log('Reminder: production B-3.7 ALSO gates on UW flow, news sentiment,');
console.log('insider activity, fundamentals, and composite score ≥ threshold. The');
console.log('checks above are the PRICE-BASED subset only.');
console.log('═'.repeat(80));

await pool.end();
