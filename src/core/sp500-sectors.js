/**
 * src/core/sp500-sectors.js
 *
 * Static GICS sector mapping for S&P 500 mega-caps. Used by the Market tab's
 * stock-level heatmap to group tiles by sector.
 *
 * Why hardcoded?
 *   - tradable_universe.sector is NULL for nearly all rows
 *   - Yahoo Finance sector lookups are slow + rate-limited at 500 calls
 *   - GICS sector assignments change rarely (S&P rebalances quarterly,
 *     but a stock's sector is stable for years)
 *
 * Symbols not in this map fall back to 'Other'. The map covers ~100 of the
 * top 500 by weight — enough to give the heatmap visual structure.
 *
 * Sectors (11 GICS + Other):
 *   Tech, Comm, Discretionary, Staples, Healthcare, Financials, Industrials,
 *   Energy, Materials, Utilities, RealEstate, Other
 */

export const SP500_SECTORS = {
  // ── Technology ──────────────────────────────────────────────────────────
  AAPL: 'Tech', MSFT: 'Tech', NVDA: 'Tech', AVGO: 'Tech', ORCL: 'Tech',
  CRM: 'Tech', ADBE: 'Tech', NOW: 'Tech', IBM: 'Tech', INTU: 'Tech',
  ACN: 'Tech', AMD: 'Tech', INTC: 'Tech', QCOM: 'Tech', TXN: 'Tech',
  MU: 'Tech', AMAT: 'Tech', LRCX: 'Tech', KLAC: 'Tech', SNPS: 'Tech',
  CDNS: 'Tech', MRVL: 'Tech', ADI: 'Tech', PANW: 'Tech', CSCO: 'Tech',
  ANET: 'Tech', FTNT: 'Tech', CRWD: 'Tech', DELL: 'Tech', HPQ: 'Tech',

  // ── Communication Services ──────────────────────────────────────────────
  GOOGL: 'Comm', GOOG: 'Comm', META: 'Comm', NFLX: 'Comm',
  DIS: 'Comm', CMCSA: 'Comm', VZ: 'Comm', T: 'Comm', TMUS: 'Comm',
  CHTR: 'Comm', PARA: 'Comm', WBD: 'Comm',

  // ── Consumer Discretionary ──────────────────────────────────────────────
  AMZN: 'Discretionary', TSLA: 'Discretionary', HD: 'Discretionary',
  MCD: 'Discretionary', NKE: 'Discretionary', SBUX: 'Discretionary',
  BKNG: 'Discretionary', TJX: 'Discretionary', LOW: 'Discretionary',
  TGT: 'Discretionary', F: 'Discretionary', GM: 'Discretionary',
  CMG: 'Discretionary', ABNB: 'Discretionary',

  // ── Consumer Staples ────────────────────────────────────────────────────
  WMT: 'Staples', PG: 'Staples', COST: 'Staples', PEP: 'Staples',
  KO: 'Staples', PM: 'Staples', MDLZ: 'Staples', MO: 'Staples',
  CL: 'Staples', KMB: 'Staples', GIS: 'Staples', HSY: 'Staples',

  // ── Healthcare ──────────────────────────────────────────────────────────
  LLY: 'Healthcare', UNH: 'Healthcare', JNJ: 'Healthcare', ABBV: 'Healthcare',
  MRK: 'Healthcare', TMO: 'Healthcare', ABT: 'Healthcare', PFE: 'Healthcare',
  AMGN: 'Healthcare', GILD: 'Healthcare', BMY: 'Healthcare', DHR: 'Healthcare',
  MDT: 'Healthcare', CI: 'Healthcare', CVS: 'Healthcare', ELV: 'Healthcare',
  HCA: 'Healthcare', SYK: 'Healthcare', ISRG: 'Healthcare', VRTX: 'Healthcare',
  REGN: 'Healthcare', ZTS: 'Healthcare', BSX: 'Healthcare',

  // ── Financials ──────────────────────────────────────────────────────────
  'BRK-B': 'Financials', JPM: 'Financials', V: 'Financials', MA: 'Financials',
  BAC: 'Financials', WFC: 'Financials', MS: 'Financials', GS: 'Financials',
  AXP: 'Financials', BLK: 'Financials', SCHW: 'Financials', SPGI: 'Financials',
  ICE: 'Financials', CB: 'Financials', AON: 'Financials', C: 'Financials',
  USB: 'Financials', TFC: 'Financials', PNC: 'Financials', PYPL: 'Financials',
  MCO: 'Financials', MMC: 'Financials',

  // ── Industrials ─────────────────────────────────────────────────────────
  CAT: 'Industrials', DE: 'Industrials', BA: 'Industrials', GE: 'Industrials',
  HON: 'Industrials', UNP: 'Industrials', RTX: 'Industrials', LMT: 'Industrials',
  GD: 'Industrials', EMR: 'Industrials', ETN: 'Industrials', PH: 'Industrials',
  CMI: 'Industrials', NSC: 'Industrials', CSX: 'Industrials', FDX: 'Industrials',
  UPS: 'Industrials',

  // ── Energy ──────────────────────────────────────────────────────────────
  XOM: 'Energy', CVX: 'Energy', COP: 'Energy', EOG: 'Energy',
  PSX: 'Energy', OXY: 'Energy', SLB: 'Energy', MPC: 'Energy',
  VLO: 'Energy', PXD: 'Energy',

  // ── Materials ───────────────────────────────────────────────────────────
  LIN: 'Materials', SHW: 'Materials', FCX: 'Materials', NEM: 'Materials',
  APD: 'Materials', ECL: 'Materials', PPG: 'Materials',

  // ── Utilities ───────────────────────────────────────────────────────────
  NEE: 'Utilities', SO: 'Utilities', DUK: 'Utilities', SRE: 'Utilities',
  AEP: 'Utilities', D: 'Utilities', EXC: 'Utilities',

  // ── Real Estate ─────────────────────────────────────────────────────────
  AMT: 'RealEstate', PLD: 'RealEstate', EQIX: 'RealEstate', CCI: 'RealEstate',
  PSA: 'RealEstate', O: 'RealEstate', WELL: 'RealEstate', SPG: 'RealEstate',

  // ── Additions 2026-05-25 (high-volume names from heatmap audit) ─────────
  // Added in a batch to cover the most-traded S&P/SPY-adjacent names that
  // were falling into "Other". Sourced from GICS classification per company.

  // Tech additions (cloud/SaaS/semis/hardware)
  SMCI: 'Tech', HPE: 'Tech', PLTR: 'Tech', WDAY: 'Tech', SHOP: 'Tech',
  ZM: 'Tech', SNOW: 'Tech', S: 'Tech', NTAP: 'Tech', PSTG: 'Tech',
  ZS: 'Tech', WDC: 'Tech', DT: 'Tech', DDOG: 'Tech', GTLB: 'Tech',
  OKTA: 'Tech', STX: 'Tech', FROG: 'Tech',

  // Financials additions (banks, payments, fintech, insurers)
  SOFI: 'Financials', HOOD: 'Financials', HBAN: 'Financials', IBKR: 'Financials',
  RF: 'Financials', COIN: 'Financials', AFRM: 'Financials', PGR: 'Financials',
  MET: 'Financials', FITB: 'Financials', KEY: 'Financials', UPST: 'Financials',
  FHN: 'Financials', COF: 'Financials',

  // Discretionary additions (autos/EV, ride-share, e-comm, travel)
  NIO: 'Discretionary', RIVN: 'Discretionary', STLA: 'Discretionary',
  UBER: 'Discretionary', LYFT: 'Discretionary', LCID: 'Discretionary',
  CVNA: 'Discretionary', XPEV: 'Discretionary', LI: 'Discretionary',
  CHWY: 'Discretionary', DASH: 'Discretionary', EBAY: 'Discretionary',
  W: 'Discretionary', TRIP: 'Discretionary',

  // Healthcare additions (pharma, biotech, devices)
  NVO: 'Healthcare', NVAX: 'Healthcare', MRNA: 'Healthcare', EW: 'Healthcare',
  GSK: 'Healthcare', SNY: 'Healthcare',

  // Real Estate additions (REITs)
  OPEN: 'RealEstate', AGNC: 'RealEstate', NLY: 'RealEstate', UDR: 'RealEstate',
  Z: 'RealEstate',

  // Industrials additions
  HYLN: 'Industrials', CARR: 'Industrials', OTIS: 'Industrials',

  // Energy additions
  DVN: 'Energy', SM: 'Energy', REI: 'Energy',

  // Materials additions
  VALE: 'Materials', MOS: 'Materials',

  // Utilities additions
  PPL: 'Utilities', FE: 'Utilities', ED: 'Utilities',

  // Comm additions
  LUMN: 'Comm', NWSA: 'Comm',
};

