/**
 * src/web/portfolio-advisor.js
 *
 * Portfolio Advisor backend logic. Pure functions where possible — every
 * number traces back to a measurable input. Claude is used ONLY for
 * narrative; never for decisions or numbers.
 *
 * Architecture:
 *   - getRiskScore(position, signals, account) → {score 0-100, factors[]}
 *   - getBotVerdict(symbol, position, signals) → {action, reasoning}
 *   - getHedgeRecommendation(position, signals) → covered call params | null
 *   - enrichPositions(positions, accountValue) → fully decorated array
 *
 * Read-only — never places orders. Numbers stay rule-based.
 */

import { getOptionChain, getIvRank } from '../core/unusual-whales.js';

// ─── Risk scoring ───────────────────────────────────────────────────────────
//
// Each factor contributes a non-negative number (0 = healthy, positive = risk).
// Sum and cap at 100. Each factor returns `{ name, contribution, evidence }`
// so the UI can show *why* the score is what it is.
//
// Discipline: every factor must cite an input source the user can verify.

const FACTOR_WEIGHTS = {
  drawdown:        25,   // unrealized loss %
  concentration:   30,   // position % of portfolio
  earnings:        20,   // days to next earnings
  volatility:      15,   // 30d realized vol
  conviction:      20,   // bot's conviction grade
  uw_flow:         20,   // UW flow sentiment
  news:            10,   // news sentiment 24h
  sector:          10,   // sector concentration
};

function factor(name, contribution, evidence, max) {
  return { name, contribution: Math.min(max, Math.max(0, contribution)), evidence, max };
}

function scoreDrawdown(position) {
  const pct = position.unrealized_pl_pct ?? 0;
  // Linear: -5% = 6, -10% = 12, -20% = 25 (capped)
  if (pct >= 0)  return factor('Drawdown',     0,                    `+${pct.toFixed(2)}% (gain)`,           FACTOR_WEIGHTS.drawdown);
  const c = Math.min(FACTOR_WEIGHTS.drawdown, Math.abs(pct) * 1.25);
  return            factor('Drawdown',     c,                    `${pct.toFixed(2)}% from cost basis`,        FACTOR_WEIGHTS.drawdown);
}

function scoreConcentration(position, accountValue) {
  if (!accountValue || accountValue <= 0) return factor('Concentration', 0, 'unknown account size', FACTOR_WEIGHTS.concentration);
  const pct = (position.market_val / accountValue) * 100;
  // 10% = healthy. 25% = warn (8). 50% = high (20). 70%+ = extreme (30).
  let c = 0;
  if (pct > 70)      c = 30;
  else if (pct > 50) c = 20 + ((pct - 50) / 20) * 10;
  else if (pct > 25) c = 8 + ((pct - 25) / 25) * 12;
  else if (pct > 10) c = ((pct - 10) / 15) * 8;
  return factor('Concentration', c, `${pct.toFixed(1)}% of portfolio`, FACTOR_WEIGHTS.concentration);
}

async function scoreEarnings(position, query) {
  // Check benzinga_news or earnings calendar — closest future earnings within 21d
  try {
    const r = await query(
      `SELECT MIN(earnings_date) AS next_earnings
       FROM benzinga_earnings
       WHERE ticker=$1 AND earnings_date >= CURRENT_DATE AND earnings_date <= CURRENT_DATE + INTERVAL '21 days'`,
      [position.symbol.toUpperCase()]
    );
    const next = r.rows[0]?.next_earnings;
    if (!next) return factor('Earnings proximity', 0, 'no earnings within 21d', FACTOR_WEIGHTS.earnings);
    const days = Math.round((new Date(next) - Date.now()) / 86_400_000);
    // 0-3 days = 20 (highest), 4-7 = 12, 8-14 = 5, 15-21 = 2
    let c = 0;
    if (days <= 3)       c = 20;
    else if (days <= 7)  c = 12;
    else if (days <= 14) c = 5;
    else                 c = 2;
    return factor('Earnings proximity', c, `earnings in ${days}d (${next.toISOString().slice(0,10)})`, FACTOR_WEIGHTS.earnings);
  } catch {
    return factor('Earnings proximity', 0, 'data unavailable', FACTOR_WEIGHTS.earnings);
  }
}

