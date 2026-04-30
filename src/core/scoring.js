/**
 * Multi-factor conviction scoring engine.
 * Combines earnings quality, momentum, relative strength, insider activity,
 * and market conditions into a single 0–100 score.
 */

import YahooFinance from 'yahoo-finance2';
const yf = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

import { getPreEarningsDrift, getEarnings, getSymbolNews, getInsiderBuying, getEarningsSurprise } from './news.js';
import { getRelativeStrength, getMarketSentiment, SECTOR_MAP } from './sentiment.js';
import { isBadTradingTime } from './trader.js';
import { getChartTechnicals, getPriceLevels } from './tradingview-bridge.js';
import { recordConvictionScore, getFactorWeights } from './db.js';

const KNOWN_NAMES = {
  AAPL:'Apple Inc.', MSFT:'Microsoft Corporation', GOOGL:'Alphabet Inc.', GOOG:'Alphabet Inc.',
  META:'Meta Platforms Inc.', AMZN:'Amazon.com Inc.', NVDA:'NVIDIA Corporation', TSLA:'Tesla Inc.',
  AMD:'Advanced Micro Devices Inc.', INTC:'Intel Corporation', QCOM:'Qualcomm Inc.',
  AVGO:'Broadcom Inc.', MU:'Micron Technology Inc.', TSM:'Taiwan Semiconductor',
  SMCI:'Super Micro Computer Inc.', MRVL:'Marvell Technology Inc.', ARM:'Arm Holdings plc',
  NFLX:'Netflix Inc.', JPM:'JPMorgan Chase & Co.', XOM:'Exxon Mobil Corporation',
  RTX:'RTX Corporation', LMT:'Lockheed Martin Corporation', BA:'Boeing Company',
  GS:'Goldman Sachs Group', MS:'Morgan Stanley', BAC:'Bank of America Corp.',
  COIN:'Coinbase Global Inc.', PLTR:'Palantir Technologies Inc.', CRWD:'CrowdStrike Holdings Inc.',
  SNOW:'Snowflake Inc.', UBER:'Uber Technologies Inc.', LYFT:'Lyft Inc.',
  RIVN:'Rivian Automotive Inc.', LCID:'Lucid Group Inc.', NIO:'NIO Inc.',
  BIDU:'Baidu Inc.', SHOP:'Shopify Inc.', SQ:'Block Inc.', PYPL:'PayPal Holdings Inc.',
  NET:'Cloudflare Inc.', DDOG:'Datadog Inc.', ZS:'Zscaler Inc.', OKTA:'Okta Inc.',
  PANW:'Palo Alto Networks Inc.', FTNT:'Fortinet Inc.', AMAT:'Applied Materials Inc.',
  KLAC:'KLA Corporation', LRCX:'Lam Research Corporation', ASML:'ASML Holding N.V.',
  ORCL:'Oracle Corporation', CRM:'Salesforce Inc.', NOW:'ServiceNow Inc.',
  ADBE:'Adobe Inc.', INTU:'Intuit Inc.', IBM:'IBM Corporation', HPQ:'HP Inc.',
  DELL:'Dell Technologies', HPE:'Hewlett Packard Enterprise',
  SPY:'SPDR S&P 500 ETF', QQQ:'Invesco QQQ Trust', IWM:'iShares Russell 2000 ETF',
};

