/**
 * Twilio WhatsApp API helper.
 * Required env vars:
 *   TWILIO_ACCOUNT_SID  — from Twilio console
 *   TWILIO_AUTH_TOKEN   — from Twilio console
 *   TWILIO_FROM         — WhatsApp sender, e.g. "whatsapp:+14155238886" (Twilio sandbox)
 *   TWILIO_TO           — your WhatsApp number, e.g. "whatsapp:+12345678900"
 *
 * Sandbox: https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn
 * Production: get a Twilio WhatsApp-approved number and set TWILIO_FROM accordingly.
 */

const TWILIO_API = 'https://api.twilio.com/2010-04-01';

function cfg() {
  return {
    sid:   process.env.TWILIO_ACCOUNT_SID  || null,
    token: process.env.TWILIO_AUTH_TOKEN   || null,
    from:  process.env.TWILIO_FROM         || null,
    to:    process.env.TWILIO_TO           || null,
  };
}

/**
 * Send a WhatsApp message via Twilio.
 * Falls back silently when any required env var is missing.
 *
 * @param {string} text  Message body (plain text)
 * @returns {Promise<{sent: boolean, sid?: string, reason?: string, error?: string}>}
 */
export async function sendWhatsAppAlert(text) {
  const { sid, token, from, to } = cfg();
  if (!sid || !token || !from || !to) {
    console.log('[whatsapp] not configured — set TWILIO_ACCOUNT_SID/TOKEN/FROM/TO');
    return { sent: false, reason: 'not_configured' };
  }

  try {
    const url    = `${TWILIO_API}/Accounts/${sid}/Messages.json`;
    const body   = new URLSearchParams({ From: from, To: to, Body: text.slice(0, 1600) });
    const creds  = Buffer.from(`${sid}:${token}`).toString('base64');

    const r = await fetch(url, {
      method:  'POST',
      headers: {
        Authorization:  `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body:   body.toString(),
      signal: AbortSignal.timeout(10_000),
    });

    const d = await r.json();
    if (d.error_code) throw new Error(`${d.error_message} (Twilio ${d.error_code})`);
    if (!r.ok)        throw new Error(`HTTP ${r.status}`);

    console.log(`[whatsapp] sent (sid=${d.sid})`);
    return { sent: true, sid: d.sid };
  } catch (e) {
    console.error('[whatsapp] send failed:', e.message);
    return { sent: false, error: e.message };
  }
}

/**
 * Check whether WhatsApp (Twilio) is configured.
 */
export function isWhatsAppConfigured() {
  const { sid, token, from, to } = cfg();
  return !!(sid && token && from && to);
}
