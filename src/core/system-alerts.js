/**
 * Unified system-alerts layer.
 * Every cron failure, threshold breach, schema drift, low-quota warning,
 * and WebSocket flap emits an email (Resend) and a DB row.
 *
 * Rate-limited by key: same key fires email only once per dedup_window_minutes.
 * CRITICAL severity bypasses dedup.
 */

import os from 'os';
import { Resend } from 'resend';
import { query, isDbAvailable } from './db.js';
import { sendTelegram } from './telegram.js';

const VALID_SEVERITIES = new Set(['info', 'warn', 'critical']);

// ── Secret redaction ──────────────────────────────────────────────────────────

function redact(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = /secret|token|password|api_key|cookie/i.test(k) ? '[REDACTED]' : redact(v);
  }
  return out;
}

// ── Email helpers ─────────────────────────────────────────────────────────────

function subjectPrefix(severity) {
  if (severity === 'critical') return '[CRITICAL]';
  if (severity === 'info')     return '[OK]';
  return '[WARN]';
}

function buildHtml(severity, title, key, safeDetail) {
  const badgeColor = severity === 'critical' ? '#dc2626'
                   : severity === 'info'     ? '#16a34a'
                   :                           '#d97706';

  const detailRows = Object.entries(safeDetail)
    .map(([k, v]) => {
      const val = typeof v === 'object' ? `<pre style="margin:0;font-size:0.82em">${JSON.stringify(v, null, 2)}</pre>` : String(v ?? '');
      return `<tr><td style="padding:4px 8px;font-weight:600;white-space:nowrap;vertical-align:top">${k}</td>`
           + `<td style="padding:4px 8px;word-break:break-all">${val}</td></tr>`;
    }).join('');

  return `<div style="font-family:sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e">
    <h2 style="margin:0 0 14px">
      <span style="background:${badgeColor};color:#fff;padding:2px 10px;border-radius:4px;font-size:0.85em;margin-right:8px">${severity.toUpperCase()}</span>
      ${title}
    </h2>
    <table style="width:100%;border-collapse:collapse;font-size:0.9em;background:#f8f9fa;border:1px solid #ddd">
      <tr style="background:#e9ecef"><td style="padding:4px 8px;font-weight:600">Key</td><td style="padding:4px 8px">${key}</td></tr>
      <tr><td style="padding:4px 8px;font-weight:600">Time</td><td style="padding:4px 8px">${new Date().toISOString()}</td></tr>
      <tr style="background:#e9ecef"><td style="padding:4px 8px;font-weight:600">Host</td><td style="padding:4px 8px">${os.hostname()} (pid ${process.pid})</td></tr>
      ${detailRows}
    </table>
    <p style="color:#6c757d;font-size:0.8em;margin-top:12px">Trading Dashboard · System Alert · Not financial advice</p>
  </div>`;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function alert({ key, severity = 'warn', title, detail = {}, dedup_window_minutes = 60 } = {}) {
  // 1. Validate inputs — never throw
  if (!key || typeof key !== 'string' || !key.trim()) {
    console.warn('[system-alerts] invalid key:', key);
    return null;
  }
  if (!VALID_SEVERITIES.has(severity)) {
    console.warn('[system-alerts] invalid severity:', severity);
    return null;
  }
  if (!title || typeof title !== 'string' || !title.trim()) {
    console.warn('[system-alerts] invalid title:', title);
    return null;
  }

  // 2. Redact detail before storing
  const safeDetail = redact(detail ?? {});

  // 3. Dedup check (non-critical only)
  if (severity !== 'critical' && isDbAvailable()) {
    try {
      const { rows: existing } = await query(
        `SELECT id FROM system_alerts
         WHERE key = $1 AND email_sent = TRUE
           AND created_at > NOW() - ($2 * INTERVAL '1 minute')
         LIMIT 1`,
        [key, dedup_window_minutes]
      );
      if (existing.length) {
        const { rows } = await query(
          `INSERT INTO system_alerts (key, severity, title, detail, email_suppressed, hostname, pid)
           VALUES ($1,$2,$3,$4,TRUE,$5,$6) RETURNING *`,
          [key, severity, title, JSON.stringify(safeDetail), os.hostname(), process.pid]
        );
        return rows[0];
      }
    } catch (e) {
      console.warn('[system-alerts] dedup check error:', e.message);
    }
  }

  // 4. Insert row — email_sent=false initially
  let row;
  if (!isDbAvailable()) {
    const subject = `${subjectPrefix(severity)} ${title}`;
    console.log(`[system-alerts] ${subject} (key=${key}, db unavailable)`);
    // Still try to send email even without DB
    row = { id: null, key, severity, title, detail: safeDetail, email_sent: false, email_suppressed: false };
  } else {
    try {
      const { rows } = await query(
        `INSERT INTO system_alerts (key, severity, title, detail, hostname, pid)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [key, severity, title, JSON.stringify(safeDetail), os.hostname(), process.pid]
      );
      row = rows[0];
    } catch (e) {
      console.warn('[system-alerts] DB insert error:', e.message);
      return null;
    }
  }

  // 5. Send email
  const apiKey = process.env.RESEND_API;
  const from   = process.env.RESEND_FROM || 'info@dlpinnovations.com';
  const to     = process.env.ALERT_EMAIL || process.env.SENTINEL_EMAIL_TO || 'info@trading.dlpinnovations.com';
  const subject = `${subjectPrefix(severity)} ${title}`;

  if (!apiKey) {
    console.warn(`[system-alerts] RESEND_API not configured — ${subject} logged only (key=${key})`);
    return row;
  }

  try {
    const resend  = new Resend(apiKey);
    const html    = buildHtml(severity, title, key, safeDetail);
    const send    = resend.emails.send({ from: `Trading Dashboard <${from}>`, to, subject, html });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 5000)
    );
    await Promise.race([send, timeout]);
    if (row.id) await query(`UPDATE system_alerts SET email_sent=TRUE WHERE id=$1`, [row.id]).catch(() => {});
    row.email_sent = true;
    console.log(`[system-alerts] email sent: ${subject} (key=${key})`);
  } catch (e) {
    const errMsg = e.message || String(e);
    console.warn(`[system-alerts] email failed (key=${key}):`, errMsg);
    if (row.id) await query(`UPDATE system_alerts SET email_error=$1 WHERE id=$2`, [errMsg, row.id]).catch(() => {});
    row.email_error = errMsg;
  }

  // 6. Fire push notification for critical alerts (fire-and-forget)
  if (severity === 'critical') {
    sendCriticalPush(row, title, key).catch(e =>
      console.warn('[system-alerts] push failed (non-fatal):', e.message)
    );
  }

  // 7. 2026-05-28: also mirror warn+critical alerts to Telegram so user sees them on phone.
  // 'info' is too chatty for Telegram — those are audit-only (e.g. bot stop/start).
  if (severity === 'warn' || severity === 'critical') {
    const icon = severity === 'critical' ? '🚨' : '⚠️';
    const sevTag = severity.toUpperCase();
    // Keep Telegram body short — link back to email for full detail.
    const tgBody = `${icon} <b>${sevTag}</b> ${title}\nkey: <code>${key}</code>\n${os.hostname()} pid ${process.pid}`;
    sendTelegram(tgBody).catch(e =>
      console.warn('[system-alerts] telegram mirror failed (non-fatal):', e.message)
    );
  }

  return row;
}

// ── Web-push for critical alerts ──────────────────────────────────────────────

async function sendCriticalPush(row, title, key) {
  if (!isDbAvailable()) return;

  const vapidPublic  = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:info@trading.dlpinnovations.com';
  if (!vapidPublic || !vapidPrivate) return;

  const { default: webpush } = await import('web-push');
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const { rows: subs } = await query('SELECT endpoint, p256dh, auth FROM push_subscriptions');
  if (!subs.length) return;

  const payload = JSON.stringify({
    title: title || 'Critical Alert',
    body:  row?.detail ? Object.values(row.detail)[0] ?? '' : '',
    key,
    alert_id: row?.id ?? null,
    url: '/mobile.html',
  });

  await Promise.allSettled(
    subs.map(sub =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      ).catch(e => {
        // Remove stale subscriptions (410 Gone)
        if (e.statusCode === 410) {
          query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]).catch(() => {});
        }
      })
    )
  );
}
