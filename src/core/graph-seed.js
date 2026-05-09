import { upsertCompany, upsertRelationship, setupSchema } from './graph.js';

const COMPANIES = [
  // Semiconductor Equipment
  { ticker: 'ASML',    name: 'ASML Holding',             sector: 'Semiconductor Equipment', sub_sector: 'Lithography',        exchange: 'NASDAQ', country: 'NL', market_cap_usd: 280_000_000_000 },
  { ticker: 'AMAT',    name: 'Applied Materials',         sector: 'Semiconductor Equipment', sub_sector: 'Deposition',         exchange: 'NASDAQ', country: 'US', market_cap_usd: 140_000_000_000 },
  { ticker: 'LRCX',    name: 'Lam Research',              sector: 'Semiconductor Equipment', sub_sector: 'Etch',               exchange: 'NASDAQ', country: 'US', market_cap_usd: 95_000_000_000  },
  { ticker: 'KLAC',    name: 'KLA Corporation',           sector: 'Semiconductor Equipment', sub_sector: 'Inspection',         exchange: 'NASDAQ', country: 'US', market_cap_usd: 80_000_000_000  },
  // Foundries
  { ticker: 'TSM',     name: 'TSMC',                      sector: 'Semiconductor Foundry',   sub_sector: 'Logic Fab',          exchange: 'NYSE',   country: 'TW', market_cap_usd: 850_000_000_000 },
  { ticker: 'INTC',    name: 'Intel',                     sector: 'Semiconductor',           sub_sector: 'CPU/Foundry',        exchange: 'NASDAQ', country: 'US', market_cap_usd: 90_000_000_000  },
  // Fabless Chips
  { ticker: 'NVDA',    name: 'NVIDIA',                    sector: 'Semiconductor',           sub_sector: 'GPU/AI',             exchange: 'NASDAQ', country: 'US', market_cap_usd: 2_800_000_000_000 },
  { ticker: 'AMD',     name: 'Advanced Micro Devices',    sector: 'Semiconductor',           sub_sector: 'CPU/GPU',            exchange: 'NASDAQ', country: 'US', market_cap_usd: 180_000_000_000 },
  { ticker: 'QCOM',    name: 'Qualcomm',                  sector: 'Semiconductor',           sub_sector: 'Mobile/IoT',         exchange: 'NASDAQ', country: 'US', market_cap_usd: 160_000_000_000 },
  { ticker: 'AVGO',    name: 'Broadcom',                  sector: 'Semiconductor',           sub_sector: 'Networking/AI ASIC', exchange: 'NASDAQ', country: 'US', market_cap_usd: 700_000_000_000 },
  { ticker: 'ARM',     name: 'Arm Holdings',              sector: 'Semiconductor',           sub_sector: 'IP Licensing',       exchange: 'NASDAQ', country: 'GB', market_cap_usd: 130_000_000_000 },
  // Memory
  { ticker: 'MU',      name: 'Micron Technology',         sector: 'Semiconductor',           sub_sector: 'Memory/HBM',         exchange: 'NASDAQ', country: 'US', market_cap_usd: 90_000_000_000  },
  { ticker: 'SAMSUNG', name: 'Samsung Electronics',       sector: 'Semiconductor',           sub_sector: 'Memory/Foundry',     exchange: 'KRX',    country: 'KR', market_cap_usd: 280_000_000_000 },
  // Cloud / Data Centers
  { ticker: 'MSFT',    name: 'Microsoft',                 sector: 'Cloud',                   sub_sector: 'Azure/AI',           exchange: 'NASDAQ', country: 'US', market_cap_usd: 3_100_000_000_000 },
  { ticker: 'META',    name: 'Meta Platforms',            sector: 'Cloud',                   sub_sector: 'Social/AI Infra',    exchange: 'NASDAQ', country: 'US', market_cap_usd: 1_400_000_000_000 },
  { ticker: 'GOOGL',   name: 'Alphabet',                  sector: 'Cloud',                   sub_sector: 'GCP/AI',             exchange: 'NASDAQ', country: 'US', market_cap_usd: 2_100_000_000_000 },
  { ticker: 'AMZN',    name: 'Amazon',                    sector: 'Cloud',                   sub_sector: 'AWS/Commerce',       exchange: 'NASDAQ', country: 'US', market_cap_usd: 2_000_000_000_000 },
  { ticker: 'AAPL',    name: 'Apple',                     sector: 'Consumer Tech',           sub_sector: 'iPhone/Mac',         exchange: 'NASDAQ', country: 'US', market_cap_usd: 3_200_000_000_000 },
  // Energy
  { ticker: 'XOM',     name: 'ExxonMobil',                sector: 'Energy',                  sub_sector: 'Integrated Oil',     exchange: 'NYSE',   country: 'US', market_cap_usd: 480_000_000_000 },
  { ticker: 'CVX',     name: 'Chevron',                   sector: 'Energy',                  sub_sector: 'Integrated Oil',     exchange: 'NYSE',   country: 'US', market_cap_usd: 260_000_000_000 },
  { ticker: 'HAL',     name: 'Halliburton',               sector: 'Energy',                  sub_sector: 'Oilfield Services',  exchange: 'NYSE',   country: 'US', market_cap_usd: 27_000_000_000  },
  { ticker: 'SLB',     name: 'SLB (Schlumberger)',        sector: 'Energy',                  sub_sector: 'Oilfield Services',  exchange: 'NYSE',   country: 'US', market_cap_usd: 52_000_000_000  },
  // Power / Utilities for Data Centers
  { ticker: 'VST',     name: 'Vistra Energy',             sector: 'Utilities',               sub_sector: 'Power Generation',   exchange: 'NYSE',   country: 'US', market_cap_usd: 35_000_000_000  },
  { ticker: 'CEG',     name: 'Constellation Energy',      sector: 'Utilities',               sub_sector: 'Nuclear Power',      exchange: 'NASDAQ', country: 'US', market_cap_usd: 65_000_000_000  },
  { ticker: 'ETR',     name: 'Entergy',                   sector: 'Utilities',               sub_sector: 'Power Grid',         exchange: 'NYSE',   country: 'US', market_cap_usd: 22_000_000_000  },
];

