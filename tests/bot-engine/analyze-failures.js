/**
 * tests/bot-engine/analyze-failures.js
 *
 * Reads all reports/*.json sidecars and prints exit-reason failure patterns
 * across strategies. Pure analysis — no writes, no production touches.
 *
 * Use: node tests/bot-engine/analyze-failures.js
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, '..', '..', 'reports');

function fmt(n, d = 2) { return Number(n).toFixed(d); }
function fmt$(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0); }
function pad(s, n) { return String(s).padEnd(n); }
function padR(s, n) { return String(s).padStart(n); }

async function main() {
  const files = (await fs.readdir(REPORTS_DIR))
    .filter(f => f.startsWith('replay-') && f.endsWith('.json'))
    .sort();

  // Keep only the latest run per strategy (the backfilled set is all from today's batch)
  const latest = new Map();
  for (const f of files) {
    const raw = await fs.readFile(path.join(REPORTS_DIR, f), 'utf8');
    const doc = JSON.parse(raw);
    const prev = latest.get(doc.strategy);
    if (!prev || doc.generated_at > prev.generated_at) latest.set(doc.strategy, doc);
  }

  console.log('═'.repeat(110));
  console.log('  FAILURE PATTERN ANALYSIS — EXIT REASON BREAKDOWN');
  console.log('═'.repeat(110));

  for (const [strategy, doc] of latest) {
    const trades  = doc.trades || [];
    const winners = trades.filter(t => (t.pnl_usd ?? 0) > 0);
    const losers  = trades.filter(t => (t.pnl_usd ?? 0) <= 0);
    const win = `${doc.args?.from}→${doc.args?.to}`;

    console.log();
    console.log('─'.repeat(110));
    console.log(`▸ ${strategy}  (${win})  ·  ${trades.length} trades · ${winners.length}W / ${losers.length}L · final ${fmt$(doc.summary?.returns?.final_value_usd - doc.summary?.returns?.initial_capital_usd)}`);
    console.log('─'.repeat(110));

    // Group by exit_reason
    const byReason = new Map();
    for (const t of trades) {
      const r = t.exit_reason || 'unknown';
      if (!byReason.has(r)) byReason.set(r, { n: 0, w: 0, l: 0, sumUsd: 0, sumPct: 0 });
      const b = byReason.get(r);
      b.n++;
      b.sumUsd += Number(t.pnl_usd ?? 0);
      b.sumPct += Number(t.pnl_pct ?? 0) * 100;
      if ((t.pnl_usd ?? 0) > 0) b.w++; else b.l++;
    }
    const rows = [...byReason.entries()]
      .map(([r, b]) => ({ r, ...b, avgPct: b.sumPct / b.n, wr: b.w / b.n }))
      .sort((a, b) => a.sumUsd - b.sumUsd);

    console.log(`  ${pad('Exit reason', 28)}${padR('N', 6)}${padR('W/L', 10)}${padR('WR', 8)}${padR('Avg%', 10)}${padR('Sum$', 14)}`);
    for (const r of rows) {
      console.log(`  ${pad(r.r, 28)}${padR(r.n, 6)}${padR(r.w + '/' + r.l, 10)}${padR((r.wr * 100).toFixed(0) + '%', 8)}${padR(fmt(r.avgPct, 2) + '%', 10)}${padR(fmt$(r.sumUsd), 14)}`);
    }

    // Loser hold-time distribution
    if (losers.length) {
      const holds = losers.map(t => t.hold_days ?? 0).sort((a, b) => a - b);
      const med   = holds[Math.floor(holds.length / 2)];
      const p25   = holds[Math.floor(holds.length * 0.25)];
      const p75   = holds[Math.floor(holds.length * 0.75)];
      console.log(`  Loser hold-days   median ${fmt(med, 1)}d  ·  p25 ${fmt(p25, 1)}d  ·  p75 ${fmt(p75, 1)}d`);
    }

    // Loser PnL% distribution
    if (losers.length) {
      const pcts = losers.map(t => (t.pnl_pct ?? 0) * 100).sort((a, b) => a - b);
      const p10  = pcts[Math.floor(pcts.length * 0.10)];
      const med  = pcts[Math.floor(pcts.length / 2)];
      console.log(`  Loser %           median ${fmt(med, 2)}%  ·  worst-10%  ≤ ${fmt(p10, 2)}%`);
    }
  }
  console.log();
  console.log('═'.repeat(110));
}

main().catch(e => { console.error(e); process.exit(1); });
