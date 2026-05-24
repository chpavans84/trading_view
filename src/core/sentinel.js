// MUST be first — populates ANTHROPIC_API_KEY from .env if shell shadowed it as empty
import './env-loader.js';
/**
 * Pre-Close Sentinel — scans portfolio for upcoming risk events,
 * emails a brief, and stages one-click-confirm trade proposals.
 *
 * Architecture rules:
 *  1. Node code builds all facts and proposals (tickers, dates, prices, qty).
 *  2. Claude writes prose only — never invents or parses numbers.
 *  3. LLM output is never parsed to extract trade parameters.
 */

import crypto       from 'crypto';
import { Resend }   from 'resend';
import { alert as sysAlert } from './system-alerts.js';
import Anthropic    from '@anthropic-ai/sdk';
import YahooFinance from 'yahoo-finance2';

import { getPositions as getAlpacaPositions, getLatestPrice } from './trader.js';
import { getPositions as getMoomooPositions }                  from './moomoo-tcp.js';
import { getBzNews }                                           from './benzinga.js';
import { getMarketContext }                                    from './market-context.js';
import { SECTOR_MAP }                                         from './sentiment.js';
import { getOptionsFlow, getInsiderTrades, getCongressionalTrades, getEconomicCalendar, isUWConfigured } from './unusual-whales.js';
import {
  query, isDbAvailable,
  insertSentinelRun, insertPendingAction, getSentinelRecipients,
} from './db.js';

const yf         = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });
const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Secret validation ────────────────────────────────────────────────────────
// Fail loud at module load rather than silently sign with a weak default.
const _signingSecret = (() => {
  const s = process.env.ACTION_SIGNING_SECRET;
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === 'test') return 'test-secret-not-for-production';
    throw new Error(
      'ACTION_SIGNING_SECRET must be set (>=32 chars). ' +
      'Generate with: openssl rand -hex 32'
    );
  }
  return s;
})();

// ─── PUBLIC_URL validation ────────────────────────────────────────────────────
// Fail loud so every email action link is never silently broken.
const _PLACEHOLDER_URLS = new Set([
  'https://your-dashboard.example.com',
  'https://example.com',
  'https://your-domain.example.com',
  '',
]);
export const PUBLIC_URL = (() => {
  const raw = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (process.env.NODE_ENV === 'test') return raw || 'http://localhost:3000';
  if (_PLACEHOLDER_URLS.has(raw)) {
    throw new Error(
      'PUBLIC_URL is unset or still using the placeholder. ' +
      'Set it to your real dashboard URL in .env so email action links work.'
    );
  }
  try { new URL(raw); } catch {
    throw new Error(`PUBLIC_URL must be a valid URL, got: ${raw}`);
  }
  if (!raw.startsWith('https://') &&
      !raw.startsWith('http://localhost') &&
      !raw.startsWith('http://127.0.0.1')) {
    throw new Error(`PUBLIC_URL must use https:// (or http:// for localhost), got: ${raw}`);
  }
  return raw;
})();

// ─── Macro event calendar — static fallback + dynamic UW source ──────────────
// sectors_at_risk uses the same ETF keys as SECTOR_MAP values (XLK, SOXX, etc.)
const MACRO_EVENTS_STATIC = [
  { date: '2026-06-11', name: 'CPI Release',       sectors_at_risk: ['XLK', 'SOXX', 'XLY'] },
  { date: '2026-06-18', name: 'FOMC Decision',     sectors_at_risk: ['XLF', 'XLK', 'XLY', 'SOXX'] },
  { date: '2026-07-02', name: 'NFP Report',        sectors_at_risk: ['XLF', 'XLY', 'XLP'] },
  { date: '2026-07-15', name: 'CPI Release',       sectors_at_risk: ['XLK', 'SOXX', 'XLY'] },
  { date: '2026-07-30', name: 'FOMC Decision',     sectors_at_risk: ['XLF', 'XLK', 'XLY', 'SOXX'] },
  { date: '2026-08-06', name: 'NFP Report',        sectors_at_risk: ['XLF', 'XLY', 'XLP'] },
  { date: '2026-09-16', name: 'FOMC Decision',     sectors_at_risk: ['XLF', 'XLK', 'XLY', 'SOXX'] },
];

