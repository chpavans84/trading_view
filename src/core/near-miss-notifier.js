/**
 * src/core/near-miss-notifier.js
 *
 * "Near-miss" reporter — surfaces stocks the bot SAW but didn't trade,
 * plus stocks the bot's universe filter never even considered. Designed
 * to keep the user in the loop on what's escaping the bot's gates so
 * tuning decisions are data-driven, not folk-wisdom.
 *
 * Three categories of miss:
 *
 *   TYPE 3 — Single-gate blocked
 *     Bot scored the stock highly but a single hard gate killed it
 *     (e.g. premarket gap > 8%, earnings within 3 days). Tuning candidates.
 *
 *   TYPE 4 — Outside universe (highest value)
 *     Bot never saw the stock — the universe builder filtered it out
 *     before scoring. CRDO is the canonical example. Captured via a
 *     wider re-scan that ignores the LIMIT/cap on UW flow alerts.
 *
 *   (TYPE 1 — outranked — and TYPE 2 — below-threshold — are NOT
 *    included: too noisy. The bot DID consider those and made a call.)
 *
 * Output: email digest (and optional Telegram top-3) via core/email.js.
 *
 * Cadence: cron-driven daily at 4:30 PM ET (after-close, results stable),
 *          plus admin endpoint POST /api/near-miss/run for ad-hoc.
 *
 * Cost: ~10-15 cheap DB queries. No external API calls. Sub-second runtime.
 */

import { query, isDbAvailable } from './db.js';
import { sendEmail, textToHtml } from './email.js';

// ─── Thresholds ──────────────────────────────────────────────────────────────
const TYPE3_MIN_SCORE     = 60;    // composite score that WOULD have qualified
const TYPE4_MIN_PREMIUM   = 500_000;  // bullish UW premium for outside-universe rescan
const TYPE4_MIN_RANK      = 250;   // beyond this rank, we don't care
const MAX_PER_REPORT      = 8;     // hard cap on total picks shown
const EXTENDED_MOVE_PCT   = 0.40;  // exclude if up >40% in 5 days (chase risk)
const EARNINGS_GUARD_DAYS = 2;     // skip if earnings within 2 days

// Broad-market ETFs + index proxies — never useful as near-miss alerts because
// the bot evaluates these every scan and the user is already aware of them.
const ALWAYS_EXCLUDE = new Set([
  'SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'EFA', 'EEM',         // index ETFs
  'SPX', 'SPXW', 'NDX', 'NDXW', 'RUT',                            // index options proxies
  'GLD', 'SLV', 'USO', 'TLT', 'IEF', 'HYG', 'LQD', 'TIP', 'XLF',  // commodity / bond / sector ETFs
  'IBIT', 'GBTC', 'ETHE',                                          // crypto ETFs
  'SQQQ', 'TQQQ', 'SOXL', 'SOXS', 'UPRO', 'SPXU', 'TZA', 'TNA',   // 3x leveraged ETFs
]);

// Mega-cap stocks the user almost certainly already tracks. Excluded from
// TYPE 4 alerts (not from TYPE 3 — a gate-blocked NVDA IS interesting).
const MEGA_CAP_EXCLUDE = new Set([
  'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'TSLA',
  'AVGO', 'ORCL', 'NFLX', 'AMD', 'CRM', 'ADBE',
]);

// ─── TYPE 3: stocks the bot blocked at a single gate ────────────────────────
/**
 * Returns recent bot_decisions where the bot would have bought except a
 * specific hard gate fired. Read from `notes` field where the engine logs
 * the rejection reason.
 *
 * Limit: 24-hour window so the digest stays fresh + relevant.
 */
async function findType3GateBlocked(windowHours = 24) {
  const { rows } = await query(
    `SELECT DISTINCT ON (symbol)
       symbol,
       composite_score,
       setup_type,
       notes,
       scanned_at
     FROM bot_decisions
     WHERE scanned_at > NOW() - ($1::int * INTERVAL '1 hour')
       AND symbol IS NOT NULL
       AND composite_score IS NOT NULL
       AND composite_score >= $2
       AND action LIKE 'skip_%'
       AND action <> 'skip_no_candidate'
       AND action <> 'skip_inflight'
       AND action <> 'skip_circuit_breaker'
     ORDER BY symbol, composite_score DESC
     LIMIT 50`,
    [windowHours, TYPE3_MIN_SCORE]
  );
  return rows.map(r => ({
    type: 3,
    symbol: r.symbol,
    score: Number(r.composite_score),
    setup_type: r.setup_type,
    reason: r.notes || 'gate blocked',
    scanned_at: r.scanned_at,
  }));
}

