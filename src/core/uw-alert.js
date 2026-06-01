/**
 * src/core/uw-alert.js
 *
 * Telegram alerts for Unusual Whales data streams.
 * Called fire-and-forget at the end of each UW ingestion cron.
 *
 * Four alert types:
 *   🐋 Options flow   — premium ≥ FLOW_MIN_PREMIUM (default $1M; was $250K — too noisy)
 *   👤 Insider buy    — director/officer purchase ≥ INSIDER_MIN_VALUE (default $100K)
 *   🏛️ Congress trade — any new buy/sell disclosure ≥ $15K
 *   🚀 Top mover      — stock up/down ≥ MOVER_PCT_THRESHOLD (default 5%)
 *
 * Dedup: every alert is keyed in `uw_tg_alerts`. Restarts never re-fire old rows.
 * All functions are fire-and-forget — callers `.catch(() => {})` and move on.
 */

import { query, isDbAvailable } from './db.js';
import { sendTelegram } from './telegram.js';

// ─── Thresholds ────────────────────────────────────────────────────────────────
const FLOW_MIN_PREMIUM     = 1_000_000; // $1M options premium (was $250K — produced 335 alerts/day, drowning out news)
const INSIDER_MIN_VALUE    = 100_000;   // $100K director/officer purchase
const MOVER_MIN_PCT        = 5;         // ±5% intraday move
const MOVER_MIN_PRICE      = 2;         // ignore sub-$2 penny stocks
const MOVER_MIN_MARKET_CAP = null;      // not enforced here — rely on price + universe filters