async function getRVOL(symbol) {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=30d`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const vol = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.volume?.filter(v => v != null) ?? [];
    if (vol.length < 5) return null;
    const todayVol = vol[vol.length - 1];
    const avgVol   = vol.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.min(20, vol.length - 1);
    if (!avgVol) return null;
    return +(todayVol / avgVol).toFixed(2);
  } catch { return null; }
}

// Analyst consensus + short interest — fetched together via yahoo-finance2 (handles auth)
let _yfSummaryCache = new Map(); // symbol → { ts, data }
const YF_CACHE_TTL = 4 * 60 * 60 * 1000; // 4h — analyst data changes infrequently

async function getYFSummary(symbol) {
  const cached = _yfSummaryCache.get(symbol);
  if (cached && Date.now() - cached.ts < YF_CACHE_TTL) return cached.data;
  try {
    const res = await yf.quoteSummary(symbol, { modules: ['financialData', 'defaultKeyStatistics', 'recommendationTrend'] });
    _yfSummaryCache.set(symbol, { ts: Date.now(), data: res });
    return res;
  } catch { return null; }
}

async function getAnalystRating(symbol) {
  try {
    const res  = await getYFSummary(symbol);
    if (!res) return null;
    const fin   = res.financialData;
    const trend = res.recommendationTrend?.trend?.[0];

    const mean        = fin?.recommendationMean ?? null;
    const targetPrice = fin?.targetMeanPrice    ?? null;
    const curPrice    = fin?.currentPrice       ?? null;
    const upside      = (targetPrice && curPrice) ? +((targetPrice - curPrice) / curPrice * 100).toFixed(1) : null;
    const total       = (trend?.strongBuy ?? 0) + (trend?.buy ?? 0) + (trend?.hold ?? 0) + (trend?.sell ?? 0) + (trend?.strongSell ?? 0);

    let consensus = 'neutral';
    if (mean != null) {
      if      (mean <= 1.5) consensus = 'strong_buy';
      else if (mean <= 2.5) consensus = 'buy';
      else if (mean <= 3.5) consensus = 'hold';
      else if (mean <= 4.5) consensus = 'sell';
      else                  consensus = 'strong_sell';
    }
    return { consensus, mean, target_price: targetPrice, upside_pct: upside, total_analysts: total };
  } catch { return null; }
}

async function getShortInterest(symbol) {
  try {
    const res   = await getYFSummary(symbol);
    const stats = res?.defaultKeyStatistics;
    if (!stats) return null;
    const short_float_pct = stats.shortPercentOfFloat != null ? +(stats.shortPercentOfFloat * 100).toFixed(2) : null;
    const short_ratio     = stats.shortRatio ?? null;
    return { short_float_pct, short_ratio };
  } catch { return null; }
}

// Weekly trend: price vs 10-week EMA — confirms or contradicts the daily signal
async function getWeeklyTrend(symbol) {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1wk&range=6mo`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const closes = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null) ?? [];
    if (closes.length < 10) return null;

    // 10-week EMA
    const period = 10;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);

    const price = closes[closes.length - 1];
    const pct   = +((price - ema) / ema * 100).toFixed(2);
    return {
      price,
      ema10w:    +ema.toFixed(2),
      pct_vs_ema: pct,
      trend:     pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat',
    };
  } catch { return null; }
}

// Correlation groups — stocks that move nearly in lockstep
const CORR_GROUPS = [
  ['NVDA','AMD','MU','SMCI','INTC','MRVL','LRCX','AMAT','KLAC','ASML','ARM','QCOM','AVGO'],
  ['AAPL','MSFT'],
  ['META','GOOGL','GOOG','AMZN'],
  ['JPM','GS','MS','BAC','WFC','C'],
  ['XOM','CVX','COP','OXY','DVN'],
  ['TSLA','RIVN','LCID','NIO','LI','XPEV'],
  ['CRWD','PANW','ZS','NET','OKTA','FTNT','S'],
  ['COIN','MSTR','HOOD'],
  ['SHOP','ETSY','EBAY'],
  ['UBER','LYFT','DASH'],
  ['NFLX','DIS','CMCSA','WBD'],
  ['PLTR','SNOW','DDOG','MDB','GTLB'],
];

export function checkCorrelation({ symbol, positions = [] }) {
  const ticker = symbol.toUpperCase();
  const group  = CORR_GROUPS.find(g => g.includes(ticker));
  if (!group) return { correlated: false };

  for (const pos of positions) {
    const sym = (pos.symbol || '').toUpperCase();
    if (sym === ticker) continue;
    if (group.includes(sym)) return { correlated: true, existing_symbol: sym, group_members: group };
  }
  return { correlated: false };
}