// ─── TYPE 4: stocks the bot's universe filter never let in ──────────────────
/**
 * Re-runs the universe query without the LIMIT 50 cap and finds high-bullish-
 * flow names that aren't already in bot_decisions from the past 6 hours.
 *
 * The crux of the CRDO bug — bot ranked at #108 by absolute premium, well
 * past the engine's old cap. This query bypasses that.
 */
async function findType4OutsideUniverse(windowHours = 24) {
  // 1. Find high-bullish-flow tickers in the lookback window
  const { rows: bullish } = await query(
    `SELECT u.ticker,
            SUM(u.premium)::numeric AS bull_premium,
            COUNT(*)::int AS alerts,
            ROW_NUMBER() OVER (ORDER BY SUM(u.premium) DESC) AS rank
     FROM uw_flow_alerts u
     WHERE u.alerted_at > NOW() - ($1::int * INTERVAL '1 hour')
       AND u.sentiment IN ('bullish', 'strong_bullish')
       AND u.premium >= 100000
     GROUP BY u.ticker
     HAVING SUM(u.premium) >= $2
     ORDER BY bull_premium DESC
     LIMIT $3`,
    [windowHours, TYPE4_MIN_PREMIUM, TYPE4_MIN_RANK]
  );

  if (!bullish.length) return [];

  // 2. Subtract anything the bot DID see (had a decision row) in last 6h
  const tickerList = bullish.map(r => r.ticker.toUpperCase());
  const { rows: seen } = await query(
    `SELECT DISTINCT symbol
     FROM bot_decisions
     WHERE scanned_at > NOW() - INTERVAL '6 hours'
       AND symbol = ANY($1)`,
    [tickerList]
  );
  const seenSet = new Set(seen.map(r => r.symbol.toUpperCase()));

  const candidates = bullish.filter(r => {
    const t = r.ticker.toUpperCase();
    return !seenSet.has(t) &&
           !ALWAYS_EXCLUDE.has(t) &&
           !MEGA_CAP_EXCLUDE.has(t);
  });
  if (!candidates.length) return [];

  // 3. Enrich each with recent price action + earnings proximity
  const enriched = await Promise.all(candidates.map(async (c) => {
    const [priceData, earnings] = await Promise.allSettled([
      _getPriceContext(c.ticker),
      _getDaysToEarnings(c.ticker),
    ]);
    const price = priceData.status === 'fulfilled' ? priceData.value : null;
    const days  = earnings.status  === 'fulfilled' ? earnings.value  : null;

    return {
      type: 4,
      symbol: c.ticker,
      bull_premium: Number(c.bull_premium),
      bull_alerts: c.alerts,
      rank: Number(c.rank),
      last_price:        price?.last  ?? null,
      five_day_return:   price?.fiveDayReturn ?? null,
      day_change_pct:    price?.dayChangePct  ?? null,
      next_earnings_days: days,
      // Flags
      already_extended:  price?.fiveDayReturn != null && price.fiveDayReturn > EXTENDED_MOVE_PCT,
      pre_earnings:      days != null && days >= 0 && days <= EARNINGS_GUARD_DAYS,
    };
  }));

  // 4. Filter out "too late" / "earnings imminent" — apply soft guardrails
  //    BUT still surface them with a warning flag so user can decide
  return enriched.filter(c => !c.pre_earnings);  // earnings is a hard skip
}

