/**
 * Weekend Position Guardian
 * Monitors held positions from Friday close through Monday pre-market.
 * Alerts via Telegram + WhatsApp + email (info@trading.dlpinnovations.com).
 * All three fire in parallel on every alert — no fallback logic.
 *
 * Cron schedule (configured in server.js):
 *   Fri 3:30 PM ET  — checkEarningsRisk()
 *   Fri 6:00 PM ET  — checkAfterHoursMove()
 *   Sat 10:00 AM ET — checkAfterHoursMove()
 *   Mon 4:15 AM ET  — checkPreMarketHoldings()
 */

import YahooFinance from 'yahoo-finance2';
import { getPositions, getLivePositions, hasLiveAccount } from './trader.js';
import { sendTelegram, isTelegramConfigured } from './telegram.js';
import { sendWhatsAppAlert, isWhatsAppConfigured } from './whatsapp.js';
import { Resend } from 'resend';

const yf = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

// ─── Alert dispatch ────────────────────────────────────────────────────────────
// Sends to every configured channel in parallel; always logs regardless.

const _resend    = process.env.RESEND_API ? new Resend(process.env.RESEND_API) : null;
const RESEND_FROM = process.env.RESEND_FROM || 'noreply@dlpinnovations.com';
const GUARDIAN_EMAIL = 'info@trading.dlpinnovations.com';

async function _sendEmail(subject, text) {
  if (!_resend) {
    console.warn('[guardian] Resend not configured — email skipped');
    return { sent: false, reason: 'resend_not_configured' };
  }
  try {
    const html = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    await _resend.emails.send({
      from:    `Trading Bot <${RESEND_FROM}>`,
      to:      GUARDIAN_EMAIL,
      subject,
      html:    `<div style="font-family:monospace;font-size:14px;line-height:1.7;color:#e6edf3;background:#0d1117;padding:20px;border-radius:8px">${html}</div>`,
    });
    console.log(`[guardian] email sent → ${GUARDIAN_EMAIL}`);
    return { sent: true };
  } catch (e) {
    console.error('[guardian] email failed:', e.message);
    return { sent: false, error: e.message };
  }
}

async function sendAlert(message) {
  console.log('[guardian] ALERT:', message);

  const subject = `[Position Guardian] ${message.split('\n')[0].replace(/[^\w\s.%$@|:+-]/g, '').slice(0, 80)}`;

  // Fire all three channels in parallel — email always goes regardless of Telegram/WhatsApp
  const [tgResult, waResult, emailResult] = await Promise.all([
    sendTelegram(message).catch(e => ({ sent: false, error: e.message })),
    sendWhatsAppAlert(message).catch(e => ({ sent: false, error: e.message })),
    _sendEmail(subject, message),
  ]);

  return { telegram: tgResult, whatsapp: waResult, email: emailResult };
}

// ─── Position helpers ──────────────────────────────────────────────────────────

async function _getAllPositions() {
  // Try live account first (real money), fall back to paper
  if (hasLiveAccount()) {
    try {
      const live = await getLivePositions();
      if (live.length > 0) return live;
    } catch { /* fall through */ }
  }
  return getPositions().catch(() => []);
}

// ─── Yahoo Finance helpers ─────────────────────────────────────────────────────

async function _getQuote(symbol) {
  // Uses yahoo-finance2 quote module — includes pre/post market fields
  try {
    return await yf.quote(symbol, {}, { validateResult: false });
  } catch { return null; }
}

async function _getCalendarEvents(symbol) {
  try {
    const res = await yf.quoteSummary(symbol, { modules: ['calendarEvents'] }, { validateResult: false });
    return res?.calendarEvents ?? null;
  } catch { return null; }
}

function _fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return 'N/A';
  return n.toFixed(decimals);
}

function _fmtDate(d) {
  if (!d) return 'unknown';
  try {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
  } catch { return String(d); }
}

function _minsToOpen() {
  const now = new Date();
  const et  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const openToday = new Date(et);
  openToday.setHours(9, 30, 0, 0);
  if (et > openToday) openToday.setDate(openToday.getDate() + 1);
  return Math.round((openToday - et) / 60_000);
}