// Keyword → ETF bucket mapping for UW economic calendar events
const _MACRO_KEYWORD_MAP = [
  { kw: 'cpi',       etfs: ['XLK', 'SOXX', 'XLY'] },
  { kw: 'inflation', etfs: ['XLK', 'SOXX', 'XLY'] },
  { kw: 'fomc',      etfs: ['XLF', 'XLK', 'XLY', 'SOXX'] },
  { kw: 'federal',   etfs: ['XLF', 'XLK', 'XLY', 'SOXX'] },
  { kw: 'nfp',       etfs: ['XLF', 'XLY', 'XLP'] },
  { kw: 'payroll',   etfs: ['XLF', 'XLY', 'XLP'] },
  { kw: 'gdp',       etfs: ['XLF', 'XLY', 'XLP', 'XLI'] },
  { kw: 'pce',       etfs: ['XLK', 'XLY', 'XLF'] },
];

async function getMacroEvents() {
  if (!isUWConfigured()) return MACRO_EVENTS_STATIC;
  try {
    const result = await getEconomicCalendar();
    // getEconomicCalendar returns an array, not { events: [...] }
    if (!Array.isArray(result) || !result.length) return MACRO_EVENTS_STATIC;
    const dynamic = result.map(ev => {
      const title = (ev.event || '').toLowerCase();
      const match = _MACRO_KEYWORD_MAP.find(m => title.includes(m.kw));
      return {
        date: ev.time ? toYMD(ev.time) : null,
        name: ev.event || 'Economic Event',
        sectors_at_risk: match ? match.etfs : ['XLF', 'XLK'],
      };
    }).filter(ev => ev.date);
    return dynamic.length ? dynamic : MACRO_EVENTS_STATIC;
  } catch {
    return MACRO_EVENTS_STATIC;
  }
}

// ─── Trading day helpers ──────────────────────────────────────────────────────

function isWeekday(d) {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

function addTradingDays(date, n) {
  const d = new Date(date);
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    if (isWeekday(d)) added++;
  }
  return d;
}

function tradingDaysUntil(futureDate) {
  const now    = new Date();
  const target = new Date(futureDate);
  if (target <= now) return 0;
  let count = 0;
  const d = new Date(now);
  while (d < target) {
    d.setDate(d.getDate() + 1);
    if (isWeekday(d)) count++;
  }
  return count;
}

