import { upsertCompany, upsertRelationship, setupSchema } from './graph.js';

const COMPANIES = [
  // ── Semiconductor Equipment ───────────────────────────────────────────────
  { ticker: 'ASML',  name: 'ASML Holding',          sector: 'Semiconductor Equipment', sub_sector: 'Lithography',        exchange: 'NASDAQ', country: 'NL', market_cap_usd: 280_000_000_000 },
  { ticker: 'AMAT',  name: 'Applied Materials',      sector: 'Semiconductor Equipment', sub_sector: 'Deposition',         exchange: 'NASDAQ', country: 'US', market_cap_usd: 140_000_000_000 },
  { ticker: 'LRCX',  name: 'Lam Research',           sector: 'Semiconductor Equipment', sub_sector: 'Etch',               exchange: 'NASDAQ', country: 'US', market_cap_usd: 95_000_000_000  },
  { ticker: 'KLAC',  name: 'KLA Corporation',        sector: 'Semiconductor Equipment', sub_sector: 'Inspection',         exchange: 'NASDAQ', country: 'US', market_cap_usd: 80_000_000_000  },
  // ── Semiconductor Chips ───────────────────────────────────────────────────
  { ticker: 'TSM',   name: 'TSMC',                   sector: 'Semiconductor Foundry',   sub_sector: 'Logic Fab',          exchange: 'NYSE',   country: 'TW', market_cap_usd: 850_000_000_000 },
  { ticker: 'INTC',  name: 'Intel',                  sector: 'Semiconductor',           sub_sector: 'CPU/Foundry',        exchange: 'NASDAQ', country: 'US', market_cap_usd: 90_000_000_000  },
  { ticker: 'NVDA',  name: 'NVIDIA',                 sector: 'Semiconductor',           sub_sector: 'GPU/AI',             exchange: 'NASDAQ', country: 'US', market_cap_usd: 2_800_000_000_000 },
  { ticker: 'AMD',   name: 'Advanced Micro Devices', sector: 'Semiconductor',           sub_sector: 'CPU/GPU',            exchange: 'NASDAQ', country: 'US', market_cap_usd: 180_000_000_000 },
  { ticker: 'QCOM',  name: 'Qualcomm',               sector: 'Semiconductor',           sub_sector: 'Mobile/IoT',         exchange: 'NASDAQ', country: 'US', market_cap_usd: 160_000_000_000 },
  { ticker: 'AVGO',  name: 'Broadcom',               sector: 'Semiconductor',           sub_sector: 'Networking/AI ASIC', exchange: 'NASDAQ', country: 'US', market_cap_usd: 700_000_000_000 },
  { ticker: 'ARM',   name: 'Arm Holdings',           sector: 'Semiconductor',           sub_sector: 'IP Licensing',       exchange: 'NASDAQ', country: 'GB', market_cap_usd: 130_000_000_000 },
  { ticker: 'MU',    name: 'Micron Technology',      sector: 'Semiconductor',           sub_sector: 'Memory/HBM',         exchange: 'NASDAQ', country: 'US', market_cap_usd: 90_000_000_000  },
  { ticker: 'TXN',   name: 'Texas Instruments',      sector: 'Semiconductor',           sub_sector: 'Analog/Embedded',    exchange: 'NASDAQ', country: 'US', market_cap_usd: 160_000_000_000 },
  { ticker: 'MRVL',  name: 'Marvell Technology',     sector: 'Semiconductor',           sub_sector: 'Data Center/AI',     exchange: 'NASDAQ', country: 'US', market_cap_usd: 60_000_000_000  },
  { ticker: 'ON',    name: 'ON Semiconductor',        sector: 'Semiconductor',           sub_sector: 'Power/Automotive',   exchange: 'NASDAQ', country: 'US', market_cap_usd: 25_000_000_000  },
  { ticker: 'ADI',   name: 'Analog Devices',         sector: 'Semiconductor',           sub_sector: 'Analog/Mixed Signal',exchange: 'NASDAQ', country: 'US', market_cap_usd: 90_000_000_000  },
  { ticker: 'NXPI',  name: 'NXP Semiconductors',     sector: 'Semiconductor',           sub_sector: 'Automotive/IoT',     exchange: 'NASDAQ', country: 'NL', market_cap_usd: 55_000_000_000  },
  { ticker: 'SMCI',  name: 'Super Micro Computer',   sector: 'Semiconductor',           sub_sector: 'AI Servers',         exchange: 'NASDAQ', country: 'US', market_cap_usd: 30_000_000_000  },
  // ── Big Tech ─────────────────────────────────────────────────────────────
  { ticker: 'MSFT',  name: 'Microsoft',              sector: 'Cloud',                   sub_sector: 'Azure/AI',           exchange: 'NASDAQ', country: 'US', market_cap_usd: 3_100_000_000_000 },
  { ticker: 'META',  name: 'Meta Platforms',         sector: 'Cloud',                   sub_sector: 'Social/AI Infra',    exchange: 'NASDAQ', country: 'US', market_cap_usd: 1_400_000_000_000 },
  { ticker: 'GOOGL', name: 'Alphabet',               sector: 'Cloud',                   sub_sector: 'GCP/AI',             exchange: 'NASDAQ', country: 'US', market_cap_usd: 2_100_000_000_000 },
  { ticker: 'AMZN',  name: 'Amazon',                 sector: 'Cloud',                   sub_sector: 'AWS/Commerce',       exchange: 'NASDAQ', country: 'US', market_cap_usd: 2_000_000_000_000 },
  { ticker: 'AAPL',  name: 'Apple',                  sector: 'Consumer Tech',           sub_sector: 'iPhone/Mac',         exchange: 'NASDAQ', country: 'US', market_cap_usd: 3_200_000_000_000 },
  { ticker: 'TSLA',  name: 'Tesla',                  sector: 'EV / Auto',               sub_sector: 'EV/Energy/AI',       exchange: 'NASDAQ', country: 'US', market_cap_usd: 900_000_000_000  },
  { ticker: 'NFLX',  name: 'Netflix',                sector: 'Consumer Tech',           sub_sector: 'Streaming',          exchange: 'NASDAQ', country: 'US', market_cap_usd: 350_000_000_000  },
  { ticker: 'ORCL',  name: 'Oracle',                 sector: 'Cloud',                   sub_sector: 'Database/Cloud',     exchange: 'NYSE',   country: 'US', market_cap_usd: 450_000_000_000  },
  { ticker: 'CRM',   name: 'Salesforce',             sector: 'Cloud',                   sub_sector: 'CRM/AI',             exchange: 'NYSE',   country: 'US', market_cap_usd: 280_000_000_000  },
  { ticker: 'ADBE',  name: 'Adobe',                  sector: 'Cloud',                   sub_sector: 'Creative/AI',        exchange: 'NASDAQ', country: 'US', market_cap_usd: 170_000_000_000  },
  { ticker: 'NOW',   name: 'ServiceNow',             sector: 'Cloud',                   sub_sector: 'Workflow/AI',        exchange: 'NYSE',   country: 'US', market_cap_usd: 180_000_000_000  },
  { ticker: 'CSCO',  name: 'Cisco Systems',          sector: 'Networking',              sub_sector: 'Enterprise Network', exchange: 'NASDAQ', country: 'US', market_cap_usd: 240_000_000_000  },
  { ticker: 'IBM',   name: 'IBM',                    sector: 'Cloud',                   sub_sector: 'Enterprise IT/AI',   exchange: 'NYSE',   country: 'US', market_cap_usd: 200_000_000_000  },
  // ── Cloud / Cybersecurity / AI ────────────────────────────────────────────
  { ticker: 'CRWD',  name: 'CrowdStrike',            sector: 'Cybersecurity',           sub_sector: 'Endpoint Security',  exchange: 'NASDAQ', country: 'US', market_cap_usd: 90_000_000_000   },
  { ticker: 'PANW',  name: 'Palo Alto Networks',     sector: 'Cybersecurity',           sub_sector: 'Network Security',   exchange: 'NASDAQ', country: 'US', market_cap_usd: 110_000_000_000  },
  { ticker: 'ZS',    name: 'Zscaler',                sector: 'Cybersecurity',           sub_sector: 'Zero Trust',         exchange: 'NASDAQ', country: 'US', market_cap_usd: 35_000_000_000   },
  { ticker: 'NET',   name: 'Cloudflare',             sector: 'Cybersecurity',           sub_sector: 'Edge/CDN/Security',  exchange: 'NYSE',   country: 'US', market_cap_usd: 45_000_000_000   },
  { ticker: 'DDOG',  name: 'Datadog',                sector: 'Cloud',                   sub_sector: 'Observability',      exchange: 'NASDAQ', country: 'US', market_cap_usd: 40_000_000_000   },
  { ticker: 'SNOW',  name: 'Snowflake',              sector: 'Cloud',                   sub_sector: 'Data Platform',      exchange: 'NYSE',   country: 'US', market_cap_usd: 45_000_000_000   },
  { ticker: 'PLTR',  name: 'Palantir Technologies',  sector: 'AI / Data',               sub_sector: 'Gov/Enterprise AI',  exchange: 'NYSE',   country: 'US', market_cap_usd: 55_000_000_000   },
  { ticker: 'AI',    name: 'C3.ai',                  sector: 'AI / Data',               sub_sector: 'Enterprise AI Apps', exchange: 'NYSE',   country: 'US', market_cap_usd: 4_000_000_000    },
  { ticker: 'PATH',  name: 'UiPath',                 sector: 'AI / Data',               sub_sector: 'RPA/Automation',     exchange: 'NYSE',   country: 'US', market_cap_usd: 9_000_000_000    },
  // ── Finance ───────────────────────────────────────────────────────────────
  { ticker: 'JPM',   name: 'JPMorgan Chase',         sector: 'Finance',                 sub_sector: 'Universal Bank',     exchange: 'NYSE',   country: 'US', market_cap_usd: 700_000_000_000  },
  { ticker: 'BAC',   name: 'Bank of America',        sector: 'Finance',                 sub_sector: 'Universal Bank',     exchange: 'NYSE',   country: 'US', market_cap_usd: 320_000_000_000  },
  { ticker: 'GS',    name: 'Goldman Sachs',          sector: 'Finance',                 sub_sector: 'Investment Bank',    exchange: 'NYSE',   country: 'US', market_cap_usd: 200_000_000_000  },
  { ticker: 'MS',    name: 'Morgan Stanley',         sector: 'Finance',                 sub_sector: 'Investment Bank',    exchange: 'NYSE',   country: 'US', market_cap_usd: 185_000_000_000  },
  { ticker: 'WFC',   name: 'Wells Fargo',            sector: 'Finance',                 sub_sector: 'Retail Bank',        exchange: 'NYSE',   country: 'US', market_cap_usd: 210_000_000_000  },
  { ticker: 'V',     name: 'Visa',                   sector: 'Finance',                 sub_sector: 'Payment Network',    exchange: 'NYSE',   country: 'US', market_cap_usd: 600_000_000_000  },
  { ticker: 'MA',    name: 'Mastercard',             sector: 'Finance',                 sub_sector: 'Payment Network',    exchange: 'NYSE',   country: 'US', market_cap_usd: 480_000_000_000  },
  { ticker: 'PYPL',  name: 'PayPal',                 sector: 'Finance',                 sub_sector: 'Digital Payments',   exchange: 'NASDAQ', country: 'US', market_cap_usd: 70_000_000_000   },
  { ticker: 'SQ',    name: 'Block (Square)',          sector: 'Finance',                 sub_sector: 'Digital Payments',   exchange: 'NYSE',   country: 'US', market_cap_usd: 35_000_000_000   },
  { ticker: 'COIN',  name: 'Coinbase',               sector: 'Finance',                 sub_sector: 'Crypto Exchange',    exchange: 'NASDAQ', country: 'US', market_cap_usd: 50_000_000_000   },
  // ── Healthcare / Pharma ───────────────────────────────────────────────────
  { ticker: 'LLY',   name: 'Eli Lilly',              sector: 'Healthcare',              sub_sector: 'Pharma/GLP-1',       exchange: 'NYSE',   country: 'US', market_cap_usd: 700_000_000_000  },
  { ticker: 'JNJ',   name: 'Johnson & Johnson',      sector: 'Healthcare',              sub_sector: 'Pharma/MedTech',     exchange: 'NYSE',   country: 'US', market_cap_usd: 380_000_000_000  },
  { ticker: 'UNH',   name: 'UnitedHealth Group',     sector: 'Healthcare',              sub_sector: 'Managed Care',       exchange: 'NYSE',   country: 'US', market_cap_usd: 450_000_000_000  },
  { ticker: 'PFE',   name: 'Pfizer',                 sector: 'Healthcare',              sub_sector: 'Pharma',             exchange: 'NYSE',   country: 'US', market_cap_usd: 145_000_000_000  },
  { ticker: 'ABBV',  name: 'AbbVie',                 sector: 'Healthcare',              sub_sector: 'Immunology/Oncology',exchange: 'NYSE',   country: 'US', market_cap_usd: 310_000_000_000  },
  { ticker: 'MRK',   name: 'Merck',                  sector: 'Healthcare',              sub_sector: 'Pharma/Vaccines',    exchange: 'NYSE',   country: 'US', market_cap_usd: 270_000_000_000  },
  { ticker: 'AMGN',  name: 'Amgen',                  sector: 'Healthcare',              sub_sector: 'Biotech/GLP-1',      exchange: 'NASDAQ', country: 'US', market_cap_usd: 140_000_000_000  },
  { ticker: 'GILD',  name: 'Gilead Sciences',        sector: 'Healthcare',              sub_sector: 'Antiviral/Oncology', exchange: 'NASDAQ', country: 'US', market_cap_usd: 100_000_000_000  },
  { ticker: 'REGN',  name: 'Regeneron',              sector: 'Healthcare',              sub_sector: 'Biotech/Immunology', exchange: 'NASDAQ', country: 'US', market_cap_usd: 80_000_000_000   },
  // ── Consumer / Retail ─────────────────────────────────────────────────────
  { ticker: 'COST',  name: 'Costco',                 sector: 'Consumer',                sub_sector: 'Warehouse Retail',   exchange: 'NASDAQ', country: 'US', market_cap_usd: 380_000_000_000  },
  { ticker: 'WMT',   name: 'Walmart',                sector: 'Consumer',                sub_sector: 'Mass Retail',        exchange: 'NYSE',   country: 'US', market_cap_usd: 700_000_000_000  },
  { ticker: 'HD',    name: 'Home Depot',             sector: 'Consumer',                sub_sector: 'Home Improvement',   exchange: 'NYSE',   country: 'US', market_cap_usd: 360_000_000_000  },
  { ticker: 'TGT',   name: 'Target',                 sector: 'Consumer',                sub_sector: 'Mass Retail',        exchange: 'NYSE',   country: 'US', market_cap_usd: 55_000_000_000   },
  { ticker: 'NKE',   name: 'Nike',                   sector: 'Consumer',                sub_sector: 'Apparel/Footwear',   exchange: 'NYSE',   country: 'US', market_cap_usd: 115_000_000_000  },
  { ticker: 'DIS',   name: 'Walt Disney',            sector: 'Consumer Tech',           sub_sector: 'Streaming/Parks',    exchange: 'NYSE',   country: 'US', market_cap_usd: 200_000_000_000  },
  { ticker: 'SBUX',  name: 'Starbucks',              sector: 'Consumer',                sub_sector: 'QSR/Beverage',       exchange: 'NASDAQ', country: 'US', market_cap_usd: 90_000_000_000   },
  { ticker: 'MCD',   name: "McDonald's",             sector: 'Consumer',                sub_sector: 'QSR',                exchange: 'NYSE',   country: 'US', market_cap_usd: 210_000_000_000  },
  // ── EV / Auto ─────────────────────────────────────────────────────────────
  { ticker: 'RIVN',  name: 'Rivian',                 sector: 'EV / Auto',               sub_sector: 'Electric Trucks',    exchange: 'NASDAQ', country: 'US', market_cap_usd: 14_000_000_000   },
  { ticker: 'F',     name: 'Ford Motor',             sector: 'EV / Auto',               sub_sector: 'Auto OEM',           exchange: 'NYSE',   country: 'US', market_cap_usd: 45_000_000_000   },
  { ticker: 'GM',    name: 'General Motors',         sector: 'EV / Auto',               sub_sector: 'Auto OEM',           exchange: 'NYSE',   country: 'US', market_cap_usd: 50_000_000_000   },
  // ── Energy ────────────────────────────────────────────────────────────────
  { ticker: 'XOM',   name: 'ExxonMobil',             sector: 'Energy',                  sub_sector: 'Integrated Oil',     exchange: 'NYSE',   country: 'US', market_cap_usd: 480_000_000_000 },
  { ticker: 'CVX',   name: 'Chevron',                sector: 'Energy',                  sub_sector: 'Integrated Oil',     exchange: 'NYSE',   country: 'US', market_cap_usd: 260_000_000_000 },
  { ticker: 'HAL',   name: 'Halliburton',            sector: 'Energy',                  sub_sector: 'Oilfield Services',  exchange: 'NYSE',   country: 'US', market_cap_usd: 27_000_000_000  },
  { ticker: 'SLB',   name: 'SLB (Schlumberger)',     sector: 'Energy',                  sub_sector: 'Oilfield Services',  exchange: 'NYSE',   country: 'US', market_cap_usd: 52_000_000_000  },
  { ticker: 'OXY',   name: 'Occidental Petroleum',  sector: 'Energy',                  sub_sector: 'E&P Oil',            exchange: 'NYSE',   country: 'US', market_cap_usd: 45_000_000_000  },
  { ticker: 'BP',    name: 'BP',                     sector: 'Energy',                  sub_sector: 'Integrated Oil',     exchange: 'NYSE',   country: 'GB', market_cap_usd: 90_000_000_000  },
  // ── Utilities ─────────────────────────────────────────────────────────────
  { ticker: 'VST',   name: 'Vistra Energy',          sector: 'Utilities',               sub_sector: 'Power Generation',   exchange: 'NYSE',   country: 'US', market_cap_usd: 35_000_000_000  },
  { ticker: 'CEG',   name: 'Constellation Energy',   sector: 'Utilities',               sub_sector: 'Nuclear Power',      exchange: 'NASDAQ', country: 'US', market_cap_usd: 65_000_000_000  },
  { ticker: 'ETR',   name: 'Entergy',                sector: 'Utilities',               sub_sector: 'Power Grid',         exchange: 'NYSE',   country: 'US', market_cap_usd: 22_000_000_000  },
  // ── Telecom / Media ───────────────────────────────────────────────────────
  { ticker: 'T',     name: 'AT&T',                   sector: 'Telecom',                 sub_sector: 'Wireless/Fiber',     exchange: 'NYSE',   country: 'US', market_cap_usd: 140_000_000_000  },
  { ticker: 'VZ',    name: 'Verizon',                sector: 'Telecom',                 sub_sector: 'Wireless/Fiber',     exchange: 'NYSE',   country: 'US', market_cap_usd: 165_000_000_000  },
  { ticker: 'SPOT',  name: 'Spotify',                sector: 'Consumer Tech',           sub_sector: 'Audio Streaming',    exchange: 'NYSE',   country: 'SE', market_cap_usd: 80_000_000_000   },
  { ticker: 'UBER',  name: 'Uber Technologies',      sector: 'Consumer Tech',           sub_sector: 'Rideshare/Delivery', exchange: 'NYSE',   country: 'US', market_cap_usd: 160_000_000_000  },
  { ticker: 'ABNB',  name: 'Airbnb',                 sector: 'Consumer Tech',           sub_sector: 'Travel/Marketplace', exchange: 'NASDAQ', country: 'US', market_cap_usd: 80_000_000_000   },
];