/**
 * ETFs/funds that may slip into the S&P 500 list (or our broader universe)
 * but should NOT appear on a stock-level heatmap. The heatmap endpoint
 * filters these out before returning rows.
 */
export const ETF_EXCLUDE = new Set([
  'SPY', 'QQQ', 'DIA', 'IWM',                  // index trackers
  'TLT', 'LQD', 'HYG', 'AGG', 'BND',           // bond ETFs
  'GLD', 'SLV', 'USO', 'UNG',                  // commodity ETFs
  'XLK', 'XLF', 'XLE', 'XLY', 'XLP', 'XLV', 'XLI', 'XLU', 'XLB', 'XLRE', 'XLC',  // sector SPDRs
  'VOO', 'VTI', 'IVV',                          // broad-market
]);

/** GICS sector color palette — used for tile borders / hover state */
export const SECTOR_COLORS = {
  Tech:           '#58a6ff',
  Comm:           '#bc8cff',
  Discretionary:  '#f0883e',
  Staples:        '#3fb950',
  Healthcare:     '#ff7b72',
  Financials:     '#ffd23f',
  Industrials:    '#79c0ff',
  Energy:         '#ff9500',
  Materials:      '#a371f7',
  Utilities:      '#84d2c5',
  RealEstate:     '#c8b6e2',
  Other:          '#8b949e',
};

export function sectorOf(symbol) {
  return SP500_SECTORS[symbol] || 'Other';
}