const RELATIONSHIPS = [
  // ── Equipment → Foundries ─────────────────────────────────────────────────
  { from: 'ASML', to: 'TSM',     type: 'SUPPLIES_TO',     props: { product_category: 'EUV Lithography',    market_share_pct: 90, supply_criticality: 'sole',    can_substitute: false, lead_time_months: 18, source: 'annual_report', confidence: 'high'   } },
  { from: 'ASML', to: 'SAMSUNG', type: 'SUPPLIES_TO',     props: { product_category: 'EUV Lithography',    market_share_pct: 90, supply_criticality: 'sole',    can_substitute: false, lead_time_months: 18, source: 'annual_report', confidence: 'high'   } },
  { from: 'ASML', to: 'INTC',    type: 'SUPPLIES_TO',     props: { product_category: 'EUV Lithography',    market_share_pct: 90, supply_criticality: 'primary', can_substitute: false, lead_time_months: 18, source: 'annual_report', confidence: 'high'   } },
  { from: 'AMAT', to: 'TSM',     type: 'SUPPLIES_TO',     props: { product_category: 'CVD/PVD Equipment',  market_share_pct: 22, supply_criticality: 'primary', source: 'sec_10k',      confidence: 'high'   } },
  { from: 'AMAT', to: 'SAMSUNG', type: 'SUPPLIES_TO',     props: { product_category: 'CVD/PVD Equipment',  market_share_pct: 20, supply_criticality: 'primary', source: 'sec_10k',      confidence: 'high'   } },
  { from: 'LRCX', to: 'TSM',     type: 'SUPPLIES_TO',     props: { product_category: 'Etch Equipment',     market_share_pct: 18, supply_criticality: 'primary', source: 'sec_10k',      confidence: 'high'   } },
  { from: 'KLAC', to: 'TSM',     type: 'SUPPLIES_TO',     props: { product_category: 'Inspection/Metrology', market_share_pct: 50, supply_criticality: 'primary', source: 'sec_10k',   confidence: 'high'   } },

  // ── Foundries → Fabless ───────────────────────────────────────────────────
  { from: 'TSM', to: 'NVDA',    type: 'MANUFACTURES_FOR', props: { revenue_pct: 23, product: 'AI GPUs (H100/B200)',    wafer_capacity_pct: 20, source: 'sec_10k',      confidence: 'high'   } },
  { from: 'TSM', to: 'AMD',     type: 'MANUFACTURES_FOR', props: { revenue_pct: 8,  product: 'CPU/GPU',                wafer_capacity_pct: 8,  source: 'sec_10k',      confidence: 'high'   } },
  { from: 'TSM', to: 'AAPL',   type: 'MANUFACTURES_FOR', props: { revenue_pct: 25, product: 'A/M-series chips',        wafer_capacity_pct: 22, source: 'sec_10k',      confidence: 'high'   } },
  { from: 'TSM', to: 'QCOM',   type: 'MANUFACTURES_FOR', props: { revenue_pct: 7,  product: 'Snapdragon SoCs',         wafer_capacity_pct: 6,  source: 'sec_10k',      confidence: 'high'   } },
  { from: 'TSM', to: 'AVGO',   type: 'MANUFACTURES_FOR', props: { revenue_pct: 5,  product: 'Networking/AI ASICs',     wafer_capacity_pct: 4,  source: 'sec_10k',      confidence: 'high'   } },
  { from: 'SAMSUNG', to: 'QCOM', type: 'MANUFACTURES_FOR', props: { revenue_pct: 10, product: 'Snapdragon (secondary fab)', source: 'news',     confidence: 'medium' } },

  // ── IP Licensing ──────────────────────────────────────────────────────────
  { from: 'ARM', to: 'AAPL',   type: 'LICENSES_TO',      props: { license_type: 'architecture', royalty_model: 'per_chip', source: 'annual_report', confidence: 'high' } },
  { from: 'ARM', to: 'QCOM',   type: 'LICENSES_TO',      props: { license_type: 'architecture', royalty_model: 'per_chip', source: 'annual_report', confidence: 'high' } },
  { from: 'ARM', to: 'NVDA',   type: 'LICENSES_TO',      props: { license_type: 'architecture', royalty_model: 'per_chip', source: 'annual_report', confidence: 'high' } },
  { from: 'ARM', to: 'AMZN',   type: 'LICENSES_TO',      props: { license_type: 'architecture', royalty_model: 'per_chip', estimated_revenue_usd: 300_000_000, source: 'annual_report', confidence: 'high' } },
  { from: 'ARM', to: 'SAMSUNG', type: 'LICENSES_TO',     props: { license_type: 'architecture', royalty_model: 'per_chip', source: 'annual_report', confidence: 'high' } },

  // ── NVIDIA Customers ──────────────────────────────────────────────────────
  { from: 'NVDA', to: 'MSFT',   type: 'CUSTOMER_OF',     props: { revenue_pct: 15, product: 'H100/B200 for Azure AI',  source: 'earnings_call', confidence: 'high'   } },
  { from: 'NVDA', to: 'META',   type: 'CUSTOMER_OF',     props: { revenue_pct: 12, product: 'H100 clusters for LLMs',  source: 'earnings_call', confidence: 'high'   } },
  { from: 'NVDA', to: 'GOOGL',  type: 'CUSTOMER_OF',     props: { revenue_pct: 10, product: 'H100 for GCP/Gemini',     source: 'earnings_call', confidence: 'high'   } },
  { from: 'NVDA', to: 'AMZN',   type: 'CUSTOMER_OF',     props: { revenue_pct: 10, product: 'H100 for AWS Trainium',   source: 'earnings_call', confidence: 'high'   } },

  // ── Memory ────────────────────────────────────────────────────────────────
  { from: 'MU', to: 'NVDA',    type: 'SUPPLIES_TO',      props: { product_category: 'HBM3e Memory',  market_share_pct: 25, supply_criticality: 'primary', source: 'earnings_call', confidence: 'high' } },
  { from: 'MU', to: 'AMZN',   type: 'SUPPLIES_TO',      props: { product_category: 'DRAM/NAND',     market_share_pct: 22, supply_criticality: 'primary', source: 'sec_10k',      confidence: 'high' } },
  { from: 'SAMSUNG', to: 'NVDA', type: 'SUPPLIES_TO',   props: { product_category: 'HBM3e Memory',  market_share_pct: 50, supply_criticality: 'primary', source: 'earnings_call', confidence: 'high' } },

  // ── Competition ───────────────────────────────────────────────────────────
  { from: 'NVDA', to: 'AMD',    type: 'COMPETES_WITH',   props: { market_segment: 'Data Center GPU',       overlap_pct: 85 } },
  { from: 'NVDA', to: 'INTC',   type: 'COMPETES_WITH',   props: { market_segment: 'AI Accelerator',        overlap_pct: 40 } },
  { from: 'NVDA', to: 'AVGO',   type: 'COMPETES_WITH',   props: { market_segment: 'Custom AI ASIC',        overlap_pct: 35 } },
  { from: 'AMAT', to: 'LRCX',   type: 'COMPETES_WITH',   props: { market_segment: 'Semiconductor Equipment', overlap_pct: 60 } },
  { from: 'AMAT', to: 'KLAC',   type: 'COMPETES_WITH',   props: { market_segment: 'Semiconductor Equipment', overlap_pct: 30 } },
  { from: 'TSM',  to: 'SAMSUNG', type: 'COMPETES_WITH',  props: { market_segment: 'Logic Foundry',         overlap_pct: 70 } },
  { from: 'TSM',  to: 'INTC',    type: 'COMPETES_WITH',  props: { market_segment: 'Advanced Logic Foundry', overlap_pct: 45 } },
  { from: 'XOM',  to: 'CVX',    type: 'COMPETES_WITH',   props: { market_segment: 'Integrated Oil',        overlap_pct: 90 } },
  { from: 'HAL',  to: 'SLB',    type: 'COMPETES_WITH',   props: { market_segment: 'Oilfield Services',     overlap_pct: 85 } },

  // ── Energy → Data Centers ─────────────────────────────────────────────────
  { from: 'VST', to: 'MSFT',    type: 'SUPPLIES_TO',     props: { product_category: 'Power (PPA contract)', market_share_pct: 15, source: 'news', confidence: 'high'   } },
  { from: 'CEG', to: 'MSFT',    type: 'SUPPLIES_TO',     props: { product_category: 'Nuclear Power (PPA)',  market_share_pct: 20, source: 'news', confidence: 'high'   } },
  { from: 'CEG', to: 'AMZN',    type: 'SUPPLIES_TO',     props: { product_category: 'Nuclear Power',        market_share_pct: 10, source: 'news', confidence: 'medium' } },

  // ── Oilfield Services → Oil Majors ────────────────────────────────────────
  { from: 'HAL', to: 'XOM',     type: 'SUPPLIES_TO',     props: { product_category: 'Drilling Services', revenue_pct: 12, source: 'sec_10k', confidence: 'high' } },
  { from: 'HAL', to: 'CVX',     type: 'SUPPLIES_TO',     props: { product_category: 'Drilling Services', revenue_pct: 10, source: 'sec_10k', confidence: 'high' } },
  { from: 'SLB', to: 'XOM',     type: 'SUPPLIES_TO',     props: { product_category: 'Oilfield Services', revenue_pct: 8,  source: 'sec_10k', confidence: 'high' } },
  { from: 'SLB', to: 'CVX',     type: 'SUPPLIES_TO',     props: { product_category: 'Oilfield Services', revenue_pct: 7,  source: 'sec_10k', confidence: 'high' } },
];

export async function seedGraph() {
  await setupSchema();

  console.log('[graph-seed] Upserting companies...');
  for (const c of COMPANIES) await upsertCompany(c);
  console.log(`[graph-seed] ${COMPANIES.length} companies done`);

  console.log('[graph-seed] Upserting relationships...');
  let ok = 0, failed = 0;
  for (const r of RELATIONSHIPS) {
    try   { await upsertRelationship(r); ok++; }
    catch (e) { console.warn(`[graph-seed] Skipped ${r.from}→${r.to} (${r.type}): ${e.message}`); failed++; }
  }
  console.log(`[graph-seed] ${ok} relationships seeded, ${failed} skipped`);
  console.log('[graph-seed] Complete ✓');
}

// Run directly: npm run graph:seed
if (process.argv[1].endsWith('graph-seed.js')) {
  seedGraph()
    .then(() => process.exit(0))
    .catch(e => { console.error('[graph-seed] Fatal:', e.message); process.exit(1); });
}