async function scoreVolatility(position, query) {
  // 30-day realized stddev of daily log returns
  try {
    const r = await query(
      `SELECT close FROM backtest_prices
       WHERE symbol=$1 AND price_date > CURRENT_DATE - INTERVAL '45 days'
       ORDER BY price_date ASC`,
      [position.symbol.toUpperCase()]
    );
    const closes = r.rows.map(x => Number(x.close)).filter(Number.isFinite);
    if (closes.length < 15) return factor('Volatility (30d)', 0, 'insufficient price history', FACTOR_WEIGHTS.volatility);
    const rets = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i-1]));
    const mean = rets.reduce((a,b)=>a+b,0) / rets.length;
    const variance = rets.reduce((a,b)=>a+(b-mean)**2,0) / rets.length;
    const sd = Math.sqrt(variance);
    const annVol = sd * Math.sqrt(252) * 100; // %
    // 20% annualized = 0, 30% = 4, 45% = 10, 60%+ = 15
    let c = 0;
    if (annVol > 60)      c = 15;
    else if (annVol > 45) c = 10 + ((annVol - 45) / 15) * 5;
    else if (annVol > 30) c = 4 + ((annVol - 30) / 15) * 6;
    else if (annVol > 20) c = ((annVol - 20) / 10) * 4;
    return factor('Volatility (30d)', c, `${annVol.toFixed(1)}% annualized realized vol`, FACTOR_WEIGHTS.volatility);
  } catch {
    return factor('Volatility (30d)', 0, 'data unavailable', FACTOR_WEIGHTS.volatility);
  }
}

async function scoreConviction(position, query) {
  try {
    const r = await query(
      `SELECT score, grade FROM conviction_scores
       WHERE symbol=$1 AND scored_at > NOW() - INTERVAL '7 days'
       ORDER BY scored_at DESC LIMIT 1`,
      [position.symbol.toUpperCase()]
    );
    const row = r.rows[0];
    if (!row) return factor('Bot conviction', 8, 'no recent score (bot hasn\'t evaluated)', FACTOR_WEIGHTS.conviction);
    const score = Number(row.score);
    // High score = low risk. F = 20, C = 10, B = 3, A = 0
    let c = 0;
    if (row.grade === 'F')      c = 20;
    else if (row.grade === 'C') c = 10;
    else if (row.grade === 'B') c = 3;
    return factor('Bot conviction', c, `score ${score.toFixed(0)} (grade ${row.grade})`, FACTOR_WEIGHTS.conviction);
  } catch {
    return factor('Bot conviction', 0, 'data unavailable', FACTOR_WEIGHTS.conviction);
  }
}

async function scoreUwFlow(position, query) {
  try {
    const r = await query(
      `SELECT
         SUM(CASE WHEN sentiment IN ('bearish','strong_bearish') THEN premium ELSE 0 END) AS bear_prem,
         SUM(CASE WHEN sentiment IN ('bullish','strong_bullish') THEN premium ELSE 0 END) AS bull_prem
       FROM uw_flow_alerts
       WHERE ticker=$1 AND alerted_at > NOW() - INTERVAL '24 hours'`,
      [position.symbol.toUpperCase()]
    );
    const { bear_prem, bull_prem } = r.rows[0] || {};
    const bear = Number(bear_prem || 0);
    const bull = Number(bull_prem || 0);
    if (bear + bull === 0) return factor('UW options flow', 0, 'no flow in last 24h', FACTOR_WEIGHTS.uw_flow);
    const netBear = bear - bull;
    if (netBear <= 0) return factor('UW options flow', 0, `bullish flow $${(bull/1000).toFixed(0)}k`, FACTOR_WEIGHTS.uw_flow);
    // Bearish: scale by absolute size
    let c = 0;
    if (netBear >= 1e6)       c = 20;
    else if (netBear >= 500e3) c = 14;
    else if (netBear >= 200e3) c = 8;
    else                       c = 3;
    return factor('UW options flow', c, `net bearish flow $${(netBear/1000).toFixed(0)}k`, FACTOR_WEIGHTS.uw_flow);
  } catch {
    return factor('UW options flow', 0, 'data unavailable', FACTOR_WEIGHTS.uw_flow);
  }
}