const RELATIONSHIPS = [
  // ── Semiconductor Equipment → Fabs ───────────────────────────────────────
  { from: 'ASML',  to: 'TSM',    type: 'SUPPLIES_TO',      props: { product_category: 'EUV Lithography',      market_share_pct: 90, supply_criticality: 'sole',    source: 'annual_report', confidence: 'high'   } },
  { from: 'ASML',  to: 'INTC',   type: 'SUPPLIES_TO',      props: { product_category: 'EUV Lithography',      market_share_pct: 90, supply_criticality: 'primary', source: 'annual_report', confidence: 'high'   } },
  { from: 'AMAT',  to: 'TSM',    type: 'SUPPLIES_TO',      props: { product_category: 'CVD/PVD Equipment',    market_share_pct: 22, supply_criticality: 'primary', source: 'sec_10k',       confidence: 'high'   } },
  { from: 'AMAT',  to: 'INTC',   type: 'SUPPLIES_TO',      props: { product_category: 'CVD/PVD Equipment',    market_share_pct: 18, supply_criticality: 'primary', source: 'sec_10k',       confidence: 'high'   } },
  { from: 'LRCX',  to: 'TSM',    type: 'SUPPLIES_TO',      props: { product_category: 'Etch Equipment',       market_share_pct: 18, supply_criticality: 'primary', source: 'sec_10k',       confidence: 'high'   } },
  { from: 'KLAC',  to: 'TSM',    type: 'SUPPLIES_TO',      props: { product_category: 'Inspection/Metrology', market_share_pct: 50, supply_criticality: 'primary', source: 'sec_10k',       confidence: 'high'   } },
  { from: 'AMAT',  to: 'LRCX',   type: 'COMPETES_WITH',    props: { market_segment: 'Semiconductor Equipment', overlap_pct: 60 } },
  { from: 'AMAT',  to: 'KLAC',   type: 'COMPETES_WITH',    props: { market_segment: 'Semiconductor Equipment', overlap_pct: 30 } },
  // ── TSM manufactures for ──────────────────────────────────────────────────
  { from: 'TSM',   to: 'NVDA',   type: 'MANUFACTURES_FOR', props: { revenue_pct: 23, product: 'AI GPUs H100/B200', wafer_capacity_pct: 20, source: 'sec_10k', confidence: 'high' } },
  { from: 'TSM',   to: 'AMD',    type: 'MANUFACTURES_FOR', props: { revenue_pct: 8,  product: 'CPU/GPU',            wafer_capacity_pct: 8,  source: 'sec_10k', confidence: 'high' } },
  { from: 'TSM',   to: 'AAPL',   type: 'MANUFACTURES_FOR', props: { revenue_pct: 25, product: 'A/M-series chips',   wafer_capacity_pct: 22, source: 'sec_10k', confidence: 'high' } },
  { from: 'TSM',   to: 'QCOM',   type: 'MANUFACTURES_FOR', props: { revenue_pct: 7,  product: 'Snapdragon SoCs',    wafer_capacity_pct: 6,  source: 'sec_10k', confidence: 'high' } },
  { from: 'TSM',   to: 'AVGO',   type: 'MANUFACTURES_FOR', props: { revenue_pct: 5,  product: 'Networking/AI ASIC', wafer_capacity_pct: 4,  source: 'sec_10k', confidence: 'high' } },
  { from: 'TSM',   to: 'MRVL',   type: 'MANUFACTURES_FOR', props: { revenue_pct: 3,  product: 'Custom AI Chips',    wafer_capacity_pct: 3,  source: 'sec_10k', confidence: 'medium' } },
  { from: 'TSM',   to: 'INTC',   type: 'COMPETES_WITH',    props: { market_segment: 'Advanced Logic Foundry',  overlap_pct: 45 } },
  // ── ARM licensing ─────────────────────────────────────────────────────────
  { from: 'ARM',   to: 'AAPL',   type: 'LICENSES_TO',      props: { license_type: 'architecture', royalty_model: 'per_chip', source: 'annual_report', confidence: 'high' } },
  { from: 'ARM',   to: 'QCOM',   type: 'LICENSES_TO',      props: { license_type: 'architecture', royalty_model: 'per_chip', source: 'annual_report', confidence: 'high' } },
  { from: 'ARM',   to: 'NVDA',   type: 'LICENSES_TO',      props: { license_type: 'architecture', royalty_model: 'per_chip', source: 'annual_report', confidence: 'high' } },
  { from: 'ARM',   to: 'AMZN',   type: 'LICENSES_TO',      props: { license_type: 'architecture', royalty_model: 'per_chip', source: 'annual_report', confidence: 'high' } },
  { from: 'ARM',   to: 'GOOGL',  type: 'LICENSES_TO',      props: { license_type: 'architecture', royalty_model: 'per_chip', source: 'annual_report', confidence: 'high' } },
  { from: 'ARM',   to: 'MSFT',   type: 'LICENSES_TO',      props: { license_type: 'architecture', royalty_model: 'per_chip', source: 'annual_report', confidence: 'high' } },
  // ── NVDA supply chain + customers ────────────────────────────────────────
  { from: 'NVDA',  to: 'MSFT',   type: 'CUSTOMER_OF',      props: { revenue_pct: 15, product: 'H100/B200 for Azure AI', source: 'earnings_call', confidence: 'high' } },
  { from: 'NVDA',  to: 'META',   type: 'CUSTOMER_OF',      props: { revenue_pct: 12, product: 'H100 clusters for LLMs', source: 'earnings_call', confidence: 'high' } },
  { from: 'NVDA',  to: 'GOOGL',  type: 'CUSTOMER_OF',      props: { revenue_pct: 10, product: 'H100 for GCP/Gemini',    source: 'earnings_call', confidence: 'high' } },
  { from: 'NVDA',  to: 'AMZN',   type: 'CUSTOMER_OF',      props: { revenue_pct: 10, product: 'H100 for AWS',           source: 'earnings_call', confidence: 'high' } },
  { from: 'NVDA',  to: 'AMD',    type: 'COMPETES_WITH',    props: { market_segment: 'Data Center GPU',     overlap_pct: 85 } },
  { from: 'NVDA',  to: 'INTC',   type: 'COMPETES_WITH',    props: { market_segment: 'AI Accelerator',      overlap_pct: 40 } },
  { from: 'NVDA',  to: 'AVGO',   type: 'COMPETES_WITH',    props: { market_segment: 'Custom AI ASIC',      overlap_pct: 35 } },
  // ── Memory suppliers ──────────────────────────────────────────────────────
  { from: 'MU',    to: 'NVDA',   type: 'SUPPLIES_TO',      props: { product_category: 'HBM3e Memory', market_share_pct: 25, source: 'earnings_call', confidence: 'high' } },
  { from: 'MU',    to: 'AMZN',   type: 'SUPPLIES_TO',      props: { product_category: 'DRAM/NAND',    market_share_pct: 22, source: 'sec_10k',       confidence: 'high' } },
  { from: 'MU',    to: 'MSFT',   type: 'SUPPLIES_TO',      props: { product_category: 'DRAM/NAND',    market_share_pct: 15, source: 'sec_10k',       confidence: 'medium' } },
  // ── SMCI (AI servers) ─────────────────────────────────────────────────────
  { from: 'SMCI',  to: 'NVDA',   type: 'CUSTOMER_OF',      props: { revenue_pct: 60, product: 'H100/B200 GPU servers', source: 'sec_10k', confidence: 'high' } },
  { from: 'SMCI',  to: 'MSFT',   type: 'SUPPLIES_TO',      props: { product_category: 'AI Servers', market_share_pct: 10, source: 'news', confidence: 'medium' } },
  { from: 'SMCI',  to: 'GOOGL',  type: 'SUPPLIES_TO',      props: { product_category: 'AI Servers', market_share_pct: 8,  source: 'news', confidence: 'medium' } },
  { from: 'SMCI',  to: 'AMZN',   type: 'SUPPLIES_TO',      props: { product_category: 'AI Servers', market_share_pct: 8,  source: 'news', confidence: 'medium' } },
  // ── MRVL custom AI chips ──────────────────────────────────────────────────
  { from: 'MRVL',  to: 'AMZN',   type: 'SUPPLIES_TO',      props: { product_category: 'Custom AI ASIC (Trainium)', market_share_pct: 50, source: 'earnings_call', confidence: 'high' } },
  { from: 'MRVL',  to: 'GOOGL',  type: 'SUPPLIES_TO',      props: { product_category: 'Networking/AI Chips',       market_share_pct: 20, source: 'earnings_call', confidence: 'high' } },
  { from: 'MRVL',  to: 'AVGO',   type: 'COMPETES_WITH',    props: { market_segment: 'Custom AI ASIC/Networking', overlap_pct: 55 } },
  { from: 'MRVL',  to: 'NVDA',   type: 'COMPETES_WITH',    props: { market_segment: 'AI Data Center Chips',      overlap_pct: 30 } },
  // ── Automotive semis ──────────────────────────────────────────────────────
  { from: 'NXPI',  to: 'F',      type: 'SUPPLIES_TO',      props: { product_category: 'Automotive MCU/ADAS', market_share_pct: 30, source: 'sec_10k', confidence: 'high' } },
  { from: 'NXPI',  to: 'GM',     type: 'SUPPLIES_TO',      props: { product_category: 'Automotive MCU/ADAS', market_share_pct: 28, source: 'sec_10k', confidence: 'high' } },
  { from: 'NXPI',  to: 'TSLA',   type: 'SUPPLIES_TO',      props: { product_category: 'Automotive Semis',    market_share_pct: 15, source: 'news',    confidence: 'medium' } },
  { from: 'ON',    to: 'TSLA',   type: 'SUPPLIES_TO',      props: { product_category: 'SiC Power Modules',   market_share_pct: 40, source: 'earnings_call', confidence: 'high' } },
  { from: 'ON',    to: 'F',      type: 'SUPPLIES_TO',      props: { product_category: 'Power Semis',         market_share_pct: 20, source: 'sec_10k', confidence: 'high' } },
  { from: 'ON',    to: 'GM',     type: 'SUPPLIES_TO',      props: { product_category: 'Power Semis',         market_share_pct: 18, source: 'sec_10k', confidence: 'high' } },
  { from: 'TXN',   to: 'F',      type: 'SUPPLIES_TO',      props: { product_category: 'Analog/Embedded',     market_share_pct: 12, source: 'sec_10k', confidence: 'high' } },
  { from: 'TXN',   to: 'GM',     type: 'SUPPLIES_TO',      props: { product_category: 'Analog/Embedded',     market_share_pct: 10, source: 'sec_10k', confidence: 'high' } },
  { from: 'ADI',   to: 'F',      type: 'SUPPLIES_TO',      props: { product_category: 'Battery Management/ADAS', market_share_pct: 15, source: 'sec_10k', confidence: 'high' } },
  { from: 'ADI',   to: 'GM',     type: 'SUPPLIES_TO',      props: { product_category: 'Battery Management/ADAS', market_share_pct: 12, source: 'sec_10k', confidence: 'high' } },
  { from: 'TXN',   to: 'ADI',    type: 'COMPETES_WITH',    props: { market_segment: 'Analog Chips', overlap_pct: 65 } },
  { from: 'NXPI',  to: 'ADI',    type: 'COMPETES_WITH',    props: { market_segment: 'Automotive/IoT Semis', overlap_pct: 55 } },
  { from: 'NXPI',  to: 'TXN',    type: 'COMPETES_WITH',    props: { market_segment: 'Automotive/Embedded', overlap_pct: 50 } },
  { from: 'ON',    to: 'NXPI',   type: 'COMPETES_WITH',    props: { market_segment: 'Automotive Power Semis', overlap_pct: 60 } },
  // ── EV / Auto competition ─────────────────────────────────────────────────
  { from: 'TSLA',  to: 'RIVN',   type: 'COMPETES_WITH',    props: { market_segment: 'Electric Vehicles', overlap_pct: 70 } },
  { from: 'TSLA',  to: 'F',      type: 'COMPETES_WITH',    props: { market_segment: 'EV/Auto',           overlap_pct: 55 } },
  { from: 'TSLA',  to: 'GM',     type: 'COMPETES_WITH',    props: { market_segment: 'EV/Auto',           overlap_pct: 55 } },
  { from: 'F',     to: 'GM',     type: 'COMPETES_WITH',    props: { market_segment: 'Auto OEM',          overlap_pct: 80 } },
  { from: 'RIVN',  to: 'F',      type: 'COMPETES_WITH',    props: { market_segment: 'Electric Trucks',   overlap_pct: 65 } },
  { from: 'RIVN',  to: 'GM',     type: 'COMPETES_WITH',    props: { market_segment: 'Electric Trucks',   overlap_pct: 60 } },
  // ── Big Tech cloud competition ────────────────────────────────────────────
  { from: 'MSFT',  to: 'GOOGL',  type: 'COMPETES_WITH',    props: { market_segment: 'Cloud/AI', overlap_pct: 75 } },
  { from: 'MSFT',  to: 'AMZN',   type: 'COMPETES_WITH',    props: { market_segment: 'Cloud',    overlap_pct: 70 } },
  { from: 'GOOGL', to: 'AMZN',   type: 'COMPETES_WITH',    props: { market_segment: 'Cloud',    overlap_pct: 65 } },
  { from: 'MSFT',  to: 'ORCL',   type: 'COMPETES_WITH',    props: { market_segment: 'Enterprise Cloud/Database', overlap_pct: 55 } },
  { from: 'MSFT',  to: 'CRM',    type: 'COMPETES_WITH',    props: { market_segment: 'CRM/Enterprise SaaS',       overlap_pct: 50 } },
  { from: 'MSFT',  to: 'NOW',    type: 'COMPETES_WITH',    props: { market_segment: 'Enterprise Workflow/AI',    overlap_pct: 45 } },
  { from: 'CRM',   to: 'NOW',    type: 'COMPETES_WITH',    props: { market_segment: 'Enterprise SaaS',           overlap_pct: 50 } },
  { from: 'ORCL',  to: 'IBM',    type: 'COMPETES_WITH',    props: { market_segment: 'Enterprise IT/Database',    overlap_pct: 50 } },
  // ── Cisco supplies networking + competes in security ─────────────────────
  { from: 'CSCO',  to: 'MSFT',   type: 'SUPPLIES_TO',      props: { product_category: 'Network Equipment',       market_share_pct: 15, source: 'sec_10k', confidence: 'medium' } },
  { from: 'CSCO',  to: 'AMZN',   type: 'SUPPLIES_TO',      props: { product_category: 'Data Center Networking',  market_share_pct: 12, source: 'sec_10k', confidence: 'medium' } },
  { from: 'CSCO',  to: 'GOOGL',  type: 'SUPPLIES_TO',      props: { product_category: 'Network Equipment',       market_share_pct: 10, source: 'sec_10k', confidence: 'medium' } },
  { from: 'CSCO',  to: 'JPM',    type: 'SUPPLIES_TO',      props: { product_category: 'Enterprise Networking',   market_share_pct: 10, source: 'news',    confidence: 'medium' } },
  { from: 'CSCO',  to: 'PANW',   type: 'COMPETES_WITH',    props: { market_segment: 'Network Security/Firewall', overlap_pct: 65 } },
  { from: 'CSCO',  to: 'NET',    type: 'COMPETES_WITH',    props: { market_segment: 'Edge Networking/Security',  overlap_pct: 55 } },
  { from: 'CSCO',  to: 'CRWD',   type: 'COMPETES_WITH',    props: { market_segment: 'Cybersecurity Platform',   overlap_pct: 45 } },
  { from: 'CSCO',  to: 'DDOG',   type: 'COMPETES_WITH',    props: { market_segment: 'Observability (via Splunk)', overlap_pct: 50 } },
  // ── IBM / ORCL supply enterprises ────────────────────────────────────────
  { from: 'IBM',   to: 'JPM',    type: 'SUPPLIES_TO',      props: { product_category: 'Cloud/IT Services', market_share_pct: 10, source: 'news', confidence: 'medium' } },
  { from: 'IBM',   to: 'BAC',    type: 'SUPPLIES_TO',      props: { product_category: 'Cloud/IT Services', market_share_pct: 8,  source: 'news', confidence: 'medium' } },
  { from: 'ORCL',  to: 'JPM',    type: 'SUPPLIES_TO',      props: { product_category: 'Database/Cloud',    market_share_pct: 12, source: 'news', confidence: 'medium' } },
  { from: 'ORCL',  to: 'UNH',    type: 'SUPPLIES_TO',      props: { product_category: 'Healthcare Cloud',  market_share_pct: 10, source: 'news', confidence: 'medium' } },
  // ── Streaming competition ─────────────────────────────────────────────────
  { from: 'NFLX',  to: 'DIS',    type: 'COMPETES_WITH',    props: { market_segment: 'Video Streaming',    overlap_pct: 75 } },
  { from: 'NFLX',  to: 'AMZN',   type: 'COMPETES_WITH',    props: { market_segment: 'Video Streaming',    overlap_pct: 65 } },
  { from: 'NFLX',  to: 'AAPL',   type: 'COMPETES_WITH',    props: { market_segment: 'Video Streaming',    overlap_pct: 40 } },
  { from: 'SPOT',  to: 'AAPL',   type: 'COMPETES_WITH',    props: { market_segment: 'Music Streaming',    overlap_pct: 80 } },
  { from: 'SPOT',  to: 'AMZN',   type: 'COMPETES_WITH',    props: { market_segment: 'Audio Streaming',    overlap_pct: 50 } },
  // ── Cybersecurity competition ─────────────────────────────────────────────
  { from: 'CRWD',  to: 'PANW',   type: 'COMPETES_WITH',    props: { market_segment: 'Cybersecurity Platform', overlap_pct: 70 } },
  { from: 'CRWD',  to: 'ZS',     type: 'COMPETES_WITH',    props: { market_segment: 'Zero Trust/Endpoint',    overlap_pct: 60 } },
  { from: 'PANW',  to: 'ZS',     type: 'COMPETES_WITH',    props: { market_segment: 'Network Security',       overlap_pct: 65 } },
  { from: 'PANW',  to: 'NET',    type: 'COMPETES_WITH',    props: { market_segment: 'Edge Security',          overlap_pct: 55 } },
  { from: 'ZS',    to: 'NET',    type: 'COMPETES_WITH',    props: { market_segment: 'Zero Trust/Edge',        overlap_pct: 60 } },
  // ── Cybersecurity customers ───────────────────────────────────────────────
  { from: 'CRWD',  to: 'JPM',    type: 'SUPPLIES_TO',      props: { product_category: 'Endpoint Security', market_share_pct: 8, source: 'news', confidence: 'medium' } },
  { from: 'PANW',  to: 'JPM',    type: 'SUPPLIES_TO',      props: { product_category: 'Network Security',  market_share_pct: 8, source: 'news', confidence: 'medium' } },
  // ── AI/Data platforms ─────────────────────────────────────────────────────
  { from: 'PLTR',  to: 'AI',     type: 'COMPETES_WITH',    props: { market_segment: 'Enterprise AI Platforms',   overlap_pct: 60 } },
  { from: 'PLTR',  to: 'PATH',   type: 'COMPETES_WITH',    props: { market_segment: 'Enterprise AI/Automation',  overlap_pct: 50 } },
  { from: 'AI',    to: 'PATH',   type: 'COMPETES_WITH',    props: { market_segment: 'Enterprise AI Apps',         overlap_pct: 55 } },
  { from: 'DDOG',  to: 'SNOW',   type: 'COMPETES_WITH',    props: { market_segment: 'Cloud Observability/Analytics', overlap_pct: 45 } },
  { from: 'SNOW',  to: 'MSFT',   type: 'COMPETES_WITH',    props: { market_segment: 'Cloud Data/Analytics (Fabric vs Snowflake)', overlap_pct: 55 } },
  { from: 'SNOW',  to: 'GOOGL',  type: 'COMPETES_WITH',    props: { market_segment: 'Cloud Data Warehouse (BigQuery)', overlap_pct: 50 } },
  { from: 'SNOW',  to: 'AMZN',   type: 'COMPETES_WITH',    props: { market_segment: 'Cloud Analytics (Redshift)',     overlap_pct: 50 } },
  // ── Finance competition ───────────────────────────────────────────────────
  { from: 'JPM',   to: 'BAC',    type: 'COMPETES_WITH',    props: { market_segment: 'Universal Banking', overlap_pct: 85 } },
  { from: 'JPM',   to: 'WFC',    type: 'COMPETES_WITH',    props: { market_segment: 'Retail/Commercial Bank', overlap_pct: 75 } },
  { from: 'JPM',   to: 'GS',     type: 'COMPETES_WITH',    props: { market_segment: 'Investment Banking', overlap_pct: 70 } },
  { from: 'JPM',   to: 'MS',     type: 'COMPETES_WITH',    props: { market_segment: 'Investment Banking/Wealth', overlap_pct: 65 } },
  { from: 'GS',    to: 'MS',     type: 'COMPETES_WITH',    props: { market_segment: 'Investment Bank/Wealth', overlap_pct: 80 } },
  { from: 'BAC',   to: 'WFC',    type: 'COMPETES_WITH',    props: { market_segment: 'Retail Banking', overlap_pct: 80 } },
  { from: 'V',     to: 'MA',     type: 'COMPETES_WITH',    props: { market_segment: 'Payment Networks', overlap_pct: 90 } },
  { from: 'PYPL',  to: 'SQ',     type: 'COMPETES_WITH',    props: { market_segment: 'Digital Payments', overlap_pct: 75 } },
  { from: 'PYPL',  to: 'V',      type: 'COMPETES_WITH',    props: { market_segment: 'Digital Payments', overlap_pct: 50 } },
  { from: 'PYPL',  to: 'MA',     type: 'COMPETES_WITH',    props: { market_segment: 'Digital Payments', overlap_pct: 50 } },
  { from: 'V',     to: 'JPM',    type: 'SUPPLIES_TO',      props: { product_category: 'Payment Network', market_share_pct: 30, source: 'annual_report', confidence: 'high' } },
  { from: 'MA',    to: 'JPM',    type: 'SUPPLIES_TO',      props: { product_category: 'Payment Network', market_share_pct: 25, source: 'annual_report', confidence: 'high' } },
  { from: 'V',     to: 'BAC',    type: 'SUPPLIES_TO',      props: { product_category: 'Payment Network', market_share_pct: 25, source: 'annual_report', confidence: 'high' } },
  { from: 'MA',    to: 'BAC',    type: 'SUPPLIES_TO',      props: { product_category: 'Payment Network', market_share_pct: 20, source: 'annual_report', confidence: 'high' } },
  // ── Healthcare competition ────────────────────────────────────────────────
  { from: 'LLY',   to: 'AMGN',   type: 'COMPETES_WITH',    props: { market_segment: 'GLP-1 / Obesity Drugs', overlap_pct: 75 } },
  { from: 'LLY',   to: 'MRK',    type: 'COMPETES_WITH',    props: { market_segment: 'Oncology/Pharma',        overlap_pct: 55 } },
  { from: 'LLY',   to: 'PFE',    type: 'COMPETES_WITH',    props: { market_segment: 'Pharma',                 overlap_pct: 50 } },
  { from: 'LLY',   to: 'ABBV',   type: 'COMPETES_WITH',    props: { market_segment: 'Immunology/Oncology',    overlap_pct: 45 } },
  { from: 'PFE',   to: 'MRK',    type: 'COMPETES_WITH',    props: { market_segment: 'Pharma/Vaccines',        overlap_pct: 70 } },
  { from: 'PFE',   to: 'JNJ',    type: 'COMPETES_WITH',    props: { market_segment: 'Pharma/MedTech',         overlap_pct: 60 } },
  { from: 'ABBV',  to: 'AMGN',   type: 'COMPETES_WITH',    props: { market_segment: 'Immunology/Biologics',   overlap_pct: 70 } },
  { from: 'ABBV',  to: 'GILD',   type: 'COMPETES_WITH',    props: { market_segment: 'Oncology/Immunology',    overlap_pct: 55 } },
  { from: 'ABBV',  to: 'REGN',   type: 'COMPETES_WITH',    props: { market_segment: 'Immunology/Biologics',   overlap_pct: 60 } },
  { from: 'AMGN',  to: 'GILD',   type: 'COMPETES_WITH',    props: { market_segment: 'Biotech/Oncology',       overlap_pct: 50 } },
  { from: 'AMGN',  to: 'REGN',   type: 'COMPETES_WITH',    props: { market_segment: 'Biotech/Immunology',     overlap_pct: 60 } },
  { from: 'GILD',  to: 'REGN',   type: 'COMPETES_WITH',    props: { market_segment: 'Biotech/Antiviral',      overlap_pct: 45 } },
  // ── Consumer / Retail competition ─────────────────────────────────────────
  { from: 'WMT',   to: 'COST',   type: 'COMPETES_WITH',    props: { market_segment: 'Mass Retail',          overlap_pct: 80 } },
  { from: 'WMT',   to: 'TGT',    type: 'COMPETES_WITH',    props: { market_segment: 'Mass Retail',          overlap_pct: 85 } },
  { from: 'WMT',   to: 'AMZN',   type: 'COMPETES_WITH',    props: { market_segment: 'Retail/eCommerce',     overlap_pct: 70 } },
  { from: 'COST',  to: 'TGT',    type: 'COMPETES_WITH',    props: { market_segment: 'Retail',               overlap_pct: 65 } },
  { from: 'AMZN',  to: 'TGT',    type: 'COMPETES_WITH',    props: { market_segment: 'eCommerce/Retail',     overlap_pct: 60 } },
  { from: 'HD',    to: 'WMT',    type: 'COMPETES_WITH',    props: { market_segment: 'Home/Garden Retail',   overlap_pct: 45 } },
  { from: 'HD',    to: 'TGT',    type: 'COMPETES_WITH',    props: { market_segment: 'Home Improvement',     overlap_pct: 50 } },
  { from: 'HD',    to: 'AMZN',   type: 'COMPETES_WITH',    props: { market_segment: 'Home Goods eCommerce', overlap_pct: 55 } },
  { from: 'MCD',   to: 'SBUX',   type: 'COMPETES_WITH',    props: { market_segment: 'QSR / Beverage',       overlap_pct: 50 } },
  // ── Adobe competes in creative/enterprise software ────────────────────────
  { from: 'ADBE',  to: 'MSFT',   type: 'COMPETES_WITH',    props: { market_segment: 'AI Creative/Productivity (Copilot vs Firefly)', overlap_pct: 45 } },
  { from: 'ADBE',  to: 'CRM',    type: 'COMPETES_WITH',    props: { market_segment: 'Marketing Cloud/CDP',  overlap_pct: 55 } },
  { from: 'ADBE',  to: 'NOW',    type: 'COMPETES_WITH',    props: { market_segment: 'Enterprise Workflow',  overlap_pct: 35 } },
  // ── Coinbase / SQ crypto overlap ──────────────────────────────────────────
  { from: 'COIN',  to: 'SQ',     type: 'COMPETES_WITH',    props: { market_segment: 'Crypto/Digital Payments', overlap_pct: 60 } },
  { from: 'COIN',  to: 'PYPL',   type: 'COMPETES_WITH',    props: { market_segment: 'Digital Payments/Crypto',  overlap_pct: 45 } },
  // ── Utilities competition ─────────────────────────────────────────────────
  { from: 'VST',   to: 'CEG',    type: 'COMPETES_WITH',    props: { market_segment: 'Power Generation',     overlap_pct: 65 } },
  { from: 'VST',   to: 'ETR',    type: 'COMPETES_WITH',    props: { market_segment: 'Power Generation',     overlap_pct: 55 } },
  { from: 'CEG',   to: 'ETR',    type: 'COMPETES_WITH',    props: { market_segment: 'Regulated Power',      overlap_pct: 50 } },
  // ── JNJ extended competition ──────────────────────────────────────────────
  { from: 'JNJ',   to: 'ABBV',   type: 'COMPETES_WITH',    props: { market_segment: 'Immunology/Oncology',  overlap_pct: 55 } },
  { from: 'JNJ',   to: 'MRK',    type: 'COMPETES_WITH',    props: { market_segment: 'Pharma/Oncology',      overlap_pct: 60 } },
  // ── UNH / healthcare services ─────────────────────────────────────────────
  { from: 'UNH',   to: 'LLY',    type: 'CUSTOMER_OF',      props: { revenue_pct: 5, product: 'GLP-1 drug reimbursement', source: 'news', confidence: 'medium' } },
  { from: 'UNH',   to: 'PFE',    type: 'CUSTOMER_OF',      props: { revenue_pct: 4, product: 'Drug formulary coverage',  source: 'news', confidence: 'medium' } },
  // ── Nike — apparel/footwear ───────────────────────────────────────────────
  { from: 'NKE',   to: 'AMZN',   type: 'CUSTOMER_OF',      props: { revenue_pct: 8, product: 'eCommerce marketplace sales', source: 'sec_10k', confidence: 'medium' } },
  { from: 'NKE',   to: 'AAPL',   type: 'COMPETES_WITH',    props: { market_segment: 'Wearables/Health Tech (Nike vs Apple Watch)', overlap_pct: 30 } },
  // ── Energy competition + services ────────────────────────────────────────
  { from: 'XOM',   to: 'CVX',    type: 'COMPETES_WITH',    props: { market_segment: 'Integrated Oil', overlap_pct: 90 } },
  { from: 'XOM',   to: 'BP',     type: 'COMPETES_WITH',    props: { market_segment: 'Integrated Oil', overlap_pct: 85 } },
  { from: 'XOM',   to: 'OXY',    type: 'COMPETES_WITH',    props: { market_segment: 'E&P Oil',        overlap_pct: 60 } },
  { from: 'CVX',   to: 'BP',     type: 'COMPETES_WITH',    props: { market_segment: 'Integrated Oil', overlap_pct: 80 } },
  { from: 'CVX',   to: 'OXY',    type: 'COMPETES_WITH',    props: { market_segment: 'E&P Oil',        overlap_pct: 65 } },
  { from: 'HAL',   to: 'SLB',    type: 'COMPETES_WITH',    props: { market_segment: 'Oilfield Services', overlap_pct: 85 } },
  { from: 'HAL',   to: 'XOM',    type: 'SUPPLIES_TO',      props: { product_category: 'Drilling Services', revenue_pct: 12, source: 'sec_10k', confidence: 'high' } },
  { from: 'HAL',   to: 'CVX',    type: 'SUPPLIES_TO',      props: { product_category: 'Drilling Services', revenue_pct: 10, source: 'sec_10k', confidence: 'high' } },
  { from: 'HAL',   to: 'OXY',    type: 'SUPPLIES_TO',      props: { product_category: 'Oilfield Services', revenue_pct: 8,  source: 'sec_10k', confidence: 'high' } },
  { from: 'SLB',   to: 'XOM',    type: 'SUPPLIES_TO',      props: { product_category: 'Oilfield Services', revenue_pct: 8,  source: 'sec_10k', confidence: 'high' } },
  { from: 'SLB',   to: 'CVX',    type: 'SUPPLIES_TO',      props: { product_category: 'Oilfield Services', revenue_pct: 7,  source: 'sec_10k', confidence: 'high' } },
  { from: 'SLB',   to: 'BP',     type: 'SUPPLIES_TO',      props: { product_category: 'Oilfield Services', revenue_pct: 6,  source: 'sec_10k', confidence: 'high' } },
  // ── Utilities → Big Tech power deals ──────────────────────────────────────
  { from: 'VST',   to: 'MSFT',   type: 'SUPPLIES_TO',      props: { product_category: 'Power (PPA contract)', market_share_pct: 15, source: 'news', confidence: 'high'   } },
  { from: 'CEG',   to: 'MSFT',   type: 'SUPPLIES_TO',      props: { product_category: 'Nuclear Power (PPA)',  market_share_pct: 20, source: 'news', confidence: 'high'   } },
  { from: 'CEG',   to: 'AMZN',   type: 'SUPPLIES_TO',      props: { product_category: 'Nuclear Power',        market_share_pct: 10, source: 'news', confidence: 'medium' } },
  { from: 'CEG',   to: 'GOOGL',  type: 'SUPPLIES_TO',      props: { product_category: 'Nuclear Power (PPA)',  market_share_pct: 8,  source: 'news', confidence: 'medium' } },
  // ── Telecom competition ───────────────────────────────────────────────────
  { from: 'T',     to: 'VZ',     type: 'COMPETES_WITH',    props: { market_segment: 'US Wireless/Fiber', overlap_pct: 90 } },
  // ── Sharing economy / ride-share ──────────────────────────────────────────
  { from: 'UBER',  to: 'ABNB',   type: 'COMPETES_WITH',    props: { market_segment: 'Platform/Gig Economy', overlap_pct: 30 } },

  // ── Investment / equity stakes (INVESTED_IN) ──────────────────────────────
  // Amazon holds ~16% of Rivian (public SEC filing) + exclusive delivery van contract
  { from: 'AMZN',    to: 'RIVN',  type: 'INVESTED_IN', props: { stake_pct: 16, source: 'sec_13f',  confidence: 'high',   note: 'Largest shareholder; 100k van order' } },
  // ARM Holdings IPO (Sep 2023) — strategic cornerstone investors
  { from: 'NVDA',    to: 'ARM',   type: 'INVESTED_IN', props: { stake_pct: 1,  source: 'ipo_prospectus', confidence: 'high', note: 'Strategic investor; prior acquisition attempt' } },
  { from: 'AAPL',    to: 'ARM',   type: 'INVESTED_IN', props: { stake_pct: 1,  source: 'ipo_prospectus', confidence: 'high', note: 'Strategic investor; ARM licensee since 1990s' } },
  { from: 'GOOGL',   to: 'ARM',   type: 'INVESTED_IN', props: { stake_pct: 1,  source: 'ipo_prospectus', confidence: 'high', note: 'Strategic investor; ARM used in Android devices' } },
  { from: 'TSM',     to: 'ARM',   type: 'INVESTED_IN', props: { stake_pct: 1,  source: 'ipo_prospectus', confidence: 'high', note: 'Strategic investor; manufactures ARM-based chips' } },
  { from: 'SAMSUNG', to: 'ARM',   type: 'INVESTED_IN', props: { stake_pct: 1,  source: 'ipo_prospectus', confidence: 'high', note: 'Strategic investor; ARM licensee for Exynos' } },
  { from: 'QCOM',    to: 'ARM',   type: 'INVESTED_IN', props: { stake_pct: 2,  source: 'ipo_prospectus', confidence: 'high', note: 'Long-term licensee and strategic investor' } },
  { from: 'AMD',     to: 'ARM',   type: 'INVESTED_IN', props: { stake_pct: 1,  source: 'ipo_prospectus', confidence: 'high', note: 'Strategic investor at IPO' } },
  { from: 'INTC',    to: 'ARM',   type: 'INVESTED_IN', props: { stake_pct: 1,  source: 'ipo_prospectus', confidence: 'high', note: 'Strategic investor at IPO' } },
  // Salesforce Ventures bought $250M of Snowflake at its 2020 IPO
  { from: 'CRM',     to: 'SNOW',  type: 'INVESTED_IN', props: { stake_pct: 2,  source: 'sec_13f',  confidence: 'high',   note: 'Salesforce Ventures; IPO anchor investor 2020' } },
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
  return { companies: COMPANIES.length, relationships_ok: ok, relationships_skipped: failed };
}

if (process.argv[1]?.endsWith('graph-seed.js')) {
  seedGraph().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
