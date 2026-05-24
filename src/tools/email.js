/**
 * src/tools/email.js
 *
 * MCP tool: send_email
 * Exposes the core email service (src/core/email.js) over MCP so an AI agent
 * can send transactional emails on the user's behalf.
 *
 * Safety:
 *   - `to` is checked against an allow-list (RESEND_FROM, ALERT_EMAIL, SENTINEL_EMAIL_TO,
 *     and the optional EMAIL_ALLOW_LIST comma-separated env var). Arbitrary recipients
 *     are rejected — this stops a prompt-injection from emailing strangers.
 *   - Per-process rate limit (10/hour) inherited from core/email.js when a
 *     `username` is passed; in MCP the username is not known so we use the
 *     constant "mcp-cli" bucket.
 */

import { z } from 'zod';
import { jsonResult } from './_format.js';
import { sendEmail, textToHtml } from '../core/email.js';

// ─── Allow-list builder (called per-request so env-var edits take effect) ───
function getAllowList() {
  const list = [
    process.env.ALERT_EMAIL,
    process.env.SENTINEL_EMAIL_TO,
    process.env.RESEND_FROM,
    ...(process.env.EMAIL_ALLOW_LIST || '').split(',').map(s => s.trim()).filter(Boolean),
  ].filter(Boolean).map(s => String(s).toLowerCase().trim());
  return Array.from(new Set(list));
}

function defaultRecipient() {
  return process.env.ALERT_EMAIL || process.env.SENTINEL_EMAIL_TO || null;
}

export function registerEmailTools(server) {
  server.tool(
    'send_email',
    'Send a transactional email via Resend. Use when the user asks "email me this", "send me an alert", "share this with me by email", etc. ' +
    'Recipient defaults to ALERT_EMAIL on the server; an explicit `to` is only accepted if it is in the server allow-list ' +
    '(ALERT_EMAIL, SENTINEL_EMAIL_TO, RESEND_FROM, or EMAIL_ALLOW_LIST env var). Arbitrary addresses are rejected for safety. ' +
    'Body is sent as HTML if provided, otherwise plain text wrapped in a basic template.',
    {
      subject: z.string().min(1).max(200).describe('Email subject line. Keep concise — under 80 chars renders best.'),
      body:    z.string().min(1).max(20_000).describe('Email body. Plain text is wrapped in a basic HTML template; HTML markup is sent as-is.'),
      to:      z.string().email().optional().describe('Recipient address. Must be in the server allow-list. Omit to use ALERT_EMAIL.'),
      html:    z.boolean().optional().describe('Set true if `body` already contains HTML markup. Default: false (auto-wraps plain text).'),
      title:   z.string().max(120).optional().describe('Optional H2 title shown at top of the auto-wrapped HTML email. Ignored when html=true.'),
    },
    async ({ subject, body, to, html, title }) => {
      // Resolve recipient — apply allow-list
      const allowList   = getAllowList();
      const wantedTo    = (to || defaultRecipient() || '').toLowerCase().trim();
      if (!wantedTo) {
        return jsonResult({ error: 'No recipient — pass `to` or set ALERT_EMAIL / SENTINEL_EMAIL_TO env var.' }, true);
      }
      if (!allowList.includes(wantedTo)) {
        return jsonResult({
          error: `Recipient "${wantedTo}" is not in the server allow-list. Allowed: ${allowList.join(', ') || 'none configured'}. ` +
                 `Add it via EMAIL_ALLOW_LIST=addr1,addr2 in .env.`,
        }, true);
      }

      // Build body
      const finalHtml = html ? body : textToHtml(body, title ? { title } : undefined);

      // Send
      const res = await sendEmail({
        to:       to || defaultRecipient(),
        subject,
        html:     finalHtml,
        username: 'mcp-cli',   // single shared rate-limit bucket for all MCP-initiated sends
      });

      if (!res.ok) return jsonResult({ ok: false, error: res.error }, true);
      return jsonResult({ ok: true, id: res.id, to: to || defaultRecipient(), subject });
    }
  );
}
