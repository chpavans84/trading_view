/**
 * src/core/telegram-bot.js
 *
 * Two-way Telegram bridge — routes incoming Telegram messages through the
 * SAME `chat()` function used by the dashboard AI chat. Same TOOLS, same
 * Claude model, same conversation_history persistence. The user gets
 * identical capabilities in Telegram and the web UI.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN        required — from @BotFather
 *   TELEGRAM_CHAT_ID          required — comma-separated allow-list of Telegram chat IDs
 *   TELEGRAM_BOT_ENABLED      opt-in: set to '1' to start the long-polling loop
 *                             (default off so staging/CI don't fight prod for polls)
 *   TELEGRAM_USERNAME         dashboard username to attribute Telegram chats to
 *                             (defaults to first admin user found in DB)
 *   TELEGRAM_USERNAME_MAP     optional: `chatId1:user1,chatId2:user2`
 *                             per-chat override of TELEGRAM_USERNAME
 *   TELEGRAM_SHARED_HISTORY   '1' = share history with the user's dashboard chat,
 *                             '0' (default) = independent history per Telegram chat
 *
 * Slash commands:
 *   /start    welcome + cheatsheet
 *   /help     same as /start
 *   /clear    clear conversation history (this chat only)
 *   /ping     liveness check
 *
 * Single-instance guard: getUpdates returns HTTP 409 when two clients poll
 * the same bot token. Only enable on ONE PM2 process (typically prod).
 */

import { chat, clearHistory } from './ai-chat.js';
import { getDbUser, query } from './db.js';

const TG_API           = 'https://api.telegram.org';
const POLL_TIMEOUT_S   = 30;        // long-polling timeout (kept under getUpdates server-side limit)
const POLL_BACKOFF_MS  = 5000;      // delay after a failed poll
const MAX_MESSAGE_CHARS = 4000;     // Telegram's hard limit is 4096; leave headroom for HTML tags

let _polling      = false;
let _offset       = 0;
let _stopRequested = false;
let _abortController = null;

// ─── Config helpers ─────────────────────────────────────────────────────────
function cfg() {
  return {
    token:           process.env.TELEGRAM_BOT_TOKEN || null,
    allowedChats:    (process.env.TELEGRAM_CHAT_ID || '')
                      .split(',').map(s => s.trim()).filter(Boolean),
    defaultUser:     process.env.TELEGRAM_USERNAME || null,
    userMap:         _parseUserMap(process.env.TELEGRAM_USERNAME_MAP),
    sharedHistory:   process.env.TELEGRAM_SHARED_HISTORY === '1',
    enabled:         process.env.TELEGRAM_BOT_ENABLED === '1',
  };
}

function _parseUserMap(raw) {
  if (!raw) return new Map();
  const m = new Map();
  for (const pair of raw.split(',')) {
    const [chatId, user] = pair.split(':').map(s => s?.trim());
    if (chatId && user) m.set(chatId, user);
  }
  return m;
}

// ─── Telegram API helpers ───────────────────────────────────────────────────
async function tgFetch(method, body = {}, timeoutMs = 10_000) {
  const { token } = cfg();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const r = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) {
    const err = new Error(j.description || `Telegram API ${method} HTTP ${r.status}`);
    err.code = j.error_code;
    throw err;
  }
  return j.result;
}

/**
 * Send a message to a Telegram chat. Automatically chunks responses longer
 * than MAX_MESSAGE_CHARS. Uses HTML parse mode.
 */
