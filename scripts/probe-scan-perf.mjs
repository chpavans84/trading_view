#!/usr/bin/env node
/**
 * scripts/probe-scan-perf.mjs — measure real per-candidate scoring cost.
 *
 * Run: npm run probe:scan-perf
 *
 * Steps:
 *   1. Pick an active bot
 *   2. Build its candidate universe (time it)
 *   3. Run diagnoseCandidate for each candidate up to a cap (time each)
 *   4. Report distribution: min/median/p95/max + total + projection at 300/500
 *   5. Run each proposed rule's candidate_generator SQL and report row counts + latency
 *
 * No state changes — diagnoseCandidate is read-only. Safe to run anytime.
 */

import { initDb, query } from '../src/core/db.js';
import { diagnoseCandidate } from '../src/core/bot-engine.js';

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)];
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

await initDb();

// ── 1. Find an active bot to probe ─────────────────────────────────────────
const { rows: bots } = await query(
  `SELECT id, name, broker, capital_usd, rules
     FROM bots
    WHERE status='active' AND deleted_at IS NULL
    ORDER BY id LIMIT 1`
);
if (!bots.length) { console.error('No active bot to probe'); process.exit(2); }
const bot = bots[0];
console.log(`\nProbe bot: #${bot.id} ${bot.name} (${bot.broker}, $${bot.capital_usd})\n`);

// ── 2. Build candidate universe (time it) ──────────────────────────────────
// We replicate _buildCandidateUniverse with a single union query rather than calling the
// non-exported function — same source tables, same general behavior.
console.log('─── 2. Building candidate universe ──────────────────────────────');
const t1 = performance.now();
const filters = bot.rules?.entry_filters ?? {};
const minMktCapB   = filters.market_cap_min_b  ?? 5;
const minAdvDollar = filters.min_adv_dollar_vol ?? 5_000_000;
const minPrice     = filters.price_min ?? 5;
const maxPrice     = filters.price_max ?? 2500;

const { rows: cands } = await query(`
  WITH baseline AS (
    SELECT symbol FROM tradable_universe
     WHERE (market_cap_usd >= $1 OR (market_cap_usd IS NULL AND adv_dollar_30d >= 1e9))
       AND (adv_dollar_30d >= $2 OR (adv_dollar_30d IS NULL AND market_cap_usd >= 1e10))
       AND last_price BETWEEN $3 AND $4
       AND fractionable = TRUE
     ORDER BY COALESCE(adv_dollar_30d, 0) DESC LIMIT 800
  ),
  flow AS (
    SELECT DISTINCT ticker AS symbol FROM uw_flow_alerts
     WHERE alerted_at > NOW() - INTERVAL '6 hours' AND premium >= 100000
  ),
  news AS (
    SELECT DISTINCT t.ticker AS symbol FROM benzinga_news bn,
         jsonb_array_elements_text(bn.tickers) AS t(ticker)
     WHERE bn.published_at > NOW() - INTERVAL '1 hour' AND bn.sentiment='positive'
  )
  SELECT symbol FROM baseline
  UNION SELECT symbol FROM flow
  UNION SELECT symbol FROM news
`, [minMktCapB * 1e9, minAdvDollar, minPrice, maxPrice]);
const universeTime = performance.now() - t1;
console.log(`  Universe build: ${fmtMs(universeTime)}`);
console.log(`  Total unique candidates: ${cands.length}`);

// ── 3. Time per-candidate scoring on a sample ──────────────────────────────
const SAMPLE_SIZE = Math.min(30, cands.length);   // 30 candidates is enough for stats
const sample = cands.slice(0, SAMPLE_SIZE).map(r => r.symbol);
console.log(`\n─── 3. Scoring ${SAMPLE_SIZE} sample candidates (sequential, like today) ───`);

const timings = [];
const t3 = performance.now();
for (const sym of sample) {
  const t = performance.now();
  try { await diagnoseCandidate(sym, bot); }
  catch (e) { console.log(`  ${sym.padEnd(6)} ERROR: ${e.message.slice(0, 60)}`); continue; }
  const dt = performance.now() - t;
  timings.push(dt);
  // Print every 5th to avoid spam
  if (timings.length % 5 === 1) console.log(`  ${sym.padEnd(6)} ${fmtMs(dt)}`);
}
const sequentialTotal = performance.now() - t3;