// ─── Helpers ────────────────────────────────────────────────────────────────
async function _getPriceContext(symbol) {
  const { rows } = await query(
    `SELECT price_date, close
     FROM backtest_prices
     WHERE symbol = $1
     ORDER BY price_date DESC
     LIMIT 6`,
    [symbol]
  );
  if (!rows.length) return null;
  const last = Number(rows[0].close);
  const prev = rows[1] ? Number(rows[1].close) : null;
  const fiveAgo = rows[5] ? Number(rows[5].close) : null;
  return {
    last,
    dayChangePct:  prev    ? (last - prev)    / prev    : null,
    fiveDayReturn: fiveAgo ? (last - fiveAgo) / fiveAgo : null,
  };
}

async function _getDaysToEarnings(symbol) {
  // bot_decisions stores `next_earnings_days` in factor_breakdown for recent
  // scans — read from there as a cheap proxy
  const { rows } = await query(
    `SELECT factor_breakdown -> 'indicators' -> 'earnings' ->> 'days_until' AS d
     FROM bot_decisions
     WHERE symbol = $1
       AND scanned_at > NOW() - INTERVAL '7 days'
       AND factor_breakdown IS NOT NULL
     ORDER BY scanned_at DESC
     LIMIT 1`,
    [symbol]
  );
  const d = rows[0]?.d;
  return d != null && !isNaN(d) ? Number(d) : null;
}

// ─── Ranking + report assembly ──────────────────────────────────────────────
/**
 * "Interestingness" score for TYPE 4 picks.
 *
 *   bull_premium × (1 + max(0, 5-day return))
 *
 * Rewards stocks that are BOTH attracting unusual options interest AND
 * actually moving. A $2.7M premium stock up 20% (CRDO) outranks a $87M
 * premium stock up 3% (MU) — which is what we want: MU is on everyone's
 * radar, CRDO isn't.
 *
 * Stocks with no recent price data fall back to bull_premium alone.
 */
function _interestingness(p) {
  const baseline = Number(p.bull_premium) || 0;
  const ret      = Number(p.five_day_return);
  if (!Number.isFinite(ret)) return baseline;
  // Only boost positive moves — falling stocks with bullish flow are usually
  // misclassified noise (someone buying a deep put as protection).
  return baseline * (1 + Math.max(0, ret));
}

function _rankPicks(type3, type4) {
  // TYPE 4 first (highest signal), then TYPE 3 sorted by score
  const t4 = type4
    .filter(p => !p.already_extended)
    .sort((a, b) => _interestingness(b) - _interestingness(a))
    .slice(0, 5);
  const t4chase = type4
    .filter(p => p.already_extended)
    .sort((a, b) => (b.five_day_return || 0) - (a.five_day_return || 0))
    .slice(0, 2);
  const t3 = type3.sort((a, b) => b.score - a.score).slice(0, 3);

  // Combine, cap at MAX_PER_REPORT
  return [...t4, ...t4chase, ...t3].slice(0, MAX_PER_REPORT);
}

function _formatPick(p) {
  if (p.type === 4) {
    const lines = [
      `🔍 ${p.symbol}`,
      `    UW bullish flow: ${p.bull_alerts} alerts, $${(p.bull_premium / 1_000_000).toFixed(2)}M premium (rank #${p.rank})`,
    ];
    if (p.last_price != null) {
      const move5 = p.five_day_return != null ? `${(p.five_day_return * 100).toFixed(1)}%` : 'n/a';
      const move1 = p.day_change_pct  != null ? `${(p.day_change_pct  * 100).toFixed(1)}%` : 'n/a';
      lines.push(`    Price: $${p.last_price.toFixed(2)}  |  Day: ${move1}  |  5-day: ${move5}`);
    }
    if (p.next_earnings_days != null && p.next_earnings_days >= 0) {
      lines.push(`    Next earnings: in ${p.next_earnings_days}d`);
    }
    if (p.already_extended) {
      lines.push(`    ⚠ Already up >40% in 5 days — chase risk; consider waiting for pullback`);
    }
    return lines.join('\n');
  }

  // TYPE 3
  const lines = [
    `🚫 ${p.symbol}  (would have scored ${p.score.toFixed(1)}, ${p.setup_type || 'setup unknown'})`,
    `    Blocked by: ${p.reason}`,
  ];
  return lines.join('\n');
}