export function checkSectorConcentration({ symbol, positions = [] }) {
  const ticker = symbol.toUpperCase();
  const targetSector = SECTOR_MAP[ticker];
  if (!targetSector) return { concentrated: false };

  for (const pos of positions) {
    const posSym = (pos.symbol || '').toUpperCase();
    if (posSym === ticker) continue; // same symbol, not a concentration issue
    if (SECTOR_MAP[posSym] === targetSector) {
      return { concentrated: true, existing_symbol: posSym, sector: targetSector };
    }
  }
  return { concentrated: false };
}

const _scoreCache = new Map();
const SCORE_CACHE_TTL = 5 * 60 * 1000;

export async function getConvictionScore({ symbol, positions = [] } = {}) {
  const ticker = symbol.toUpperCase().replace(/^(NASDAQ:|NYSE:|AMEX:)/, '');

  const cached = _scoreCache.get(ticker);
  if (cached && Date.now() - cached.ts < SCORE_CACHE_TTL) {
    return { ...cached.score, cached: true };
  }
  const sectorEtf = SECTOR_MAP[ticker] || 'SPY';

  // Fetch all signals in parallel — individual failures don't abort scoring
  const [driftRes, rsRes, newsRes, earningsRes, sentimentRes, insiderRes, surpriseRes, techRes, levelsRes, nameRes, rvolRes, weeklyRes, analystRes, shortRes] =
    await Promise.allSettled([
      getPreEarningsDrift({ symbol: ticker }),
      getRelativeStrength({ symbol: ticker, sector_etf: sectorEtf }),
      getSymbolNews({ symbol: ticker, limit: 10 }),
      getEarnings({ symbol: ticker }),
      getMarketSentiment(),
      getInsiderBuying({ symbol: ticker }),
      getEarningsSurprise({ symbol: ticker }),
      getChartTechnicals({ symbol: ticker }),
      getPriceLevels({ symbol: ticker }),
      KNOWN_NAMES[ticker]
        ? Promise.resolve(KNOWN_NAMES[ticker])
        : fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`, {
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          }).then(r => r.json()).then(d => d?.chart?.result?.[0]?.meta?.shortName || null).catch(() => null),
      getRVOL(ticker),
      getWeeklyTrend(ticker),
      getAnalystRating(ticker),
      getShortInterest(ticker),
    ]);

  const drift    = driftRes.status    === 'fulfilled' ? driftRes.value    : null;
  const rs       = rsRes.status       === 'fulfilled' ? rsRes.value       : null;
  const news     = newsRes.status     === 'fulfilled' ? newsRes.value     : null;
  const earnings = earningsRes.status === 'fulfilled' ? earningsRes.value : null;
  const sentiment= sentimentRes.status=== 'fulfilled' ? sentimentRes.value: null;
  const insider  = insiderRes.status  === 'fulfilled' ? insiderRes.value  : null;
  const surprise = surpriseRes.status === 'fulfilled' ? surpriseRes.value : null;
  const tech     = techRes.status     === 'fulfilled' ? techRes.value     : null;
  const levels   = levelsRes.status   === 'fulfilled' ? levelsRes.value   : null;
  const name     = nameRes.status     === 'fulfilled' ? nameRes.value     : null;
  const rvol     = rvolRes.status     === 'fulfilled' ? rvolRes.value     : null;
  const weekly   = weeklyRes.status   === 'fulfilled' ? weeklyRes.value   : null;
  const analyst  = analystRes.status  === 'fulfilled' ? analystRes.value  : null;
  const short    = shortRes.status    === 'fulfilled' ? shortRes.value    : null;

  // Extract signal values
  const beat_streak       = surprise?.beat_streak        ?? 0;
  const earnings_quality  = earnings?.history?.[0]?.earnings_quality ?? null;
  const guidance_signal   = news?.guidance_signal        ?? 'neutral';
  const drift_direction   = drift?.drift_direction       ?? 'flat';
  const rs_signal         = rs?.signal                   ?? 'neutral';
  const insider_buys_60d  = insider?.insider_buys_60d    ?? 0;
  const vix               = sentiment?.vix?.value        ?? null;
  const badTime           = isBadTradingTime();
  const tvAvailable       = tech?.available === true;
  const sectorCheck       = checkSectorConcentration({ symbol: ticker, positions });
  const corrCheck         = checkCorrelation({ symbol: ticker, positions });

  // Score each factor
  const breakdown = {
    // Graduated beat streak — partial credit for 1-2 quarters
    beat_streak:          beat_streak >= 3 ? 25 : beat_streak === 2 ? 15 : beat_streak === 1 ? 8 : 0,
    // Earnings quality
    earnings_quality:     earnings_quality === 'strong' ? 20 : earnings_quality === 'moderate' ? 8 : 0,
    // Guidance
    guidance_raised:      guidance_signal === 'raised'  ?  15 : 0,
    guidance_lowered:     guidance_signal === 'lowered' ? -15 : 0,
    // Momentum signals
    pre_earnings_drift:   drift_direction === 'up'      ?  15 : drift_direction === 'down' ? -10 : 0,
    relative_strength:    rs_signal === 'strong'        ?  15 : rs_signal === 'weak'       ? -10 : 0,
    // Insider activity — 1 buy counts for something
    insider_buying:       insider_buys_60d >= 2 ? 10 : insider_buys_60d === 1 ? 5 : 0,
    // Analyst consensus (Wall St. coverage)
    analyst_rating:       analyst == null ? 0
                          : analyst.consensus === 'strong_buy' ? 15
                          : analyst.consensus === 'buy'        ? 10
                          : analyst.consensus === 'sell'       ? -12
                          : analyst.consensus === 'strong_sell'? -20 : 0,
    // Short interest — high short + strong RS = squeeze setup
    short_squeeze:        (short?.short_float_pct ?? 0) >= 15 && rs_signal === 'strong' ? 10
                          : (short?.short_float_pct ?? 0) >= 25 ? -5 : 0,
    // Relative Volume — institutional accumulation signal
    rvol:                 rvol == null ? 0 : rvol >= 2.0 ? 15 : rvol >= 1.5 ? 8 : rvol < 0.5 ? -8 : 0,
    // Weekly trend confirmation — does the weekly chart agree with the daily signal?
    weekly_trend:         weekly == null ? 0 : weekly.trend === 'up' ? 12 : weekly.trend === 'down' ? -12 : 0,
    // VIX — graduated, only extreme fear is a hard penalty
    high_vix:             vix == null ? 0 : vix > 35 ? -20 : vix > 28 ? -10 : vix > 25 ? -5 : 0,
    // Time of day — only penalise true lunch chop (12:30–1:30 PM ET)
    bad_trading_time:     badTime.bad                   ?  -5 : 0,
    // Sector concentration — hard penalty
    sector_concentrated:  sectorCheck.concentrated      ? -25 : 0,
    // Correlation — extra penalty when portfolio already holds a nearly identical stock
    correlated_position:  corrCheck.correlated          ? -20 : 0,
    // Base score — starts at 20; a stock must earn its score through real signals
    base:                 20,
  };

  // TradingView technical factors (only applied when chart data is live)
  let technical_summary = 'TradingView not connected';
  if (tvAvailable) {
    const { rsi, macd_hist, ema20, ema50, bb_upper, bb_mid, current_price, distance_to_support_pct, distance_to_resistance_pct } = tech;
    const lvlDist = levels?.available ? {
      support_pct:    levels.distance_to_support_pct,
      resistance_pct: levels.distance_to_resistance_pct,
    } : {};

    if (rsi != null && rsi < 40)  breakdown.rsi_oversold         =  20;
    if (rsi != null && rsi > 70)  breakdown.rsi_overbought       = -20;
    if (current_price != null && ema20 != null && ema50 != null) {
      if (current_price > ema20 && current_price > ema50) breakdown.above_both_emas =  15;
      if (current_price < ema20 && current_price < ema50) breakdown.below_both_emas = -15;
    }
    if (macd_hist != null && macd_hist > 0) breakdown.macd_positive =  10;
    if (macd_hist != null && macd_hist < 0) breakdown.macd_negative = -10;
    if (lvlDist.support_pct != null    && lvlDist.support_pct < 2)    breakdown.near_support    =  15;
    if (lvlDist.resistance_pct != null && lvlDist.resistance_pct < 2) breakdown.near_resistance = -15;
    if (current_price != null && bb_mid != null && current_price < bb_mid) breakdown.below_bb_mid  =  10;
    if (current_price != null && bb_upper != null && current_price > bb_upper) breakdown.above_bb_upper = -10;

    // One-sentence technical summary
    const rsiNote = rsi != null ? (rsi < 40 ? 'oversold RSI' : rsi > 70 ? 'overbought RSI' : `RSI ${rsi.toFixed(0)}`) : '';
    const trendNote = (current_price && ema20 && ema50)
      ? (current_price > ema20 && current_price > ema50 ? 'above EMA20/50 uptrend'
        : current_price < ema20 && current_price < ema50 ? 'below EMA20/50 downtrend' : 'mixed EMA signals')
      : '';
    const macdNote = macd_hist != null ? (macd_hist > 0 ? 'MACD positive' : 'MACD negative') : '';
    technical_summary = [rsiNote, trendNote, macdNote].filter(Boolean).join(', ') || 'chart data read';
  } else if (tech?.available === false) {
    breakdown.tv_unavailable = 0; // marker — no penalty
  }

  const raw        = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const scoreBase  = Math.min(100, Math.max(0, raw));
  const gradeBase  = scoreBase >= 80 ? 'A' : scoreBase >= 60 ? 'B' : scoreBase >= 40 ? 'C' : 'F';

  // Backtest-weighted adjustment: grades with higher historical alpha get a small boost
  const factorWeights = await getFactorWeights();
  const backtestAdj   = factorWeights?.adjustments?.[gradeBase] ?? 0;
  if (backtestAdj !== 0) breakdown.backtest_alpha_adj = backtestAdj;

  const raw2  = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const score = Math.min(100, Math.max(0, raw2));
  const grade = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'F';
  const recommendation =
    score >= 80 ? 'strong_buy' :
    score >= 60 ? 'buy' :
    score >= 40 ? 'skip' : 'avoid';

  const signals = {
    beat_streak,
    earnings_quality,
    guidance_signal,
    drift_5d_pct:    drift?.drift_5d_pct    ?? null,
    drift_direction,
    rs_score:        rs?.rs_score           ?? null,
    rs_signal,
    insider_buys_60d,
    rvol,
    weekly_trend:        weekly?.trend        ?? null,
    weekly_pct_vs_ema:   weekly?.pct_vs_ema   ?? null,
    analyst_consensus:   analyst?.consensus   ?? null,
    analyst_target:      analyst?.target_price ?? null,
    analyst_upside_pct:  analyst?.upside_pct  ?? null,
    short_float_pct:     short?.short_float_pct ?? null,
    short_ratio:         short?.short_ratio   ?? null,
    vix,
    bad_trading_time: badTime.bad,
    bad_time_reason:  badTime.reason,
    rsi:             tech?.rsi             ?? null,
    macd_hist:       tech?.macd_hist       ?? null,
    ema20:           tech?.ema20           ?? null,
    ema50:           tech?.ema50           ?? null,
    current_price:   tech?.current_price   ?? null,
    sector_concentration: sectorCheck,
    correlation:          corrCheck,
  };

  // Persist to DB (non-blocking)
  recordConvictionScore({ symbol: ticker, name, score, grade, breakdown, signals, tv_available: tvAvailable, technical_summary });

  const result = {
    success: true,
    symbol: ticker,
    name,
    score,
    grade,
    recommendation,
    tv_available: tvAvailable,
    technical_summary,
    breakdown,
    signals,
  };
  _scoreCache.set(ticker, { score: result, ts: Date.now() });
  return result;
}
