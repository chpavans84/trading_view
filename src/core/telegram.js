/**
 * Telegram Bot API helper.
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   TELEGRAM_CHAT_ID    — your personal chat / group chat ID
 *
 * Get your chat ID: send any message to your bot, then visit
 *   https://api.telegram.org/bot<TOKEN>/getUpdates
 * and read result[0].message.chat.id
 */

const TELEGRAM_API = 'https://api.telegram.org';

function cfg() {
  return {
    token:  process.env.TELEGRAM_BOT_TOKEN  || null,
    chatId: process.env.TELEGRAM_CHAT_ID    || null,
  };
}

/**
 * Send a plain-text or HTML message to the configured Telegram chat.
 * Falls back silently (returns { sent: false, reason: 'not_configured' }) when
 * TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID are absent.
 *
 * @param {string} text         Message text (HTML supported)
 * @param {'HTML'|'Markdown'} [parseMode='HTML']
 * @returns {Promise<{sent: boolean, reason?: string, error?: string}>}
 */
export async function sendTelegram(text, parseMode = 'HTML') {
  const { token, chatId } = cfg();
  if (!token || !chatId) {
    console.log('[telegram] not configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID');
    return { sent: false, reason: 'not_configured' };
  }

  try {
    const r = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    chatId,
        text:       text.slice(0, 4096),    // Telegram hard limit
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8000),
    });

    const d = await r.json();
    if (!d.ok) throw new Error(d.description || `HTTP ${r.status}`);
    console.log(`[telegram] sent (message_id=${d.result?.message_id})`);
    return { sent: true, message_id: d.result?.message_id };
  } catch (e) {
    console.error('[telegram] send failed:', e.message);
    return { sent: false, error: e.message };
  }
}

/**
 * Check whether Telegram is configured (both token + chat ID present).
 */
export function isTelegramConfigured() {
  const { token, chatId } = cfg();
  return !!(token && chatId);
}