// ─── Schema bootstrap ──────────────────────────────────────────────────────────
let _tableReady = false;
async function _ensureTable() {
  if (_tableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS uw_tg_alerts (
      alert_key   TEXT        PRIMARY KEY,
      source      TEXT        NOT NULL,
      ticker      TEXT,
      alerted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  _tableReady = true;
}

// ─── Dedup helpers ─────────────────────────────────────────────────────────────
async function _isNew(key) {
  try {
    const { rowCount } = await query(
      `INSERT INTO uw_tg_alerts (alert_key, source, ticker)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [key, key.split(':')[0], key.split(':')[1] ?? null]
    );
    return rowCount > 0;
  } catch (_) {
    return false;   // on error don't fire
  }
}

// ─── Formatters ────────────────────────────────────────────────────────────────
function _fmtDollars(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Number(n).toFixed(0)}`;
}

function _fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toISOString().slice(0, 10); } catch { return String(d); }
}

// ─── 1. Options Flow ───────────────────────────────────────────────────────────
// Queries the last 3 minutes of flow alerts for big premiums.
// Called at the end of the every-2-min flow ingestion cron.
export async function scanAndAlertUWFlow() {
  if (!isDbAvailable()) return;
  try {
    await _ensureTable();
    const { rows } = await query(`
      SELECT ticker, alert_type, side, strike, expiry, premium, sentiment, alerted_at
        FROM uw_flow_alerts
       WHERE alerted_at > NOW() - INTERVAL '4 minutes'
         AND premium >= $1
       ORDER BY premium DESC
       LIMIT 20
    `, [FLOW_MIN_PREMIUM]);

    for (const r of rows) {
      const key = `flow:${r.ticker}:${new Date(r.alerted_at).toISOString()}`;
      if (!(await _isNew(key))) continue;

      const dir      = r.sentiment === 'bullish' ? '🟢 BULLISH' : r.sentiment === 'bearish' ? '🔴 BEARISH' : '⚪ NEUTRAL';
      const type     = (r.alert_type || '').toUpperCase();   // CALL / PUT
      const strike   = r.strike && Number(r.strike) > 0 ? `$${Number(r.strike).toFixed(0)} strike` : '';
      const expiry   = r.expiry ? `exp ${_fmtDate(r.expiry)}` : '';
      const detail   = [type, strike, expiry].filter(Boolean).join(' · ');

      const msg =
        `🐋 <b>Unusual Flow</b>  $${r.ticker}\n` +
        `${dir}  ·  ${_fmtDollars(r.premium)} premium\n` +
        (detail ? `${detail}\n` : '') +
        `📰 Unusual Whales  ·  just now`;

      sendTelegram(msg).catch(() => {});
    }
  } catch (e) {
    console.warn('[uw-alert/flow]', e.message);
  }
}

// ─── 2. Insider Trades ─────────────────────────────────────────────────────────
// Queries the last 16 minutes for director/officer purchases above threshold.
// Called at the end of the every-15-min insider cron.
export async function scanAndAlertUWInsider() {
  if (!isDbAvailable()) return;
  try {
    await _ensureTable();
    const { rows } = await query(`
      SELECT ticker, insider_name, role, transaction_type, shares, price, value, filed_at
        FROM uw_insider_trades
       WHERE filed_at > NOW() - INTERVAL '16 minutes'
         AND transaction_type = 'P'
         AND value >= $1
         AND role IS NOT NULL
       ORDER BY value DESC
       LIMIT 20
    `, [INSIDER_MIN_VALUE]);

    for (const r of rows) {
      const key = `insider:${r.ticker}:${r.insider_name ?? ''}:${_fmtDate(r.filed_at)}`;
      if (!(await _isNew(key))) continue;

      const name  = r.insider_name ?? 'Insider';
      const role  = r.role ?? 'Unknown';
      const price = r.price ? `@ $${Number(r.price).toFixed(2)}` : '';
      const shares= r.shares ? `${Number(r.shares).toLocaleString()} shares` : '';
      const filed = _fmtDate(r.filed_at);

      const msg =
        `👤 <b>Insider Buy</b>  $${r.ticker}\n` +
        `<b>${name}</b>  (${role})\n` +
        `${_fmtDollars(r.value)}  ·  ${shares}  ${price}\n` +
        `Filed: ${filed}  ·  📰 Unusual Whales`;

      sendTelegram(msg).catch(() => {});
    }
  } catch (e) {
    console.warn('[uw-alert/insider]', e.message);
  }
}

// ─── 3. Congressional Trades ───────────────────────────────────────────────────
// Queries the last 62 minutes for new congressional disclosures.
// Called at the end of the every-hour congress cron.
// Alerts on BOTH buys AND sells (both are informative):
//   • buy  → politician loading up → bullish signal
//   • sell → politician trimming before bad news → bearish signal
export async function scanAndAlertUWCongress() {
  if (!isDbAvailable()) return;
  try {
    await _ensureTable();
    const { rows } = await query(`
      SELECT ticker, member_name, party, chamber, transaction_type,
             amount_range, traded_at, filed_at
        FROM uw_congressional_trades
       WHERE filed_at > NOW() - INTERVAL '62 minutes'
         AND amount_range NOT IN ('$1,001 - $15,000', 'Unknown', 'N/A')
         AND amount_range IS NOT NULL
         AND transaction_type IN ('Buy','Sell','purchase','sale','Purchase','Sale')
       ORDER BY filed_at DESC
       LIMIT 20
    `);

    for (const r of rows) {
      const key = `congress:${r.ticker}:${r.member_name ?? ''}:${_fmtDate(r.traded_at)}:${r.transaction_type}`;
      if (!(await _isNew(key))) continue;

      const isBuy   = /buy|purchase/i.test(r.transaction_type);
      const icon    = isBuy ? '🟢' : '🔴';
      const action  = isBuy ? 'BUY' : 'SELL';
      const chamber = r.chamber === 'senate' ? 'Senate' : r.chamber === 'house' ? 'House' : r.chamber ?? '?';
      const party   = r.party ? ` (${r.party})` : '';
      const traded  = _fmtDate(r.traded_at);
      const filed   = _fmtDate(r.filed_at);
      const lagDays = r.traded_at && r.filed_at
        ? Math.round((new Date(r.filed_at) - new Date(r.traded_at)) / 86_400_000)
        : null;
      const lag     = lagDays != null ? `  ·  ${lagDays}d lag` : '';

      const msg =
        `🏛️ <b>Congress ${action}</b>  $${r.ticker}  ${icon}\n` +
        `<b>${r.member_name ?? 'Unknown'}</b>  ${chamber}${party}\n` +
        `Amount: ${r.amount_range}\n` +
        `Traded: ${traded}  ·  Filed: ${filed}${lag}\n` +
        `📰 Unusual Whales`;

      sendTelegram(msg).catch(() => {});
    }
  } catch (e) {
    console.warn('[uw-alert/congress]', e.message);
  }
}

// ─── 4. Top Movers ─────────────────────────────────────────────────────────────
// Queries the latest movers snapshot for stocks above the % threshold.
// Alerts once per ticker per direction per calendar day (so a +10% mover
// doesn't spam every 5-min tick).
// Called at the end of the every-5-min movers cron.
export async function scanAndAlertUWMovers() {
  if (!isDbAvailable()) return;
  try {
    await _ensureTable();

    // Get the latest snapshot timestamp
    const { rows: latestRows } = await query(
      `SELECT MAX(captured_at) AS latest FROM uw_top_movers`
    );
    const latest = latestRows[0]?.latest;
    if (!latest) return;

    const { rows } = await query(`
      SELECT ticker, direction, change_pct, price
        FROM uw_top_movers
       WHERE captured_at = $1
         AND direction IN ('gainers','losers')
         AND ABS(change_pct::numeric) >= $2
         AND price::numeric >= $3
       ORDER BY ABS(change_pct::numeric) DESC
       LIMIT 20
    `, [latest, MOVER_MIN_PCT, MOVER_MIN_PRICE]);

    const today = new Date().toISOString().slice(0, 10);

    for (const r of rows) {
      // Dedup: once per ticker per direction per day
      const key = `mover:${r.ticker}:${r.direction}:${today}`;
      if (!(await _isNew(key))) continue;

      const chg    = Number(r.change_pct);
      const icon   = chg >= 0 ? '🚀' : '📉';
      const sign   = chg >= 0 ? '+' : '';
      const price  = r.price ? `$${Number(r.price).toFixed(2)}` : '—';

      const msg =
        `${icon} <b>Top Mover</b>  $${r.ticker}\n` +
        `${sign}${chg.toFixed(2)}% today  ·  Price: ${price}\n` +
        `📰 Unusual Whales  ·  ${r.direction}`;

      sendTelegram(msg).catch(() => {});
    }
  } catch (e) {
    console.warn('[uw-alert/movers]', e.message);
  }
}