function _formatReport(picks) {
  if (!picks.length) return '✓ No near-misses today — bot is catching the action.\n';

  const t4 = picks.filter(p => p.type === 4 && !p.already_extended);
  const t4chase = picks.filter(p => p.type === 4 && p.already_extended);
  const t3 = picks.filter(p => p.type === 3);

  const sections = [];

  if (t4.length) {
    sections.push(
      `━━━ Outside the bot's universe (worth a look) ━━━\n` +
      t4.map(_formatPick).join('\n\n')
    );
  }
  if (t4chase.length) {
    sections.push(
      `━━━ Already moved (too late to chase, but FYI) ━━━\n` +
      t4chase.map(_formatPick).join('\n\n')
    );
  }
  if (t3.length) {
    sections.push(
      `━━━ Bot scored high but single gate blocked (tuning candidates) ━━━\n` +
      t3.map(_formatPick).join('\n\n')
    );
  }

  return sections.join('\n\n');
}

// ─── Public: run the full report ─────────────────────────────────────────────
/**
 * Build the near-miss report. Returns { ok, picks, body, emailResult }.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.sendEmail=true]  whether to actually fire the email
 * @param {string}  [opts.to]              override recipient
 * @param {number}  [opts.windowHours=24]  lookback window for both scans
 */
export async function runNearMissReport(opts = {}) {
  const sendEmailFlag = opts.sendEmail !== false;
  const windowHours = Math.min(Math.max(Number(opts.windowHours) || 24, 1), 168);  // 1h .. 7d

  if (!isDbAvailable()) {
    return { ok: false, error: 'DB unavailable' };
  }

  try {
    const [type3, type4] = await Promise.all([
      findType3GateBlocked(windowHours),
      findType4OutsideUniverse(windowHours),
    ]);

    const picks = _rankPicks(type3, type4);
    const summary = {
      total: picks.length,
      type3_count: picks.filter(p => p.type === 3).length,
      type4_count: picks.filter(p => p.type === 4 && !p.already_extended).length,
      type4_chase_count: picks.filter(p => p.type === 4 && p.already_extended).length,
    };

    const dateStr = new Date().toISOString().split('T')[0];
    const windowLabel = windowHours <= 24 ? `last ${windowHours}h` : `last ${Math.round(windowHours / 24)}d`;
    const intro = picks.length
      ? `Scan window: ${windowLabel}\n\nThe bot didn't trade these names. Reasons + context below.\n\n`
      : `Scan window: ${windowLabel}\n\n`;
    const body = `📊 Bot Near-Miss Report — ${dateStr}\n\n${intro}${_formatReport(picks)}\n\n` +
                 `━━━ Summary ━━━\n` +
                 `Total picks: ${summary.total}\n` +
                 `  Outside universe: ${summary.type4_count}\n` +
                 `  Already-moved (chase risk): ${summary.type4_chase_count}\n` +
                 `  Gate-blocked: ${summary.type3_count}\n`;

    console.log(`[near-miss] report assembled — ${summary.total} picks (type4=${summary.type4_count}, type4_chase=${summary.type4_chase_count}, type3=${summary.type3_count})`);

    let emailResult = null;
    if (sendEmailFlag) {
      const to = opts.to || process.env.ALERT_EMAIL || process.env.SENTINEL_EMAIL_TO;
      if (!to) {
        console.warn('[near-miss] no recipient — set ALERT_EMAIL or pass opts.to');
      } else {
        emailResult = await sendEmail({
          to,
          subject: `📊 Near-Miss Report — ${summary.total} pick${summary.total === 1 ? '' : 's'} (${dateStr})`,
          html:    textToHtml(body, { title: `Bot Near-Miss Report — ${dateStr}` }),
          username: 'system',     // bypass per-user rate limit for cron-driven reports
        });
        if (emailResult.ok) {
          console.log(`[near-miss] email sent to ${to} (id=${emailResult.id})`);
        } else {
          console.warn(`[near-miss] email send failed: ${emailResult.error}`);
        }
      }
    }

    return { ok: true, picks, summary, body, emailResult };
  } catch (e) {
    console.error('[near-miss] report failed:', e.message);
    return { ok: false, error: e.message };
  }
}