function toYMD(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function etNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

// ─── Token signing ────────────────────────────────────────────────────────────

export function signToken(id, symbol, qty) {
  return crypto.createHmac('sha256', _signingSecret)
    .update(`${id}:${symbol}:${qty}`)
    .digest('hex');
}

export function verifyToken(stored, provided) {
  try {
    const a = Buffer.from(stored,   'hex');
    const b = Buffer.from(provided, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// ─── Risk signal detectors ────────────────────────────────────────────────────

function getDrawdownRisk(symbol, unrealizedPlPct) {
  const pct = parseFloat(unrealizedPlPct ?? 0);
  if (pct >= -5) return null;
  return {
    unrealized_pl_pct: +pct.toFixed(2),
    severity: pct <= -10 ? 'high' : 'med',
  };
}

async function getEarningsRisk(symbol) {
  try {
    const cal   = await yf.quoteSummary(symbol, { modules: ['calendarEvents'] }, { validateResult: false });
    const dates = cal?.calendarEvents?.earnings?.earningsDate ?? [];
    if (!dates.length) return null;
    const next  = new Date(dates[0]);
    const days  = tradingDaysUntil(next);
    if (days > 5) return null;
    const severity = days <= 2 ? 'high' : 'med';
    return { next_earnings_date: toYMD(next), trading_days_away: days, severity };
  } catch { return null; }
}

async function getNewsRisk(symbol) {
  try {
    const result   = await getBzNews({ symbol, limit: 5 });
    const articles = result?.articles ?? result ?? [];
    const cutoff   = Date.now() - 24 * 3600_000;
    const recent   = articles.filter(a => new Date(a.published_at || a.published || 0) >= cutoff);
    if (!recent.length) return null;
    const headlines = recent.slice(0, 3).map(a => a.title);
    // Negative keywords elevate severity
    const negText = headlines.join(' ').toLowerCase();
    const isNeg   = /miss|lower|cut|warning|recall|fraud|investigation|decline|loss|below/.test(negText);
    return { headlines, count: recent.length, severity: isNeg ? 'high' : 'med' };
  } catch { return null; }
}

async function getCalibrationRisk(symbol, unrealizedPlPct) {
  if (!isDbAvailable()) return null;
  try {
    const { rows } = await query(
      `SELECT feature, value FROM prediction_calibration WHERE symbol = $1`,
      [symbol.toUpperCase()]
    );
    if (!rows.length) return null;

    const byFeature  = Object.fromEntries(rows.map(r => [r.feature, parseFloat(r.value)]));
    const dirAcc     = byFeature['dir_accuracy'] ?? null;
    const recentMove = unrealizedPlPct ?? 0;

    if (dirAcc === null) return null;
    if (dirAcc < 0.35 && recentMove > 20) {
      return {
        dir_accuracy:     dirAcc,
        recent_move_pct:  recentMove,
        severity:         dirAcc < 0.30 && recentMove > 25 ? 'high' : 'med',
      };
    }
    return null;
  } catch { return null; }
}

function getSectorConcentrationRisks(positions) {
  const totalValue = positions.reduce((s, p) => s + (p.market_value ?? 0), 0);
  if (totalValue <= 0) return [];

  const bySector = {};
  for (const p of positions) {
    const sector = SECTOR_MAP[p.symbol] || 'Other';
    bySector[sector] = (bySector[sector] || 0) + (p.market_value ?? 0);
  }

  const risks = [];
  for (const [sector, value] of Object.entries(bySector)) {
    const pct = (value / totalValue) * 100;
    if (pct > 40) {
      risks.push({
        sector,
        concentration_pct: +pct.toFixed(1),
        severity: pct > 50 ? 'high' : 'med',
      });
    }
  }
  return risks;
}

async function getMacroRisks(positions, mode) {
  const today     = etNow();
  const lookahead = mode === 'weekend' ? 5 : 2;
  const cutoff    = addTradingDays(today, lookahead);
  const risks     = [];

  const events = await getMacroEvents();
  for (const ev of events) {
    const evDate = new Date(ev.date);
    if (evDate < today || evDate > cutoff) continue;
    const affected = positions.filter(p => ev.sectors_at_risk.includes(SECTOR_MAP[p.symbol] || ''));
    if (!affected.length) continue;
    risks.push({
      event:            ev.name,
      event_date:       ev.date,
      affected_symbols: affected.map(p => p.symbol),
      severity:         'med',
    });
  }
  return risks;
}

// ─── UW-driven risk detectors ─────────────────────────────────────────────────

async function getUnusualOptionsRisk(symbol) {
  if (!isUWConfigured()) return null;
  try {
    // getOptionsFlow returns an array directly, not { flow: [...] }
    const flow = await getOptionsFlow({ ticker: symbol, limit: 20 });
    if (!Array.isArray(flow) || !flow.length) return null;
    const bearish = flow.filter(f => (f.sentiment || '').toLowerCase() === 'bearish');
    const bullish = flow.filter(f => (f.sentiment || '').toLowerCase() === 'bullish');
    const totalPremium = flow.reduce((s, f) => s + parseFloat(f.total_premium || 0), 0);
    if (totalPremium < 500_000 && flow.length < 5) return null; // below noise floor
    const bearishRatio = flow.length > 0 ? bearish.length / flow.length : 0;
    const severity = bearishRatio >= 0.7 && totalPremium >= 2_000_000 ? 'high' : 'med';
    return {
      flow_count:      flow.length,
      bearish_count:   bearish.length,
      bullish_count:   bullish.length,
      bearish_ratio:   +bearishRatio.toFixed(2),
      total_premium:   totalPremium,
      severity,
    };
  } catch { return null; }
}

async function getInsiderSellingRisk(symbol) {
  if (!isUWConfigured()) return null;
  try {
    // getInsiderTrades returns an array directly; uses days=30 default filter internally
    const trades = await getInsiderTrades({ ticker: symbol });
    if (!Array.isArray(trades) || !trades.length) return null;
    // `side` is 'sell' (negative amount) or 'buy' (positive amount); `amount` is dollar value
    const sells = trades.filter(t => t.side === 'sell');
    const buys  = trades.filter(t => t.side === 'buy');
    const sellValue = sells.reduce((s, t) => s + Math.abs(t.amount ?? 0), 0);
    if (sells.length === 0 || sellValue < 100_000) return null;
    const severity = sells.length >= 3 || sellValue >= 1_000_000 ? 'high' : 'med';
    return {
      sell_count:  sells.length,
      buy_count:   buys.length,
      sell_value:  sellValue,
      recent_days: 30,
      severity,
    };
  } catch { return null; }
}

async function getCongressionalActivityRisk(symbol) {
  if (!isUWConfigured()) return null;
  try {
    const result = await getCongressionalTrades({ ticker: symbol, limit: 20 });
    if (!Array.isArray(result) || !result.length) return null;
    const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // last 60 days
    const recent = result.filter(t => t.transaction_date && new Date(t.transaction_date) >= cutoff);
    if (!recent.length) return null;
    const sells = recent.filter(t => {
      const txn = (t.transaction_type || '').toLowerCase();
      return txn.includes('sell') || txn.includes('sale');
    });
    if (sells.length < 2) return null; // single sell not significant
    return {
      sell_count:  sells.length,
      total_count: recent.length,
      members:     [...new Set(sells.map(t => t.member_name).filter(Boolean))],
      severity:    sells.length >= 3 ? 'high' : 'med',
    };
  } catch { return null; }
}

// ─── Proposal builder (deterministic — no LLM) ───────────────────────────────

async function buildProposals(risks, positions, totalValue) {
  const proposals = [];
  if (!isDbAvailable()) return proposals;

  const publicUrl = PUBLIC_URL;

  for (const risk of risks) {
    if (risk.severity !== 'high') continue;

    const pos = positions.find(p => p.symbol === risk.symbol);
    if (!pos) continue;

    const posValue   = pos.market_value ?? 0;
    const posPct     = totalValue > 0 ? (posValue / totalValue) * 100 : 0;
    let   proposal   = null;

    // Earnings within 2 trading days + position > 5% of portfolio → trim to 5%
    if (risk.type === 'earnings' && risk.detail?.trading_days_away <= 2 && posPct > 5) {
      const targetValue = totalValue * 0.05;
      const trimValue   = posValue - targetValue;
      if (trimValue > 0 && pos.current_price > 0) {
        const qty         = Math.floor(trimValue / pos.current_price);
        const limit_price = +(pos.current_price * 0.995).toFixed(2); // 0.5% below market
        if (qty >= 1) {
          proposal = { side: 'trim', qty, limit_price, stop_price: null,
            reason: `Earnings in ${risk.detail.trading_days_away} trading day(s) — trim from ${posPct.toFixed(1)}% to 5% of portfolio` };
        }
      }
    }

    // Calibration warning (dir_accuracy < 0.30 AND > +25%) + position > 3% → trim to 3%
    if (!proposal && risk.type === 'calibration' &&
        risk.detail?.dir_accuracy < 0.30 && risk.detail?.recent_move_pct > 25 && posPct > 3) {
      const targetValue = totalValue * 0.03;
      const trimValue   = posValue - targetValue;
      if (trimValue > 0 && pos.current_price > 0) {
        const qty         = Math.floor(trimValue / pos.current_price);
        const limit_price = +(pos.current_price * 0.995).toFixed(2);
        if (qty >= 1) {
          proposal = { side: 'trim', qty, limit_price, stop_price: null,
            reason: `Low model accuracy (${(risk.detail.dir_accuracy * 100).toFixed(0)}% dir.) with +${risk.detail.recent_move_pct.toFixed(0)}% move — trim to 3%` };
        }
      }
    }

    // News high-severity + unrealized gain > +15% → tighten stop to entry + 50% of gain
    if (!proposal && risk.type === 'news' && (pos.unrealized_pl_pct ?? 0) > 15) {
      const entry     = pos.avg_cost ?? pos.avg_entry_price ?? pos.current_price;
      const cur       = pos.current_price;
      const gain      = cur - entry;
      const stopPrice = +(entry + gain * 0.5).toFixed(2);
      const limPrice  = +(stopPrice * 0.995).toFixed(2);
      const qty       = Math.floor(pos.qty);
      if (qty >= 1 && stopPrice > entry) {
        proposal = { side: 'tighten_stop', qty, limit_price: limPrice, stop_price: stopPrice,
          reason: `Negative news with +${pos.unrealized_pl_pct.toFixed(1)}% unrealized gain — tighten stop to lock in 50% of gain` };
      }
    }

    // Drawdown ≥ 10% → trim 50% of position to cut loss
    if (!proposal && risk.type === 'drawdown' && (risk.detail?.unrealized_pl_pct ?? 0) <= -10) {
      if (pos.current_price > 0) {
        const trimQty  = Math.floor(pos.qty * 0.5);
        const limPrice = +(pos.current_price * 0.995).toFixed(2);
        if (trimQty >= 1) {
          proposal = { side: 'sell', qty: trimQty, limit_price: limPrice, stop_price: null,
            reason: `Position down ${risk.detail.unrealized_pl_pct}% — trim 50% to reduce loss exposure` };
        }
      }
    }

    // Sector concentration > 50% → trim largest in sector by 25%
    if (!proposal && risk.type === 'concentration' && risk.detail?.concentration_pct > 50) {
      const sector   = risk.detail.sector;
      const inSector = positions.filter(p => (SECTOR_MAP[p.symbol] || 'Other') === sector)
        .sort((a, b) => (b.market_value ?? 0) - (a.market_value ?? 0));
      const largest  = inSector[0];
      if (largest && largest.current_price > 0) {
        const trimQty  = Math.floor(largest.qty * 0.25);
        const limPrice = +(largest.current_price * 0.995).toFixed(2);
        if (trimQty >= 1) {
          proposal = { side: 'trim', qty: trimQty, limit_price: limPrice, stop_price: null,
            reason: `Sector ${sector} is ${risk.detail.concentration_pct}% of portfolio — trim largest position (${largest.symbol}) by 25%`,
            symbol_override: largest.symbol };
        }
      }
    }

    if (!proposal) continue;

    const sym     = proposal.symbol_override ?? risk.symbol;
    const broker  = pos.broker ?? 'alpaca';
    const expiresAt = new Date(Date.now() + 30 * 60_000); // 30 minutes

    const id    = await insertPendingAction({
      symbol: sym, broker, side: proposal.side, qty: proposal.qty,
      limit_price: proposal.limit_price, stop_price: proposal.stop_price,
      reason: proposal.reason, severity: 'high',
      signed_token: 'pending', // placeholder — updated below with real id
      expires_at: expiresAt,
    });

    if (!id) continue;

    const token     = signToken(id, sym, proposal.qty);
    // Update the row with the real signed token
    await query(`UPDATE pending_actions SET signed_token = $1 WHERE id = $2`, [token, id]);

    proposals.push({
      id,
      symbol:      sym,
      side:        proposal.side,
      qty:         proposal.qty,
      limit_price: proposal.limit_price,
      stop_price:  proposal.stop_price,
      reason:      proposal.reason,
      execute_url: `${publicUrl}/api/action/execute/${id}?token=${token}`,
      ignore_url:  `${publicUrl}/api/action/ignore/${id}?token=${token}`,
    });
  }

  return proposals;
}

// ─── Merge positions from both brokers ───────────────────────────────────────

async function fetchAllPositions() {
  const [alpacaRes, moomooRes] = await Promise.allSettled([
    getAlpacaPositions(),
    getMoomooPositions(),
  ]);

  const alpacaPos = (alpacaRes.status === 'fulfilled' ? alpacaRes.value : [])
    .map(p => ({
      symbol:           p.symbol,
      qty:              parseFloat(p.qty),
      avg_cost:         parseFloat(p.avg_entry_price),
      market_value:     parseFloat(p.market_value),
      current_price:    parseFloat(p.current_price ?? p.avg_entry_price),
      unrealized_pl_pct: parseFloat(p.unrealized_pl_pct ?? 0),
      broker:           'alpaca',
    }));

  const moomooPos = (moomooRes.status === 'fulfilled'
    ? (moomooRes.value?.positions ?? moomooRes.value ?? [])
    : []
  ).map(p => ({
    symbol:            p.symbol,
    qty:               parseFloat(p.qty),
    avg_cost:          parseFloat(p.avg_cost ?? p.costPrice ?? 0),
    market_value:      parseFloat(p.market_val ?? p.val ?? 0),
    current_price:     parseFloat(p.current_price ?? p.price ?? p.avg_cost ?? 0),
    unrealized_pl_pct: parseFloat(p.unrealized_pl_pct ?? 0),
    broker:            'moomoo',
  }));

  return [...alpacaPos, ...moomooPos];
}

// ─── Claude prose generation ──────────────────────────────────────────────────

async function generateProse(facts) {
  // Trim to <= 4k tokens: keep only risky positions + top-5 by value
  const riskySymbols = new Set(facts.risks.map(r => r.symbol).filter(Boolean));
  const positions    = facts.portfolio.positions ?? [];
  const sorted       = [...positions].sort((a, b) => (b.market_value ?? 0) - (a.market_value ?? 0));
  const included     = [
    ...sorted.filter(p => riskySymbols.has(p.symbol)),
    ...sorted.filter(p => !riskySymbols.has(p.symbol)).slice(0, 5),
  ];
  // Deduplicate
  const seen   = new Set();
  const trimmedPositions = included.filter(p => { if (seen.has(p.symbol)) return false; seen.add(p.symbol); return true; });

  const trimmedFacts = { ...facts, portfolio: { ...facts.portfolio, positions: trimmedPositions } };

  const msg = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1200,
    system: `You write pre-close trading risk briefs. Be terse. Use bullet points.
Never invent or modify tickers, dates, prices, or quantities — only use what is in the input JSON.
Output plain HTML email body: <h2>, <ul>, <li>, <p>, <a> tags only. No <html> wrapper.
For each proposal in input.proposals, render its [Execute] and [Ignore] links exactly as given in execute_url and ignore_url.
If input.risks is empty, output: <p>✅ All clear — no risk events flagged today.</p>`,
    messages: [{
      role:    'user',
      content: `Here are the sentinel facts. Write the email body.\n\n${JSON.stringify(trimmedFacts, null, 2)}`,
    }],
  });

  return msg.content[0]?.text ?? '<p>Unable to generate brief.</p>';
}

// ─── Email sender ─────────────────────────────────────────────────────────────

async function sendSentinelEmail(subject, htmlBody) {
  const apiKey = process.env.RESEND_API;
  const from   = process.env.RESEND_FROM || 'info@dlpinnovations.com';
  if (!apiKey) {
    console.warn('[sentinel] RESEND_API not configured — email skipped');
    return false;
  }

  // Build recipient list from registered users; fall back to ALERT_EMAIL
  let recipients = await getSentinelRecipients();
  if (!recipients.length) {
    const fallback = process.env.ALERT_EMAIL || 'info@trading.dlpinnovations.com';
    recipients = [{ username: 'admin', email: fallback }];
  }

  const resend    = new Resend(apiKey);
  const html      = `<div style="font-family:sans-serif;max-width:680px;margin:0 auto;color:#1a1a2e">${htmlBody}</div>`;
  let   sentCount = 0;

  for (const { username, email } of recipients) {
    try {
      await resend.emails.send({ from: `Pre-Close Sentinel <${from}>`, to: email, subject, html });
      console.log(`[sentinel] email sent: ${subject} → ${email} (${username})`);
      sentCount++;
    } catch (err) {
      console.error(`[sentinel] email failed for ${email}:`, err.message);
    }
  }

  return sentCount > 0;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runSentinel({ mode = 'preclose' } = {}) {
  const asOf = new Date().toISOString();
  let facts  = null;
  let emailSent = false;
  let runError  = null;

  try {
    // 1. Fetch positions from both brokers
    const positions = await fetchAllPositions();
    const totalValue = positions.reduce((s, p) => s + (p.market_value ?? 0), 0);

    // 2. Market context (VIX, SPY change)
    const ctx    = await getMarketContext().catch(() => null);
    const vix    = ctx?.vix ?? null;
    const spyChg = ctx?.spy_change_pct ?? null;

    // 3. Gather risk signals for each position in parallel
    const riskRows = [];

    const [earningsResults, newsResults, calibrationResults, uwFlowResults, uwInsiderResults, uwCongressResults] = await Promise.all([
      Promise.allSettled(positions.map(p => getEarningsRisk(p.symbol))),
      Promise.allSettled(positions.map(p => getNewsRisk(p.symbol))),
      Promise.allSettled(positions.map(p => getCalibrationRisk(p.symbol, p.unrealized_pl_pct))),
      Promise.allSettled(positions.map(p => getUnusualOptionsRisk(p.symbol))),
      Promise.allSettled(positions.map(p => getInsiderSellingRisk(p.symbol))),
      Promise.allSettled(positions.map(p => getCongressionalActivityRisk(p.symbol))),
    ]);

    positions.forEach((p, i) => {
      const earnings    = earningsResults[i].status    === 'fulfilled' ? earningsResults[i].value    : null;
      const news        = newsResults[i].status        === 'fulfilled' ? newsResults[i].value        : null;
      const calibration = calibrationResults[i].status === 'fulfilled' ? calibrationResults[i].value : null;
      const drawdown    = getDrawdownRisk(p.symbol, p.unrealized_pl_pct);
      const uwFlow      = uwFlowResults[i].status      === 'fulfilled' ? uwFlowResults[i].value      : null;
      const uwInsider   = uwInsiderResults[i].status   === 'fulfilled' ? uwInsiderResults[i].value   : null;
      const uwCongress  = uwCongressResults[i].status  === 'fulfilled' ? uwCongressResults[i].value  : null;

      if (earnings)   riskRows.push({ symbol: p.symbol, type: 'earnings',             detail: earnings,   severity: earnings.severity });
      if (news)       riskRows.push({ symbol: p.symbol, type: 'news',                 detail: news,       severity: news.severity });
      if (calibration)riskRows.push({ symbol: p.symbol, type: 'calibration',          detail: calibration,severity: calibration.severity });
      if (drawdown)   riskRows.push({ symbol: p.symbol, type: 'drawdown',             detail: drawdown,   severity: drawdown.severity });
      if (uwFlow)     riskRows.push({ symbol: p.symbol, type: 'unusual_options',      detail: uwFlow,     severity: uwFlow.severity });
      if (uwInsider)  riskRows.push({ symbol: p.symbol, type: 'insider_selling',      detail: uwInsider,  severity: uwInsider.severity });
      if (uwCongress) riskRows.push({ symbol: p.symbol, type: 'congressional_activity',detail: uwCongress,severity: uwCongress.severity });
    });

    // Sector concentration and macro risks (portfolio-level)
    for (const risk of getSectorConcentrationRisks(positions)) {
      riskRows.push({ symbol: null, type: 'concentration', detail: risk, severity: risk.severity });
    }
    for (const risk of await getMacroRisks(positions, mode)) {
      riskRows.push({ symbol: null, type: 'macro', detail: risk, severity: risk.severity });
    }

    // 4. Build proposals for high-severity risks
    const proposals = await buildProposals(riskRows, positions, totalValue);

    // 5. Assemble facts object
    facts = {
      mode,
      as_of: asOf,
      portfolio: {
        total_value:    +totalValue.toFixed(2),
        positions,
        alpaca_count:   positions.filter(p => p.broker === 'alpaca').length,
        moomoo_count:   positions.filter(p => p.broker === 'moomoo').length,
      },
      risks:          riskRows,
      market_context: { vix, spy_change_pct: spyChg },
      proposals,
    };

    // 6. Generate prose via Claude
    const htmlBody = await generateProse(facts);

    // 7. Build subject line
    const highCount  = riskRows.filter(r => r.severity === 'high').length;
    const totalRisks = riskRows.length;
    const dateLabel  = asOf.slice(0, 10);
    const subject    = `[Sentinel ${mode}] ${highCount} high-risk, ${totalRisks} total — ${dateLabel}`;

    // 8. Send email
    emailSent = await sendSentinelEmail(subject, htmlBody);

  } catch (err) {
    runError = err.message;
    console.error('[sentinel] run failed:', err.message);
    sysAlert({ key: 'sentinel/run-failed', severity: 'critical', title: 'Sentinel run failed', detail: { mode, error: err.message, stack: err.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }

  // 9. Log run to DB
  await insertSentinelRun({
    mode,
    as_of:         asOf,
    risks_json:    facts?.risks    ?? [],
    proposals_json: facts?.proposals ?? [],
    email_sent:    emailSent,
    error:         runError,
  }).catch(() => {});

  return { facts, email_sent: emailSent, error: runError };
}
