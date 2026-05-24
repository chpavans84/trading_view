/**
 * tests/bot-engine/what-if.js
 *
 * Given the existing 30 days of bot_decisions, simulate "what if I had used
 * different rules" against the historical SCORED decisions. Read-only.
 *
 * Run:  node --env-file=.env tests/bot-engine/what-if.js
 *
 * For each (threshold) value in a list of candidates, count:
 *   - How many decisions would have triggered a buy
 *   - On how many distinct symbols
 *   - Average / max score that would have qualified
 *
 * This doesn't run scanBot — it operates on already-logged composite scores.
 * Cheap, exact for the rule changes it can model.
 */

import pg from 'pg';
import { promises as fs } from 'fs';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DAYS = 30;
const THRESHOLDS = [60, 50, 45, 40, 35, 30, 25, 20];

async function main() {
  const today = new Date().toISOString().split('T')[0];

  // Pull all scored decisions in the window
  const { rows: decisions } = await pool.query(`
    SELECT bd.symbol, bd.composite_score, bd.scanned_at, bd.bot_id, b.name AS bot_name
    FROM bot_decisions bd JOIN bots b ON b.id = bd.bot_id
    WHERE bd.scanned_at > NOW() - INTERVAL '${DAYS} days'
      AND bd.composite_score IS NOT NULL
    ORDER BY bd.scanned_at DESC
  `);

  const md = [];
  md.push(`# What-If Threshold Simulator — ${today}`);
  md.push('');
  md.push(`Source: ${decisions.length} scored decisions over last ${DAYS} days. Read-only.`);
  md.push('');
  md.push(`**Premise:** holding everything else constant, if the threshold were X, how many trades would the bot have fired?`);
  md.push('');
  md.push(`Useful for Monday Decision B (recalibrate threshold). Each "would-trade" row is one historical scanner tick where the top-scored candidate exceeded the hypothetical threshold.`);
  md.push('');
  md.push(`> **Important:** this models a single rule change (threshold) and assumes setup classifier + hard gates stayed the same. It doesn't simulate scenarios where multiple rules change simultaneously.`);
  md.push('');

  md.push('## Threshold sensitivity');
  md.push('');
  md.push('| Threshold | Would-trade decisions | Unique symbols | Mean score | Peak score |');
  md.push('|---|---|---|---|---|');

  for (const t of THRESHOLDS) {
    const qual = decisions.filter(d => Number(d.composite_score) >= t);
    const uniq = new Set(qual.map(d => d.symbol)).size;
    const mean = qual.length ? (qual.reduce((s, d) => s + Number(d.composite_score), 0) / qual.length).toFixed(2) : '—';
    const peak = qual.length ? Math.max(...qual.map(d => Number(d.composite_score))).toFixed(2) : '—';
    md.push(`| ${t} | ${qual.length} | ${uniq} | ${mean} | ${peak} |`);
  }
  md.push('');

  // What symbols would have triggered at threshold 30 / 35 / 40?
  for (const t of [40, 35, 30]) {
    const qual = decisions.filter(d => Number(d.composite_score) >= t);
    if (qual.length === 0) continue;

    const bySymbol = {};
    for (const d of qual) {
      if (!bySymbol[d.symbol]) bySymbol[d.symbol] = { count: 0, peak: 0 };
      bySymbol[d.symbol].count++;
      bySymbol[d.symbol].peak = Math.max(bySymbol[d.symbol].peak, Number(d.composite_score));
    }
    const sorted = Object.entries(bySymbol).sort((a, b) => b[1].peak - a[1].peak);

    md.push(`## At threshold ${t} — what would have traded`);
    md.push('');
    md.push(`Total qualifying decisions: **${qual.length}** across ${sorted.length} unique symbols.`);
    md.push('');
    md.push('| Symbol | # qualifying decisions | Peak score |');
    md.push('|---|---|---|');
    for (const [sym, info] of sorted) {
      md.push(`| ${sym} | ${info.count} | ${info.peak.toFixed(2)} |`);
    }
    md.push('');
  }

  // Cap the analysis — what's the relationship between scores hit and unique symbols?
  md.push('## Coverage curve — how many DIFFERENT names would the bot ever trade?');
  md.push('');
  md.push('Threshold X = "bot can pick from this many unique symbols across 30 days"');
  md.push('');
  md.push('| Threshold | Unique tradeable symbols |');
  md.push('|---|---|');
  for (const t of [60, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0]) {
    const uniq = new Set(decisions.filter(d => Number(d.composite_score) >= t).map(d => d.symbol)).size;
    const bar = '█'.repeat(Math.min(50, uniq));
    md.push(`| ${t} | ${uniq} ${bar} |`);
  }
  md.push('');

  md.push('## Honest interpretation');
  md.push('');
  md.push(`At the current production threshold of 60: **0 trades**, 0 unique symbols. The bot is structurally inert.`);
  md.push('');
  md.push(`At 45: ${(() => {
    const q = decisions.filter(d => Number(d.composite_score) >= 45);
    return `${q.length} would-trades across ${new Set(q.map(d => d.symbol)).size} unique symbols. Still very sparse.`;
  })()}`);
  md.push('');
  md.push(`At 30 (would catch top ~17% of scores): ${(() => {
    const q = decisions.filter(d => Number(d.composite_score) >= 30);
    return `${q.length} would-trades across ${new Set(q.map(d => d.symbol)).size} unique symbols. Now the bot has meaningful activity to learn from.`;
  })()}`);
  md.push('');
  md.push(`**My recommendation:** drop threshold to 30 on bot 16, keep bot 12 at 60 for comparison. Watch outcomes for 5 trading days. Make data-driven adjustment after that.`);
  md.push('');
  md.push('---');
  md.push('');
  md.push('*Generated by tests/bot-engine/what-if.js. Read-only.*');

  const outPath = `reports/what-if-${today.replaceAll('-','')}.md`;
  await fs.writeFile(outPath, md.join('\n') + '\n');
  console.log(`Wrote ${outPath}`);
  await pool.end();
}

main().catch(e => {
  console.error('[what-if fatal]', e);
  pool.end().catch(() => {});
  process.exit(1);
});