// ─── 1. checkEarningsRisk ─────────────────────────────────────────────────────

/**
 * Checks all held positions for upcoming earnings within the next 4 days.
 * Fires an alert for each at-risk holding.
 *
 * @returns {Promise<string[]>} Tickers with earnings risk
 */
export async function checkEarningsRisk() {
  const positions = await _getAllPositions();
  if (!positions.length) {
    console.log('[guardian:earnings] No positions held — nothing to check');
    return [];
  }

  const atRisk = [];
  const NOW = Date.now();
  const FOUR_DAYS = 4 * 24 * 60 * 60 * 1000;

  await Promise.all(positions.map(async pos => {
    const cal = await _getCalendarEvents(pos.symbol);
    if (!cal) return;

    // calendarEvents.earnings.earningsDate is an array of Date objects
    const dates = cal?.earnings?.earningsDate ?? [];
    const next  = dates
      .map(d => (d instanceof Date ? d : new Date(d)))
      .filter(d => !isNaN(d) && d.getTime() > NOW)
      .sort((a, b) => a - b)[0];

    if (!next) return;
    const msAway = next.getTime() - NOW;
    if (msAway > FOUR_DAYS) return;

    const value  = pos.market_value ?? (pos.qty * pos.current_price);
    const daysAway = Math.ceil(msAway / 86_400_000);

    atRisk.push(pos.symbol);
    const msg = [
      `⚠️ EARNINGS RISK: ${pos.symbol} reports in ${daysAway} day${daysAway !== 1 ? 's' : ''} (${_fmtDate(next)})`,
      `You hold ${pos.qty} shares ($${_fmt(value, 0)}).`,
      `Consider reducing before close to avoid gap risk.`,
    ].join('\n');

    await sendAlert(msg);
  }));

  console.log(`[guardian:earnings] ${atRisk.length} at-risk ticker(s):`, atRisk.join(', ') || 'none');
  return atRisk;
}

// ─── 2. checkAfterHoursMove ───────────────────────────────────────────────────

/**
 * Checks all held positions for significant after-hours price moves (>±3%).
 * Fires an alert for each significant mover.
 *
 * @returns {Promise<Array<{symbol, pct, ahPrice}>>} Sorted by abs(pct) descending
 */
export async function checkAfterHoursMove() {
  const positions = await _getAllPositions();
  if (!positions.length) {
    console.log('[guardian:ah] No positions held — nothing to check');
    return [];
  }

  const AH_THRESHOLD = 3.0;
  const movers = [];

  await Promise.all(positions.map(async pos => {
    const q = await _getQuote(pos.symbol);
    if (!q) return;

    const regular    = q.regularMarketPrice ?? pos.current_price;
    const ahPrice    = q.postMarketPrice    ?? null;
    const ahPct      = q.postMarketChangePercent != null
      ? q.postMarketChangePercent * 100     // yahoo-finance2 returns decimal fraction
      : ahPrice && regular
        ? (ahPrice - regular) / regular * 100
        : null;

    if (ahPct == null || Math.abs(ahPct) < AH_THRESHOLD) return;

    const emoji   = ahPct >= 0 ? '🟢' : '🔴';
    const entry   = pos.avg_entry_price;
    const pnlPer  = ahPrice ? ahPrice - entry : null;
    const pnlTotal = pnlPer != null ? pnlPer * pos.qty : pos.unrealized_pl;

    movers.push({ symbol: pos.symbol, pct: ahPct, ahPrice });

    const msg = [
      `${emoji} ${pos.symbol} after-hours: ${ahPct >= 0 ? '+' : ''}${_fmt(ahPct)}%`,
      `You hold ${pos.qty} shares | Entry: $${_fmt(entry)} | AH: $${_fmt(ahPrice)}`,
      `Unrealized P&L: ${pnlTotal >= 0 ? '+' : ''}$${_fmt(pnlTotal, 0)}`,
    ].join('\n');

    await sendAlert(msg);
  }));

  movers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  console.log(`[guardian:ah] ${movers.length} mover(s) >±${AH_THRESHOLD}%:`, movers.map(m => `${m.symbol} ${m.pct >= 0 ? '+' : ''}${_fmt(m.pct)}%`).join(', ') || 'none');
  return movers;
}