if (timings.length === 0) {
  console.error('No candidates were scored successfully. Aborting.');
  process.exit(1);
}

const median = percentile(timings, 0.50);
const p95    = percentile(timings, 0.95);
const max    = Math.max(...timings);
const min    = Math.min(...timings);
const avg    = timings.reduce((a, b) => a + b, 0) / timings.length;

console.log('\n─── 4. Timing distribution ──────────────────────────────────────');
console.log(`  Sample size:   ${timings.length}`);
console.log(`  Min:           ${fmtMs(min)}`);
console.log(`  Median:        ${fmtMs(median)}`);
console.log(`  Average:       ${fmtMs(avg)}`);
console.log(`  p95:           ${fmtMs(p95)}`);
console.log(`  Max:           ${fmtMs(max)}`);
console.log(`  Total (${SAMPLE_SIZE} sequential): ${fmtMs(sequentialTotal)}`);

// ── 5. Project scan time at different cap sizes ────────────────────────────
console.log('\n─── 5. Projections (using median per-candidate time) ────────────');
const m = median;
for (const cap of [50, 100, 200, 300, 500]) {
  const seqMs   = cap * m;
  const conc8Ms = Math.ceil(cap / 8) * m;
  console.log(`  ${String(cap).padStart(3)} candidates: sequential ${fmtMs(seqMs).padStart(8)}   /   8-way concurrent ${fmtMs(conc8Ms).padStart(8)}`);
}

// ── 6. Cost of each proposed rule's candidate_generator query ──────────────
console.log('\n─── 6. Proposed per-rule candidate generators ───────────────────');
const ruleQueries = [
  {
    id: 'insider_director_cluster',
    sql: `
      SELECT ticker FROM uw_insider_trades
       WHERE role IN ('Director','10% Owner')
         AND transaction_type = 'P'
         AND value >= 100000
         AND filed_at > NOW() - INTERVAL '30 days'
       GROUP BY ticker HAVING COUNT(*) >= 2`
  },
  {
    id: 'at_52w_high_with_volume',
    sql: `
      SELECT symbol AS ticker FROM tradable_universe
       WHERE last_price >= 0.98 * week_52_high
         AND day_volume >= 2 * avg_volume_30d
         AND last_price BETWEEN 5 AND 2500
         AND fractionable = TRUE`
  },
  {
    id: 'congress_high_conviction',
    sql: `
      SELECT DISTINCT ticker FROM uw_congressional_trades
       WHERE transaction_type IN ('buy','purchase')
         AND amount_min >= 250000
         AND filed_at > NOW() - INTERVAL '30 days'`
  },
  {
    id: 'momentum_flip',
    sql: `
      SELECT DISTINCT symbol AS ticker FROM conviction_scores
       WHERE scored_at > NOW() - INTERVAL '24 hours'
         AND (signals->>'drift_5d_pct')::numeric BETWEEN 0 AND 15
         AND (signals->>'macd_hist')::numeric > -3`
  }
];
const allRuleCandidates = new Set();
for (const r of ruleQueries) {
  const t = performance.now();
  try {
    const { rows } = await query(r.sql);
    const dt = performance.now() - t;
    rows.forEach(x => allRuleCandidates.add(x.ticker));
    console.log(`  ${r.id.padEnd(28)} ${String(rows.length).padStart(4)} tickers  ${fmtMs(dt)}`);
  } catch (e) {
    console.log(`  ${r.id.padEnd(28)} ERROR: ${e.message.slice(0, 80)}`);
  }
}
console.log(`  ${'TOTAL UNIQUE (dedup)'.padEnd(28)} ${String(allRuleCandidates.size).padStart(4)} tickers across all rules`);

// Final projection: how long would a real "rules-mode" scan take?
console.log('\n─── 7. Projected real-world rule-mode scan ──────────────────────');
const ruleUniverse = allRuleCandidates.size;
const seq = ruleUniverse * median;
const c8  = Math.ceil(ruleUniverse / 8) * median;
const c16 = Math.ceil(ruleUniverse / 16) * median;
console.log(`  ${ruleUniverse} candidates from union of all rules`);
console.log(`    sequential:        ${fmtMs(seq)}`);
console.log(`    8-way concurrent:  ${fmtMs(c8)}`);
console.log(`    16-way concurrent: ${fmtMs(c16)}`);

console.log('\nDone.');
process.exit(0);
