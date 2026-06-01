#!/usr/bin/env node
/**
 * scripts/load-correlations-to-neo4j.mjs
 *
 * Pushes meaningful correlation pairs from Postgres `stock_correlations`
 * into Neo4j as :CORRELATES_WITH edges between :Company nodes.
 *
 * Only loads pairs with |corr_90d| ≥ 0.50 (filters out weak/random correlations).
 *
 * Creates :Company nodes on the fly if they don't exist (MERGE).
 * Edge direction is undirected conceptually but stored A → B with A < B.
 *
 * Properties on :CORRELATES_WITH:
 *   - corr_30d, corr_90d, corr_252d
 *   - obs_90d  (number of paired daily observations in the 90d window)
 *   - kind:    'positive' | 'negative'
 *   - computed_at
 *
 * Usage:
 *   node scripts/load-correlations-to-neo4j.mjs                # default threshold 0.50
 *   node scripts/load-correlations-to-neo4j.mjs --threshold 0.70
 *   node scripts/load-correlations-to-neo4j.mjs --reset        # delete old :CORRELATES_WITH first
 */

import '../src/core/env-loader.js';
import { initDb, query } from '../src/core/db.js';
import neo4j from 'neo4j-driver';

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const THRESHOLD = parseFloat(getArg('threshold', '0.50'));
const RESET     = args.includes('--reset');

async function main() {
  await initDb();

  if (!process.env.NEO4J_URI || !process.env.NEO4J_PASSWORD) {
    console.error('NEO4J_URI / NEO4J_PASSWORD missing in .env'); process.exit(2);
  }
  const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD)
  );

  // 1. Fetch pairs from Postgres
  console.log(`[neo4j-corr] fetching pairs with |corr_90d| >= ${THRESHOLD}`);
  const { rows } = await query(`
    SELECT symbol_a, symbol_b, corr_30d, corr_90d, corr_252d, obs_90d
      FROM stock_correlations
     WHERE ABS(corr_90d) >= $1
     ORDER BY ABS(corr_90d) DESC
  `, [THRESHOLD]);
  console.log(`[neo4j-corr] ${rows.length} pairs to load`);

  if (!rows.length) {
    console.log('[neo4j-corr] nothing to do'); process.exit(0);
  }

  const session = driver.session();
  try {
    if (RESET) {
      console.log('[neo4j-corr] DELETE all existing :CORRELATES_WITH edges');
      await session.run(`MATCH ()-[r:CORRELATES_WITH]->() DELETE r`);
    }

    // 2. Batch UNWIND insert — much faster than per-row MERGE
    const BATCH = 1000;
    const t0 = Date.now();
    let written = 0;

    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH).map(r => ({
        a: r.symbol_a, b: r.symbol_b,
        c30:  r.corr_30d  != null ? Number(r.corr_30d)  : null,
        c90:  r.corr_90d  != null ? Number(r.corr_90d)  : null,
        c252: r.corr_252d != null ? Number(r.corr_252d) : null,
        obs:  r.obs_90d,
        kind: Number(r.corr_90d) >= 0 ? 'positive' : 'negative',
      }));

      await session.run(`
        UNWIND $pairs AS p
        MERGE (a:Company {ticker: p.a})
        MERGE (b:Company {ticker: p.b})
        MERGE (a)-[r:CORRELATES_WITH]->(b)
          SET r.corr_30d    = p.c30,
              r.corr_90d    = p.c90,
              r.corr_252d   = p.c252,
              r.obs_90d     = p.obs,
              r.kind        = p.kind,
              r.computed_at = datetime()
      `, { pairs: chunk });

      written += chunk.length;
      if (written % 5000 === 0 || written === rows.length) {
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[neo4j-corr] ${written}/${rows.length}  (${sec}s)`);
      }
    }

    // 3. Final stats
    const stats = await session.run(`
      MATCH (n:Company) RETURN count(n) AS companies
    `);
    const edgeStats = await session.run(`
      MATCH ()-[r:CORRELATES_WITH]->() RETURN count(r) AS edges,
                                              avg(r.corr_90d) AS avg_corr,
                                              count(CASE WHEN r.corr_90d >= 0.7 THEN 1 END) AS strong_pos,
                                              count(CASE WHEN r.corr_90d <= -0.5 THEN 1 END) AS strong_neg
    `);
    console.log('\n[neo4j-corr] Final graph state:');
    console.log(`  Company nodes:      ${stats.records[0].get('companies').toNumber()}`);
    console.log(`  CORRELATES_WITH:    ${edgeStats.records[0].get('edges').toNumber()}`);
    console.log(`  avg corr_90d:       ${edgeStats.records[0].get('avg_corr')?.toFixed?.(3) ?? '—'}`);
    console.log(`  ≥ 0.7 positive:     ${edgeStats.records[0].get('strong_pos').toNumber()}`);
    console.log(`  ≤ -0.5 negative:    ${edgeStats.records[0].get('strong_neg').toNumber()}`);

  } finally {
    await session.close();
    await driver.close();
  }

  process.exit(0);
}

main().catch(e => { console.error('[neo4j-corr] FATAL:', e); process.exit(1); });