// ─── 3. checkPreMarketHoldings ────────────────────────────────────────────────

/**
 * Checks all held positions for significant pre-market moves (>±2%).
 * Includes countdown to market open in each alert.
 *
 * @returns {Promise<Array<{symbol, pct, pmPrice}>>} Sorted by abs(pct) descending
 */
export async function checkPreMarketHoldings() {
  const positions = await _getAllPositions();
  if (!positions.length) {
    console.log('[guardian:pm] No positions held — nothing to check');
    return [];
  }

  const PM_THRESHOLD = 2.0;
  const movers = [];
  const minsLeft = _minsToOpen();
  const openMsg  = minsLeft > 0 ? `Market opens in ~${minsLeft} min${minsLeft !== 1 ? 's' : ''}` : 'Market is open';

  await Promise.all(positions.map(async pos => {
    const q = await _getQuote(pos.symbol);
    if (!q) return;

    const regular  = q.regularMarketPrice ?? pos.current_price;
    const pmPrice  = q.preMarketPrice     ?? null;
    const pmPct    = q.preMarketChangePercent != null
      ? q.preMarketChangePercent * 100
      : pmPrice && regular
        ? (pmPrice - regular) / regular * 100
        : null;

    if (pmPct == null || Math.abs(pmPct) < PM_THRESHOLD) return;

    const emoji   = pmPct >= 0 ? '🟢' : '🔴';
    const entry   = pos.avg_entry_price;
    const pnlPer  = pmPrice ? pmPrice - entry : null;
    const pnlTotal = pnlPer != null ? pnlPer * pos.qty : pos.unrealized_pl;

    movers.push({ symbol: pos.symbol, pct: pmPct, pmPrice });

    const msg = [
      `${emoji} ${pos.symbol} pre-market: ${pmPct >= 0 ? '+' : ''}${_fmt(pmPct)}%`,
      `You hold ${pos.qty} shares | Entry: $${_fmt(entry)} | PM: $${_fmt(pmPrice)}`,
      `Unrealized P&L: ${pnlTotal >= 0 ? '+' : ''}$${_fmt(pnlTotal, 0)}`,
      openMsg,
    ].join('\n');

    await sendAlert(msg);
  }));

  movers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  console.log(`[guardian:pm] ${movers.length} mover(s) >±${PM_THRESHOLD}%:`, movers.map(m => `${m.symbol} ${m.pct >= 0 ? '+' : ''}${_fmt(m.pct)}%`).join(', ') || 'none');
  return movers;
}

// ─── 4. runWeekendScan ────────────────────────────────────────────────────────

/**
 * Full weekend scan: earnings risk + after-hours moves in parallel.
 * Use this for manual triggers and the Friday 6 PM combined check.
 *
 * @returns {Promise<{earnings_risks: string[], ah_movers: Array}>}
 */
export async function runWeekendScan() {
  console.log('[guardian] Running weekend scan…');

  const [earningsResult, ahResult] = await Promise.allSettled([
    checkEarningsRisk(),
    checkAfterHoursMove(),
  ]);

  const earnings_risks = earningsResult.status === 'fulfilled' ? earningsResult.value : [];
  const ah_movers      = ahResult.status      === 'fulfilled' ? ahResult.value      : [];

  const channelStatus = [
    isTelegramConfigured() ? '✅ Telegram' : '⚠️ Telegram (not configured)',
    isWhatsAppConfigured() ? '✅ WhatsApp' : '⚠️ WhatsApp (not configured)',
    _resend ? `✅ Email → ${GUARDIAN_EMAIL}` : '⚠️ Email (no RESEND_API)',
  ].join(' · ');

  console.log(`[guardian] Scan complete — ${earnings_risks.length} earnings risk(s), ${ah_movers.length} AH mover(s)`);
  console.log(`[guardian] Channels: ${channelStatus}`);

  return { earnings_risks, ah_movers };
}