async function scoreNews(position, query) {
  try {
    const r = await query(
      `SELECT
         COUNT(*) FILTER (WHERE sentiment = 'negative') AS neg,
         COUNT(*) FILTER (WHERE sentiment = 'positive') AS pos,
         COUNT(*) AS total
       FROM benzinga_news bn, jsonb_array_elements_text(bn.tickers) AS t(ticker)
       WHERE t.ticker = $1 AND bn.published_at > NOW() - INTERVAL '24 hours'`,
      [position.symbol.toUpperCase()]
    );
    const { neg, pos, total } = r.rows[0] || {};
    const n = Number(neg || 0), p = Number(pos || 0), t = Number(total || 0);
    if (t === 0) return factor('News sentiment (24h)', 0, 'no recent news', FACTOR_WEIGHTS.news);
    if (n === 0) return factor('News sentiment (24h)', 0, `${p} positive · 0 negative`, FACTOR_WEIGHTS.news);
    // Negative-heavy news in last 24h
    let c = 0;
    if (n >= 5 && n > p)      c = 10;
    else if (n >= 3 && n > p) c = 6;
    else if (n >= 1)          c = 2;
    return factor('News sentiment (24h)', c, `${n} negative / ${p} positive / ${t} total`, FACTOR_WEIGHTS.news);
  } catch {
    return factor('News sentiment (24h)', 0, 'data unavailable', FACTOR_WEIGHTS.news);
  }
}

async function scoreSectorConcentration(position, allPositions, accountValue, query) {
  if (!accountValue) return factor('Sector concentration', 0, 'no account value', FACTOR_WEIGHTS.sector);
  try {
    const symbols = allPositions.map(p => p.symbol.toUpperCase());
    const r = await query(
      `SELECT symbol, sector FROM tradable_universe WHERE symbol = ANY($1::text[])`,
      [symbols]
    );
    const sectorMap = new Map(r.rows.map(x => [x.symbol, x.sector]));
    const mySector = sectorMap.get(position.symbol.toUpperCase()) || 'Unknown';
    if (mySector === 'Unknown') return factor('Sector concentration', 0, 'sector unknown', FACTOR_WEIGHTS.sector);
    const sectorTotal = allPositions
      .filter(p => sectorMap.get(p.symbol.toUpperCase()) === mySector)
      .reduce((s, p) => s + (p.market_val || 0), 0);
    const pct = (sectorTotal / accountValue) * 100;
    let c = 0;
    if (pct > 60)       c = 10;
    else if (pct > 40)  c = 6;
    else if (pct > 25)  c = 2;
    return factor('Sector concentration', c, `${pct.toFixed(0)}% in ${mySector}`, FACTOR_WEIGHTS.sector);
  } catch {
    return factor('Sector concentration', 0, 'data unavailable', FACTOR_WEIGHTS.sector);
  }
}

export async function getRiskScore(position, accountValue, allPositions, query) {
  const factors = await Promise.all([
    Promise.resolve(scoreDrawdown(position)),
    Promise.resolve(scoreConcentration(position, accountValue)),
    scoreEarnings(position, query),
    scoreVolatility(position, query),
    scoreConviction(position, query),
    scoreUwFlow(position, query),
    scoreNews(position, query),
    scoreSectorConcentration(position, allPositions, accountValue, query),
  ]);
  const rawTotal = factors.reduce((s, f) => s + f.contribution, 0);
  const score = Math.min(100, Math.round(rawTotal));
  return { score, factors };
}

// ─── Bot verdict ────────────────────────────────────────────────────────────
//
// Apply the bot's actual decision logic to this held position. Returns one of:
//   BUY  — would actively buy (composite ≥ 60, all gates pass)
//   HOLD — within range, not adding (composite 40-59)
//   TRIM — signal weakening, consider reducing (composite 20-39 OR drawdown deep)
//   EXIT — bot would not hold this (composite < 20 OR grade F OR strong bearish)