async function sendMessage(chatId, text, { parseMode = 'HTML', replyToMessageId } = {}) {
  const chunks = _splitForTelegram(text, MAX_MESSAGE_CHARS);
  const results = [];
  for (const chunk of chunks) {
    const body = {
      chat_id: chatId,
      text: chunk,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    };
    if (replyToMessageId && results.length === 0) body.reply_to_message_id = replyToMessageId;
    try {
      const r = await tgFetch('sendMessage', body);
      results.push(r);
    } catch (e) {
      // If HTML parsing fails (malformed tags from Claude), fall back to plain text
      if (parseMode === 'HTML' && /can't parse entities/i.test(e.message)) {
        const plain = _stripHtml(chunk);
        const r = await tgFetch('sendMessage', { ...body, text: plain, parse_mode: undefined });
        results.push(r);
      } else {
        console.error(`[telegram-bot] sendMessage failed (chat=${chatId}): ${e.message}`);
        // Swallow — don't crash the poll loop
      }
    }
  }
  return results;
}

async function sendChatAction(chatId, action = 'typing') {
  try { await tgFetch('sendChatAction', { chat_id: chatId, action }, 5000); }
  catch { /* ignore — purely cosmetic */ }
}

// ─── Markdown → Telegram HTML (limited subset) ──────────────────────────────
/**
 * Convert common Markdown patterns to Telegram-flavoured HTML.
 * Telegram supports a tiny subset: <b>, <i>, <u>, <s>, <code>, <pre>, <a>.
 * No tables, no lists (we keep their text form), no images.
 */
function markdownToTelegramHtml(md) {
  if (!md) return '';
  let s = String(md);

  // 1. HTML-escape everything first so user input + Claude output can't break parsing
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 2. Code blocks ```…``` → <pre>
  s = s.replace(/```([a-z0-9]*)\n?([\s\S]*?)```/gi, (_, _lang, code) =>
    `<pre>${code.trim()}</pre>`);

  // 3. Inline code `…` → <code>
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // 4. Bold **…** or __…__ → <b>
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+)__/g, '<b>$1</b>');

  // 5. Italic *…* or _…_ → <i>  (after bold so ** doesn't get eaten)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<i>$2</i>');

  // 6. Links [text](url) → <a href="url">text</a>
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');

  // 7. Strip leading "# " markdown headers — Telegram has no headers
  s = s.replace(/^#{1,6}\s+/gm, '');

  // 8. Convert "- item" to "• item" for visual list parity
  s = s.replace(/^\s*[-*]\s+/gm, '• ');

  return s;
}

function _stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/**
 * Split text at safe boundaries (newlines preferred) so chunks ≤ maxLen.
 */
