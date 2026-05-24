/**
 * src/core/email.js
 *
 * Shared email sender — single source of truth for outbound email.
 * Replaces ad-hoc Resend client construction scattered across:
 *   - system-alerts.js
 *   - sentinel.js
 *   - position-guardian.js
 *   - daily-bot-report.js
 *   - premarket-news-scanner.js
 *
 * Env vars:
 *   RESEND_API           required — Resend API key
 *   RESEND_FROM          optional — sender address (default: info@dlpinnovations.com)
 *   ALERT_EMAIL          fallback recipient for general alerts
 *   SENTINEL_EMAIL_TO    fallback recipient for sentinel alerts
 *
 * Per-user rate limit applied when called from user-context paths (AI chat tool).
 * Background services (cron, sentinel) bypass the per-user limit but still log.
 */

import { Resend } from 'resend';

// ─── Rate limiting (in-memory, per-user) ────────────────────────────────────
const RATE_LIMIT_MAX     = 10;          // emails per user per window
const RATE_LIMIT_WINDOW  = 60 * 60_000; // 1 hour
const _userBuckets = new Map();         // username → array of timestamps

function _checkRateLimit(username) {
  if (!username) return { ok: true };   // background paths (no user) skip the check
  const now = Date.now();
  let bucket = _userBuckets.get(username) ?? [];
  // Drop timestamps older than the window
  bucket = bucket.filter(t => now - t < RATE_LIMIT_WINDOW);
  if (bucket.length >= RATE_LIMIT_MAX) {
    const oldest = bucket[0];
    const retryInMin = Math.ceil((RATE_LIMIT_WINDOW - (now - oldest)) / 60_000);
    return { ok: false, error: `Email rate limit reached: ${RATE_LIMIT_MAX} emails/hour. Try again in ~${retryInMin} min.` };
  }
  bucket.push(now);
  _userBuckets.set(username, bucket);
  return { ok: true };
}

// ─── Recipient allow-list helper ────────────────────────────────────────────
/**
 * Return the canonical recipient address for AI-triggered emails.
 * Order: explicit `to` (if in allow-list) → user's own email → ALERT_EMAIL → SENTINEL_EMAIL_TO.
 *
 * @param {object} opts
 * @param {string} [opts.requestedTo]   address requested by caller
 * @param {string} [opts.userEmail]     authenticated user's own email
 * @returns {{ to: string, allowed: boolean, reason?: string }}
 */
export function resolveRecipient({ requestedTo, userEmail }) {
  const fallback = process.env.ALERT_EMAIL || process.env.SENTINEL_EMAIL_TO || null;
  const allowList = [userEmail, fallback, process.env.ALERT_EMAIL, process.env.SENTINEL_EMAIL_TO]
    .filter(Boolean)
    .map(s => String(s).toLowerCase().trim());

  if (requestedTo) {
    const wanted = String(requestedTo).toLowerCase().trim();
    if (allowList.includes(wanted)) return { to: requestedTo, allowed: true };
    return { to: '', allowed: false, reason: `Recipient "${requestedTo}" not in allow-list. Allowed: ${allowList.join(', ') || 'none configured'}` };
  }
  if (userEmail) return { to: userEmail, allowed: true };
  if (fallback)  return { to: fallback,  allowed: true };
  return { to: '', allowed: false, reason: 'No recipient: ALERT_EMAIL / SENTINEL_EMAIL_TO env vars not set.' };
}

// ─── Public: send email ─────────────────────────────────────────────────────
/**
 * Send an email via Resend.
 *
 * @param {object} opts
 * @param {string} opts.to                recipient address (already authorised)
 * @param {string} opts.subject
 * @param {string} [opts.html]            HTML body (preferred)
 * @param {string} [opts.text]            plain-text body (fallback)
 * @param {string} [opts.from]            sender override (defaults to RESEND_FROM)
 * @param {string} [opts.username]        for rate limit + audit log
 * @param {number} [opts.timeoutMs=5000]
 * @returns {Promise<{ ok: true, id: string } | { ok: false, error: string }>}
 */
export async function sendEmail({ to, subject, html, text, from, username, timeoutMs = 5000 }) {
  // Validate inputs
  if (!to)      return { ok: false, error: 'to is required' };
  if (!subject) return { ok: false, error: 'subject is required' };
  if (!html && !text) return { ok: false, error: 'either html or text body is required' };

  // Resend env check
  const apiKey = process.env.RESEND_API;
  if (!apiKey) return { ok: false, error: 'RESEND_API not configured on server' };

  // Per-user rate limit (skipped for background paths where username is undefined)
  const rl = _checkRateLimit(username);
  if (!rl.ok) return { ok: false, error: rl.error };

  const senderAddr = from || process.env.RESEND_FROM || 'info@dlpinnovations.com';
  const senderFull = `Trading Dashboard <${senderAddr}>`;

  try {
    const resend = new Resend(apiKey);
    const payload = { from: senderFull, to, subject };
    if (html) payload.html = html;
    if (text) payload.text = text;

    const send    = resend.emails.send(payload);
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`email send timeout after ${timeoutMs}ms`)), timeoutMs)
    );
    const res = await Promise.race([send, timeout]);

    const id = res?.data?.id ?? res?.id ?? null;
    console.log(`[email] sent — from=${senderAddr} to=${to} subject="${subject}"${username ? ` user=${username}` : ''} id=${id ?? 'n/a'}`);
    return { ok: true, id };
  } catch (e) {
    const errMsg = e?.message || String(e);
    console.warn(`[email] failed — to=${to} subject="${subject}"${username ? ` user=${username}` : ''} err=${errMsg}`);
    return { ok: false, error: errMsg };
  }
}

/**
 * Convenience: wrap plain text into a minimally styled HTML body suitable
 * for transactional emails. Keeps the email looking consistent across
 * AI-generated messages and cron alerts.
 */
export function textToHtml(text, { title } = {}) {
  const safe = String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const paragraphs = safe.split(/\n{2,}/).map(p => `<p style="margin:0 0 12px">${p.replace(/\n/g, '<br>')}</p>`).join('');
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#f5f7fa;padding:24px;color:#1f2328">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
      ${title ? `<h2 style="margin:0 0 16px;color:#1f2328;font-size:1.2rem;border-bottom:1px solid #d0d7de;padding-bottom:10px">${String(title).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</h2>` : ''}
      ${paragraphs}
      <p style="margin:20px 0 0;padding-top:14px;border-top:1px solid #d0d7de;color:#656d76;font-size:.85rem">Sent via Trading Dashboard</p>
    </div>
  </body></html>`;
}