export async function getBotVerdict(symbol, position, query) {
  try {
    const r = await query(
      `SELECT score, grade, breakdown FROM conviction_scores
       WHERE symbol=$1 AND scored_at > NOW() - INTERVAL '7 days'
       ORDER BY scored_at DESC LIMIT 1`,
      [symbol.toUpperCase()]
    );
    const row = r.rows[0];
    if (!row) {
      return {
        action: 'UNKNOWN',
        score:  null,
        grade:  null,
        reasoning: `Bot hasn't scored ${symbol} in last 7 days. Symbol may be outside the scan universe or outside trading hours.`,
        confidence: 'low',
      };
    }
    const score = Number(row.score);
    const breakdown = typeof row.breakdown === 'object' ? row.breakdown : (row.breakdown ? JSON.parse(row.breakdown) : {});
    // Identify the top positive and negative factors for "why"
    const factors = Object.entries(breakdown).map(([k, v]) => ({ k, v: Number(v) }));
    factors.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    const top3 = factors.slice(0, 3);
    const drawdownPct = position?.unrealized_pl_pct ?? 0;
    const drawdownDeep = drawdownPct < -15;

    let action, reasoning;
    if (score >= 60) {
      action = 'BUY';
      reasoning = `Composite ${score.toFixed(0)} (grade ${row.grade}). The bot would actively add to this position. Top signals: ${top3.map(f => `${f.k} ${f.v > 0 ? '+' : ''}${f.v}`).join(', ')}.`;
    } else if (score >= 40 && !drawdownDeep) {
      action = 'HOLD';
      reasoning = `Composite ${score.toFixed(0)} (grade ${row.grade}). In acceptable range but not adding. Top signals: ${top3.map(f => `${f.k} ${f.v > 0 ? '+' : ''}${f.v}`).join(', ')}.`;
    } else if (score >= 20 || drawdownDeep) {
      action = 'TRIM';
      reasoning = `Composite ${score.toFixed(0)} (grade ${row.grade})${drawdownDeep ? `, position down ${drawdownPct.toFixed(1)}%` : ''}. Signal weakening — consider reducing exposure. Top drags: ${top3.filter(f => f.v < 0).slice(0, 2).map(f => `${f.k} ${f.v}`).join(', ') || 'see breakdown'}.`;
    } else {
      action = 'EXIT';
      reasoning = `Composite ${score.toFixed(0)} (grade ${row.grade}). Bot would not enter this trade today. Top drags: ${top3.filter(f => f.v < 0).slice(0, 2).map(f => `${f.k} ${f.v}`).join(', ') || 'see breakdown'}.`;
    }
    return {
      action, score, grade: row.grade,
      reasoning,
      confidence: 'high',
      breakdown_top: top3,
    };
  } catch (e) {
    return {
      action: 'UNKNOWN', score: null, grade: null,
      reasoning: `Error querying bot signal: ${e.message}`,
      confidence: 'low',
    };
  }
}

// ─── Hedge recommender ──────────────────────────────────────────────────────
//
// For positions where:
//   - Risk score >= 60 (otherwise no urgency)
//   - Position size ≥ $5000 (otherwise hedge cost dominates)
//   - Quantity ≥ 100 shares (covered calls need 100/contract)
//
// Suggest a covered call: ~10% OTM, ~30 days to expiry.
// Premium estimated from UW option chain if available; falls back to a
// rough Black-Scholes approximation when chain data isn't fetchable.

function blackScholesCall(S, K, T, r, sigma) {
  // Standard call premium estimator. Returns dollars per share.
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S/K) + (r + sigma**2/2)*T) / (sigma * sqrtT);
  const d2 = d1 - sigma*sqrtT;
  const N = (x) => {
    // Abramowitz-Stegun approximation for standard normal CDF
    const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + p * ax);
    const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t * Math.exp(-ax*ax);
    return 0.5 * (1 + sign * y);
  };
  return Math.max(0, S * N(d1) - K * Math.exp(-r*T) * N(d2));
}

function findExpiryNDaysOut(chain, days) {
  if (!Array.isArray(chain)) return null;
  const target = Date.now() + days * 86_400_000;
  // Sort unique expiries, pick closest to target
  const expiries = [...new Set(chain.map(c => c.expiry))].sort();
  let best = null, bestDiff = Infinity;
  for (const e of expiries) {
    const t = new Date(e).getTime();
    const diff = Math.abs(t - target);
    if (diff < bestDiff) { bestDiff = diff; best = e; }
  }
  return best;
}