function _splitForTelegram(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // Prefer to split at the last newline before maxLen
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf(' ', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;       // hard cut as last resort
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ─── Slash command handlers ─────────────────────────────────────────────────
const HELP_TEXT = markdownToTelegramHtml(`👋 *Trading Dashboard via Telegram*

Ask anything your dashboard AI can answer:
• "what's my portfolio?"
• "scan for trades"
• "give me the bot's verdict on NVDA"
• "what's the VIX right now?"
• "send me today's top picks by email"
• "remind me to check AAPL at 3pm"
• "options flow on TSLA"

I can place trades, run scans, read your conviction scores, check unusual options flow, send you alerts, and more — same toolset as the web chat.

Commands:
/clear — reset this conversation
/ping  — check I'm alive
/help  — show this`);

async function handleSlashCommand(chatId, text, _username) {
  const cmd = text.trim().toLowerCase().split(/\s+/)[0];
  switch (cmd) {
    case '/start':
    case '/help':
      await sendMessage(chatId, HELP_TEXT);
      return true;
    case '/ping':
      await sendMessage(chatId, '🏓 pong');
      return true;
    case '/clear': {
      const sessionId = await getSessionChatId(String(chatId), _username);
      clearHistory(sessionId);
      try {
        await query(`DELETE FROM conversation_history WHERE chat_id=$1`, [sessionId]);
      } catch { /* table may not exist on staging */ }
      await sendMessage(chatId, '✓ Conversation history cleared.');
      return true;
    }
    default:
      return false;
  }
}

// ─── Username + session resolution ──────────────────────────────────────────
async function resolveUsername(chatId) {
  const c = cfg();
  if (c.userMap.has(String(chatId))) return c.userMap.get(String(chatId));
  if (c.defaultUser) return c.defaultUser;
  // Last-resort fallback: first admin in DB
  try {
    const { rows } = await query(`SELECT username FROM users WHERE role='admin' ORDER BY id LIMIT 1`);
    if (rows[0]?.username) return rows[0].username;
  } catch { /* nothing */ }
  return null;
}

async function getSessionChatId(telegramChatId, username) {
  const c = cfg();
  if (c.sharedHistory && username) return username.toLowerCase().trim();
  return `tg:${telegramChatId}`;
}

// ─── Core: process one incoming message ─────────────────────────────────────
async function handleMessage(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text   = msg.text;

  // Auth
  const c = cfg();
  if (c.allowedChats.length && !c.allowedChats.includes(String(chatId))) {
    console.warn(`[telegram-bot] reject unauthorised chat ${chatId} from "${msg.from?.username || 'unknown'}"`);
    await sendMessage(chatId, '⛔ This bot is private. Your chat is not on the allow-list.');
    return;
  }

  // Slash commands
  if (text.startsWith('/')) {
    const username = await resolveUsername(chatId);
    if (await handleSlashCommand(chatId, text, username)) return;
  }

  // Resolve user identity for tool execution (portfolio, conviction, broker calls)
  const username = await resolveUsername(chatId);
  if (!username) {
    await sendMessage(chatId, '⚠ Server has no TELEGRAM_USERNAME configured and no admin user in the DB to fall back to.');
    return;
  }

  // Load user config (so trade limits, broker source etc. match the dashboard)
  let userConfig = null;
  try {
    const dbUser = await getDbUser(username);
    if (dbUser) {
      // Mirror the userConfig shape buildSystemPrompt expects — see /api/chat handler
      userConfig = {
        username: dbUser.username,
        role: dbUser.role,
        daily_profit_target: dbUser.daily_profit_target,
        daily_loss_limit: dbUser.daily_loss_limit,
        max_open_positions: dbUser.max_open_positions,
        min_conviction_score: dbUser.min_conviction_score,
        trade_source: dbUser.trade_source,
        auto_execute: dbUser.auto_execute,
      };
    }
  } catch { /* non-fatal — chat() handles null userConfig */ }

  const sessionChatId = await getSessionChatId(String(chatId), username);

  // Show "typing…" while Claude works
  await sendChatAction(chatId, 'typing');

  // Periodic typing refresher (Telegram's typing indicator times out after ~5s)
  const typingInterval = setInterval(() => sendChatAction(chatId, 'typing'), 4500);

  // Tool-call indicators — send "🔧 looking up X…" only for slow tools to avoid spam
  const SLOW_TOOLS = new Set([
    'scan_for_trades', 'get_options_flow', 'get_insider_activity', 'get_top_movers_uw',
    'propose_trade', 'portfolio_advisor', 'bot_verdict', 'system_health',
    'signal_track_record', 'hedge_recommendation', 'get_stock_prediction',
  ]);
  let lastToolMessage = null;
  const onTool = async (toolName) => {
    if (!SLOW_TOOLS.has(toolName)) return;
    try {
      const r = await sendMessage(chatId, `🔧 <i>${toolName}…</i>`);
      lastToolMessage = r[0]?.message_id ?? null;
    } catch { /* ignore */ }
  };

  // Hard cap to avoid runaway tool loops eating the whole API budget
  const turnTimeout = setTimeout(() => {
    if (_abortController) _abortController.abort();
  }, 120_000);  // 2 min max per turn

  try {
    _abortController = new AbortController();
    const result = await chat({
      chatId:    sessionChatId,
      message:   text,
      username,
      userConfig,
      onChunk:   null,            // no streaming over Telegram — we send the final text
      onTool,
      signal:    _abortController.signal,
      voiceMode: false,
    });

    clearInterval(typingInterval);
    clearTimeout(turnTimeout);

    const html = markdownToTelegramHtml(result.content || '(empty response)');
    await sendMessage(chatId, html, { replyToMessageId: msg.message_id });
  } catch (e) {
    clearInterval(typingInterval);
    clearTimeout(turnTimeout);
    console.error(`[telegram-bot] chat failed for chat=${chatId}:`, e.message);
    const friendly = e.name === 'AbortError'
      ? '⏱ Took too long (over 2 min) — try a more specific question.'
      : `⚠ Error: ${e.message}`;
    await sendMessage(chatId, friendly).catch(() => {});
  } finally {
    _abortController = null;
  }
}

// ─── Long-polling loop ──────────────────────────────────────────────────────
async function pollLoop() {
  const c = cfg();
  console.log(`[telegram-bot] polling started — allowed chats: ${c.allowedChats.length ? c.allowedChats.join(', ') : '(none configured — all rejected)'}`);
  console.log(`[telegram-bot] default user: ${c.defaultUser || '(falls back to first admin)'}`);
  if (c.userMap.size) console.log(`[telegram-bot] user map: ${[...c.userMap.entries()].map(([k,v]) => `${k}=${v}`).join(', ')}`);
  if (c.sharedHistory) console.log('[telegram-bot] TELEGRAM_SHARED_HISTORY=1 — conversations sync with dashboard chat');

  // Reset offset to skip any messages received before the bot started
  try {
    const updates = await tgFetch('getUpdates', { timeout: 0, limit: 100 });
    if (updates.length) {
      _offset = updates[updates.length - 1].update_id + 1;
      console.log(`[telegram-bot] discarded ${updates.length} pre-boot messages, offset=${_offset}`);
    }
  } catch (e) {
    if (e.code === 409) {
      console.error('[telegram-bot] HTTP 409 — another process is polling this bot token. Aborting startup.');
      _polling = false;
      return;
    }
    console.warn('[telegram-bot] initial offset fetch failed (will keep going):', e.message);
  }

  while (_polling && !_stopRequested) {
    try {
      const updates = await tgFetch(
        'getUpdates',
        { offset: _offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'edited_message'] },
        (POLL_TIMEOUT_S + 5) * 1000
      );
      for (const u of updates) {
        _offset = u.update_id + 1;
        // Don't await — process messages in parallel so a slow Claude call doesn't block polling
        handleMessage(u).catch(e => console.error('[telegram-bot] handleMessage error:', e.message));
      }
    } catch (e) {
      if (e.code === 409) {
        console.error('[telegram-bot] HTTP 409 — duplicate poller detected. Stopping.');
        break;
      }
      if (_stopRequested) break;
      console.warn(`[telegram-bot] poll error: ${e.message} — backing off ${POLL_BACKOFF_MS}ms`);
      await new Promise(r => setTimeout(r, POLL_BACKOFF_MS));
    }
  }
  _polling = false;
  console.log('[telegram-bot] polling stopped');
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────
export function startTelegramBot() {
  const c = cfg();
  if (!c.enabled) {
    console.log('[telegram-bot] disabled — set TELEGRAM_BOT_ENABLED=1 to enable');
    return false;
  }
  if (!c.token) {
    console.warn('[telegram-bot] TELEGRAM_BOT_TOKEN missing — cannot start');
    return false;
  }
  if (!c.allowedChats.length) {
    console.warn('[telegram-bot] TELEGRAM_CHAT_ID missing — all messages would be rejected; not starting');
    return false;
  }
  if (_polling) {
    console.warn('[telegram-bot] already running');
    return true;
  }
  _polling = true;
  _stopRequested = false;
  pollLoop().catch(e => {
    console.error('[telegram-bot] poll loop crashed:', e.message);
    _polling = false;
  });
  return true;
}

export async function stopTelegramBot() {
  _stopRequested = true;
  if (_abortController) try { _abortController.abort(); } catch {}
  // Wait briefly for the loop to notice
  for (let i = 0; i < 10 && _polling; i++) await new Promise(r => setTimeout(r, 100));
  console.log('[telegram-bot] stop requested');
}

export function isTelegramBotRunning() { return _polling; }
