#!/usr/bin/env node
/**
 * src/research/backtest-congress.js
 *
 * Phase 4.1 Part B — Congressional Trade Pre-Rally Signal Backtest
 *
 * Hypothesis: Do congressional stock purchases predict forward price appreciation?
 * Signal date = filed_at (when the trade becomes publicly known via STOCK Act)
 * Returns: T+5 and T+10 trading days from filing date
 *
 * Run: node src/research/backtest-congress.js
 */

import pg from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function pct(n, d) { return d ? ((n / d) * 100).toFixed(2) + '%' : 'N/A'; }
function avg(arr)   { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function winRate(arr, threshold = 0) {
  const wins = arr.filter(x => x > threshold).length;
  return arr.length ? (wins / arr.length * 100).toFixed(1) + '%' : 'N/A';
}
function fmt(n) { return n == null ? 'N/A' : (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   Phase 4.1B — Congressional Trade Pre-Rally Backtest   ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Signal   : Stock Act filing date (public knowledge)     ║');
  console.log('║  Returns  : T+5 and T+10 trading days from filing        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // ── Data inventory ──────────────────────────────────────────────────────────
  const inv = await pool.query(`
    SELECT
      COUNT(*)                                               AS total,
      COUNT(*) FILTER (WHERE transaction_type = 'Buy')      AS buys,
      COUNT(*) FILTER (WHERE transaction_type = 'Sell')     AS sells,
      COUNT(*) FILTER (WHERE ticker IS NOT NULL)            AS with_ticker,
      COUNT(*) FILTER (WHERE filed_at IS NOT NULL)          AS with_filing,
      MIN(traded_at)::text                                  AS earliest_trade,
      MAX(traded_at)::text                                  AS latest_trade
    FROM uw_congressional_trades
  `);
  const i = inv.rows[0];
  console.log('Data inventory:');
  console.log(`  Total rows   : ${i.total}`);
  console.log(`  Buys (B)     : ${i.buys}`);
  console.log(`  Sells (S)    : ${i.sells}`);
  console.log(`  With ticker  : ${i.with_ticker}`);
  console.log(`  With filing  : ${i.with_filing}`);
  console.log(`  Trade dates  : ${i.earliest_trade} → ${i.latest_trade}`);

  // ── Main backtest query ─────────────────────────────────────────────────────
  // Signal date = filed_at (cast to date)
  // T+5: 5th trading day after filing
  // T+10: 10th trading day after filing
  const { rows } = await pool.query(`
    WITH events AS (
      SELECT
        c.ticker,
        c.member_name,
        c.chamber,
        c.transaction_type,
        c.amount_range,
        c.traded_at,
        c.filed_at::date                                         AS signal_date,
        (c.filed_at::date - c.traded_at)                        AS disclosure_days
      FROM uw_congressional_trades c
      WHERE c.transaction_type IN ('Buy','Sell')
        AND c.ticker IS NOT NULL
        AND c.filed_at IS NOT NULL
        AND c.traded_at IS NOT NULL
    ),
    events_with_entry AS (
      SELECT
        e.*,
        entry.close AS entry_price
      FROM events e
      LEFT JOIN LATERAL (
        SELECT close FROM backtest_prices
        WHERE symbol = e.ticker AND price_date >= e.signal_date
        ORDER BY price_date
        LIMIT 1
      ) entry ON TRUE
    )
    SELECT
      e.ticker,
      e.member_name,
      e.chamber,
      e.transaction_type,
      e.amount_range,
      e.traded_at,
      e.signal_date,
      e.disclosure_days,
      e.entry_price,
      p5.close  AS close_5d,
      p10.close AS close_10d,
      CASE WHEN e.entry_price > 0 AND p5.close  IS NOT NULL
           THEN ((p5.close  - e.entry_price) / e.entry_price * 100)
      END AS ret_5d_pct,
      CASE WHEN e.entry_price > 0 AND p10.close IS NOT NULL
           THEN ((p10.close - e.entry_price) / e.entry_price * 100)
      END AS ret_10d_pct
    FROM events_with_entry e
    LEFT JOIN LATERAL (
      SELECT close FROM backtest_prices
      WHERE symbol = e.ticker AND price_date > e.signal_date
      ORDER BY price_date LIMIT 1 OFFSET 4
    ) p5  ON TRUE
    LEFT JOIN LATERAL (
      SELECT close FROM backtest_prices
      WHERE symbol = e.ticker AND price_date > e.signal_date
      ORDER BY price_date LIMIT 1 OFFSET 9
    ) p10 ON TRUE
    WHERE e.entry_price IS NOT NULL
    ORDER BY e.signal_date DESC
  `);

  const all5  = rows.filter(r => r.ret_5d_pct  != null).map(r => parseFloat(r.ret_5d_pct));
  const all10 = rows.filter(r => r.ret_10d_pct != null).map(r => parseFloat(r.ret_10d_pct));
  console.log(`\nMatched events  : ${rows.length} total, ${all5.length} with T+5, ${all10.length} with T+10`);

  // ── SPY baseline ────────────────────────────────────────────────────────────
  const spyQ = await pool.query(`
    SELECT
      AVG(((p5.close - p0.close) / p0.close * 100))  AS spy_5d,
      AVG(((p10.close - p0.close) / p0.close * 100)) AS spy_10d
    FROM backtest_prices p0
    LEFT JOIN LATERAL (
      SELECT close FROM backtest_prices
      WHERE symbol='SPY' AND price_date > p0.price_date ORDER BY price_date LIMIT 1 OFFSET 4
    ) p5 ON TRUE
    LEFT JOIN LATERAL (
      SELECT close FROM backtest_prices
      WHERE symbol='SPY' AND price_date > p0.price_date ORDER BY price_date LIMIT 1 OFFSET 9
    ) p10 ON TRUE
    WHERE p0.symbol='SPY' AND p0.price_date BETWEEN '2025-12-01' AND '2026-05-20'
  `);
  const spy5  = parseFloat(spyQ.rows[0]?.spy_5d  || 0);
  const spy10 = parseFloat(spyQ.rows[0]?.spy_10d || 0);

  // ── Overall results ─────────────────────────────────────────────────────────
  const buys  = rows.filter(r => r.transaction_type === 'Buy');
  const sells = rows.filter(r => r.transaction_type === 'Sell');
  const b5    = buys.filter(r => r.ret_5d_pct != null).map(r => parseFloat(r.ret_5d_pct));
  const b10   = buys.filter(r => r.ret_10d_pct != null).map(r => parseFloat(r.ret_10d_pct));
  const s5    = sells.filter(r => r.ret_5d_pct != null).map(r => parseFloat(r.ret_5d_pct));
  const s10   = sells.filter(r => r.ret_10d_pct != null).map(r => parseFloat(r.ret_10d_pct));

  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  Overall — All Buys vs All Sells                           │');
  console.log('├─────────────────────────────────────────────────────────────┤');
  console.log(`│  SPY baseline         5d: ${fmt(spy5)}   10d: ${fmt(spy10)}`);
  console.log(`│  All Buys  (N=${b5.length.toString().padEnd(4)})  5d: ${fmt(avg(b5))}  win=${winRate(b5)}  10d: ${fmt(avg(b10))}`);
  console.log(`│  All Sells (N=${s5.length.toString().padEnd(4)})  5d: ${fmt(avg(s5))}  win=${winRate(s5)}  10d: ${fmt(avg(s10))}`);
  console.log('└─────────────────────────────────────────────────────────────┘');

  // ── Buys by amount range ─────────────────────────────────────────────────────
  console.log('\n── BUY breakdown by trade size ──');
  const sizeOrder = [
    '$1,001 - $15,000',
    '$15,001 - $50,000',
    '$50,001 - $100,000',
    '$100,001 - $250,000',
    '$250,001 - $500,000',
    '$500,001 - $1,000,000',
    '>$1,000,000',
  ];
  for (const sz of sizeOrder) {
    const group = buys.filter(r => r.amount_range === sz);
    const g5 = group.filter(r => r.ret_5d_pct != null).map(r => parseFloat(r.ret_5d_pct));
    const g10 = group.filter(r => r.ret_10d_pct != null).map(r => parseFloat(r.ret_10d_pct));
    if (g5.length < 3) continue;
    const edge5 = avg(g5) - spy5;
    const label = sz.replace('$','').replace(' - ', '-');
    console.log(`  ${label.padEnd(25)} N=${g5.length.toString().padEnd(4)} 5d: ${fmt(avg(g5))} (edge ${fmt(edge5)})  win=${winRate(g5)}  10d: ${fmt(avg(g10))}`);
  }

  // ── Buys by chamber ──────────────────────────────────────────────────────────
  console.log('\n── BUY breakdown by chamber ──');
  for (const ch of ['house', 'senate']) {
    const group = buys.filter(r => r.chamber === ch);
    const g5 = group.filter(r => r.ret_5d_pct != null).map(r => parseFloat(r.ret_5d_pct));
    const g10 = group.filter(r => r.ret_10d_pct != null).map(r => parseFloat(r.ret_10d_pct));
    if (g5.length < 3) continue;
    console.log(`  ${ch.padEnd(8)} N=${g5.length.toString().padEnd(4)} 5d: ${fmt(avg(g5))}  win=${winRate(g5)}  10d: ${fmt(avg(g10))}`);
  }

  // ── Disclosure lag effect ────────────────────────────────────────────────────
  console.log('\n── BUY disclosure lag effect (trade date → filed date) ──');
  const lagBuckets = [[0,5,'0-5 days'],[5,15,'6-15 days'],[15,30,'16-30 days'],[30,999,'30+ days']];
  for (const [lo, hi, label] of lagBuckets) {
    const group = buys.filter(r => r.disclosure_days >= lo && r.disclosure_days < hi);
    const g5 = group.filter(r => r.ret_5d_pct != null).map(r => parseFloat(r.ret_5d_pct));
    const g10 = group.filter(r => r.ret_10d_pct != null).map(r => parseFloat(r.ret_10d_pct));
    if (g5.length < 3) continue;
    console.log(`  Lag ${label.padEnd(12)} N=${g5.length.toString().padEnd(4)} 5d: ${fmt(avg(g5))}  win=${winRate(g5)}  10d: ${fmt(avg(g10))}`);
  }

  // ── Top performing members ────────────────────────────────────────────────────
  console.log('\n── Top members by 5d average return (buys only, min 3 trades) ──');
  const memberMap = {};
  for (const r of buys) {
    if (r.ret_5d_pct == null) continue;
    const m = r.member_name || 'Unknown';
    if (!memberMap[m]) memberMap[m] = { rets5: [], rets10: [], chamber: r.chamber };
    memberMap[m].rets5.push(parseFloat(r.ret_5d_pct));
    memberMap[m].rets10.push(parseFloat(r.ret_10d_pct || 0));
  }
  const memberRows = Object.entries(memberMap)
    .filter(([, v]) => v.rets5.length >= 3)
    .map(([name, v]) => ({ name, n: v.rets5.length, avg5: avg(v.rets5), win5: winRate(v.rets5), avg10: avg(v.rets10), chamber: v.chamber }))
    .sort((a, b) => b.avg5 - a.avg5)
    .slice(0, 10);

  for (const m of memberRows) {
    console.log(`  ${m.name.padEnd(30)} [${(m.chamber||'?')[0].toUpperCase()}] N=${m.n.toString().padEnd(3)} 5d: ${fmt(m.avg5)}  win=${m.win5}  10d: ${fmt(m.avg10)}`);
  }

  // ── High-conviction buys (≥$100K) ───────────────────────────────────────────
  const bigBuys = buys.filter(r => {
    const a = r.amount_range || '';
    return a.includes('$100,001') || a.includes('$250,001') || a.includes('$500,001') || a.includes('>$1,000,000');
  });
  const bb5  = bigBuys.filter(r => r.ret_5d_pct != null).map(r => parseFloat(r.ret_5d_pct));
  const bb10 = bigBuys.filter(r => r.ret_10d_pct != null).map(r => parseFloat(r.ret_10d_pct));
  if (bb5.length >= 5) {
    console.log('\n── High-conviction BUYS ≥$100K ──');
    console.log(`  N=${bb5.length} | 5d: ${fmt(avg(bb5))} (edge ${fmt(avg(bb5)-spy5)} vs SPY) | win=${winRate(bb5)} | 10d: ${fmt(avg(bb10))}`);
    // Top tickers
    const tickerMap = {};
    for (const r of bigBuys) {
      if (r.ret_5d_pct == null) continue;
      if (!tickerMap[r.ticker]) tickerMap[r.ticker] = [];
      tickerMap[r.ticker].push(parseFloat(r.ret_5d_pct));
    }
    const topTickers = Object.entries(tickerMap)
      .sort((a,b) => avg(b[1]) - avg(a[1]))
      .slice(0, 8);
    console.log('  Top tickers by 5d return:');
    for (const [tk, rets] of topTickers) {
      console.log(`    ${tk.padEnd(8)} N=${rets.length} avg_5d=${fmt(avg(rets))}`);
    }
  }

  // ── Conclusion ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  CONCLUSION');
  console.log('══════════════════════════════════════════════════════════════');
  const buyEdge5 = avg(b5) - spy5;
  console.log(`  Buy signal edge (5d): ${fmt(buyEdge5)} vs SPY`);
  console.log(`  Win rate (buys):      ${winRate(b5)}`);
  console.log(`  Sell signal (5d):     ${fmt(avg(s5))} — useful as bearish confirmation?`);

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