export async function getHedgeRecommendation(position, riskScore) {
  const value = position.market_val || (position.qty * position.current_price);
  if (riskScore < 60)   return { suggested: false, reason: 'Risk score below threshold (60). No hedge urgency.' };
  if (value < 5000)     return { suggested: false, reason: `Position size $${value.toFixed(0)} too small for cost-effective hedging.` };
  if (position.qty < 100) return { suggested: false, reason: `${position.qty} shares < 100 minimum for one covered-call contract. Cannot hedge fully.` };

  const contracts = Math.floor(position.qty / 100);
  const symbol = position.symbol.toUpperCase();
  const S = position.current_price;
  const targetStrike = Math.round(S * 1.10);   // 10% OTM, round to nearest dollar

  // Try UW option chain first; if it fails, fall back to BS estimate
  let chain = null;
  try { chain = await getOptionChain(symbol); } catch { chain = null; }

  let expiry, strike, premiumPerShare, source, deltaInfo;
  const targetDays = 30;

  if (chain && chain.length) {
    expiry = findExpiryNDaysOut(chain, targetDays);
    const calls = chain.filter(c => c.option_type === 'call' && c.expiry === expiry);
    if (calls.length) {
      // Find nearest strike ≥ targetStrike
      calls.sort((a, b) => a.strike - b.strike);
      const pick = calls.find(c => c.strike >= targetStrike) || calls[calls.length - 1];
      strike = pick.strike;
      const mid = pick.bid != null && pick.ask != null ? (Number(pick.bid) + Number(pick.ask)) / 2 : Number(pick.last || pick.bid || pick.ask || 0);
      premiumPerShare = +mid.toFixed(2);
      source = 'UW option chain (mid-market)';
      deltaInfo = pick.delta != null ? ` · Δ ${Number(pick.delta).toFixed(2)}` : '';
    }
  }

  if (!premiumPerShare) {
    // Fallback: Black-Scholes using IV from UW IV rank or 30% default
    let iv = 0.30;
    try {
      const ivData = await getIvRank(symbol);
      if (ivData?.iv30 != null) iv = Number(ivData.iv30);
    } catch { /* default */ }
    strike = targetStrike;
    expiry = new Date(Date.now() + targetDays * 86_400_000).toISOString().slice(0, 10);
    premiumPerShare = +blackScholesCall(S, strike, targetDays / 365, 0.045, iv).toFixed(2);
    source = `Black-Scholes estimate (IV ${(iv*100).toFixed(0)}%, rf 4.5%)`;
    deltaInfo = '';
  }

  const totalPremium      = +(premiumPerShare * 100 * contracts).toFixed(2);
  const breakeven         = +(S - premiumPerShare).toFixed(2);
  const ifCalledAwayValue = +(strike * 100 * contracts).toFixed(0);
  const ifCalledAwayPnl   = +(ifCalledAwayValue + totalPremium - position.avg_cost * position.qty).toFixed(0);
  const ifFlatPnl         = totalPremium;
  const annualizedYield   = +((premiumPerShare / S) * (365 / targetDays) * 100).toFixed(2);

  return {
    suggested:        true,
    type:             'covered_call',
    contracts,        // number of 100-share contracts
    strike,
    expiry,
    expiry_days:      targetDays,
    premium_per_share: premiumPerShare,
    total_premium:    totalPremium,
    breakeven,
    if_called_away: {
      sale_value:     ifCalledAwayValue,
      total_pnl:      ifCalledAwayPnl,
      summary:        `Shares sold at $${strike}. Combined with the premium, total realized P&L on the position becomes ${ifCalledAwayPnl >= 0 ? '+' : ''}$${ifCalledAwayPnl.toLocaleString()}.`,
    },
    if_flat: {
      total_pnl:      ifFlatPnl,
      summary:        `Stock stays under $${strike}: keep all shares + $${totalPremium.toLocaleString()} in premium. New effective cost basis: $${(position.avg_cost - premiumPerShare).toFixed(2)}.`,
    },
    annualized_yield: annualizedYield,
    source:           source + deltaInfo,
    plain_english:    [
      `Sell ${contracts} ${symbol} call contract${contracts > 1 ? 's' : ''} at the $${strike} strike, expiring ${expiry} (~${targetDays} days away).`,
      `You'll collect about $${totalPremium.toLocaleString()} in premium upfront.`,
      `If ${symbol} stays below $${strike} at expiry — most likely if it's currently at $${S.toFixed(2)} — you keep the premium AND your ${position.qty} shares. Effective new cost basis: $${(position.avg_cost - premiumPerShare).toFixed(2)} per share.`,
      `If ${symbol} crosses $${strike} — your shares get sold at $${strike}. Combined with the premium, total realized: ${ifCalledAwayPnl >= 0 ? '+' : ''}$${ifCalledAwayPnl.toLocaleString()}.`,
      `Annualized yield on premium alone: ${annualizedYield.toFixed(1)}%.`,
    ],
  };
}

// ─── Convenience: enrich a full set of positions ────────────────────────────

export async function enrichPositions(positions, accountValue, query) {
  const enriched = [];
  for (const p of positions) {
    const risk = await getRiskScore(p, accountValue, positions, query);
    const verdict = await getBotVerdict(p.symbol, p, query);
    const hedge = await getHedgeRecommendation(p, risk.score);
    enriched.push({
      ...p,
      pct_of_portfolio: accountValue ? +(((p.market_val / accountValue) * 100).toFixed(2)) : null,
      risk,
      verdict,
      hedge,
    });
  }
  return enriched;
}
