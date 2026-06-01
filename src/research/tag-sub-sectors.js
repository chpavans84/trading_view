/**
 * Tag sub_sector column in tradable_universe from industry mapping.
 *
 * Run: node --env-file=.env src/research/tag-sub-sectors.js
 * Safe to re-run — only updates rows where sub_sector IS NULL and industry IS NOT NULL.
 */

import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BATCH_SIZE = 100;

// industry → sub_sector mapping
const INDUSTRY_MAP = {
  'Semiconductors':                              'semis',
  'Semiconductor Equipment & Materials':         'semis_equipment',
  'Software - Infrastructure':                   'cloud_software',
  'Software - Application':                      'saas',
  'Internet Content & Information':              'internet_platforms',
  'Computer Hardware':                           'hardware',
  'Communication Equipment':                     'networking',
  'Electronic Components':                       'electronics',
  'Information Technology Services':             'it_services',
  'Consumer Electronics':                        'consumer_electronics',
  'Financial Data & Stock Exchanges':            'fintech',
  'Banks - Regional':                            'banks_regional',
  'Banks - Diversified':                         'banks_diversified',
  'Capital Markets':                             'capital_markets',
  'Asset Management':                            'asset_management',
  'Insurance - Diversified':                     'insurance',
  'Drug Manufacturers - General':                'pharma_large',
  'Drug Manufacturers - Specialty & Generic':    'pharma_specialty',
  'Biotechnology':                               'biotech',
  'Medical Devices':                             'medtech',
  'Medical Instruments & Supplies':              'medtech',
  'Oil & Gas E&P':                               'energy_ep',
  'Oil & Gas Integrated':                        'energy_integrated',
  'Oil & Gas Midstream':                         'energy_midstream',
  'Specialty Retail':                            'retail_specialty',
  'Internet Retail':                             'retail_internet',
  'Grocery Stores':                              'retail_grocery',
  'Restaurants':                                 'restaurants',
  'Aerospace & Defense':                         'defense',
  'Airlines':                                    'airlines',
  'Trucking':                                    'transport_trucking',
  'Railroads':                                   'transport_rail',
  'Utilities - Regulated Electric':              'utilities_electric',
  'Real Estate Investment Trusts':               'reit',
  'Residential Construction':                    'homebuilders',
  'Gold':                                        'commodities_gold',
  'Copper':                                      'commodities_metals',
  'Agricultural Inputs':                         'commodities_ag',
};

/**
 * Derive sub_sector for a row.
 * Falls back to: sector.toLower().replace(/[^a-z]+/g, '_') or 'other'
 */
function deriveSubSector(industry, sector) {
  const mapped = INDUSTRY_MAP[industry];
  if (mapped) return mapped;
  if (sector && sector.trim()) {
    return sector.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '') || 'other';
  }
  return 'other';
}

async function main() {
  let client;
  try {
    client = await pool.connect();

    // Load all rows needing tagging
    const { rows } = await client.query(`
      SELECT symbol, industry, sector
      FROM tradable_universe
      WHERE industry IS NOT NULL AND sub_sector IS NULL
      ORDER BY symbol
    `);

    console.log(`[tag-sub-sectors] ${rows.length} rows to tag`);
    if (rows.length === 0) {
      console.log('[tag-sub-sectors] nothing to do — all rows with industry already have sub_sector');
      return;
    }

    let updated = 0;
    let batch = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      batch++;

      // Build VALUES list for batch update
      const values = [];
      const params = [];
      let paramIdx = 1;

      for (const row of chunk) {
        const subSector = deriveSubSector(row.industry, row.sector);
        values.push(`($${paramIdx++}, $${paramIdx++})`);
        params.push(row.symbol, subSector);
      }

      await client.query(
        `UPDATE tradable_universe AS tu
         SET sub_sector = v.sub_sector
         FROM (VALUES ${values.join(', ')}) AS v(symbol, sub_sector)
         WHERE tu.symbol = v.symbol`,
        params
      );

      updated += chunk.length;
      console.log(`[tag-sub-sectors] batch ${batch}: updated ${updated}/${rows.length}`);
    }

    // Verify
    const { rows: verify } = await client.query(`
      SELECT sub_sector, COUNT(*) AS cnt
      FROM tradable_universe
      WHERE sub_sector IS NOT NULL
      GROUP BY sub_sector
      ORDER BY cnt DESC
      LIMIT 20
    `);

    console.log('\n[tag-sub-sectors] Done. Top sub_sectors:');
    for (const r of verify) {
      console.log(`  ${r.sub_sector.padEnd(25)} ${r.cnt}`);
    }

    const { rows: stats } = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE sub_sector IS NOT NULL) AS tagged,
        COUNT(*) FILTER (WHERE industry IS NOT NULL)   AS has_industry,
        COUNT(*)                                        AS total
      FROM tradable_universe
    `);
    console.log(`\n[tag-sub-sectors] Summary: tagged=${stats[0].tagged}, has_industry=${stats[0].has_industry}, total=${stats[0].total}`);

  } finally {
    client?.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('[tag-sub-sectors] FATAL:', err.message);
  process.exit(1);
});
