/**
 * Admin AI Chat Engine
 * Claude-powered assistant with full application management tools.
 * Only accessible to admin-role users.
 */

import Anthropic from '@anthropic-ai/sdk';
import bcrypt from 'bcrypt';

import {
  isDbAvailable,
  listDbUsers, getDbUser,
  suspendUser, unsuspendUser,
  setUserCredits, addCredits, setUserRole, resetUserPassword,
  deleteDbUser, getActivity, logActivity,
  recordApiCall, getScannerState, setScannerState,
} from './db.js';
import { getAccount, getPositions, getDailyPnL, closePosition } from './trader.js';
import { getFunds as getMoomooFunds, getPositions as getMoomooPositions } from './moomoo-tcp.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PRICE_INPUT_PER_M  = 0.80;
const PRICE_OUTPUT_PER_M = 4.00;
function calcCost(inp, out) { return (inp / 1e6) * PRICE_INPUT_PER_M + (out / 1e6) * PRICE_OUTPUT_PER_M; }

// Separate in-memory conversation history for admin sessions (per session ID)
export const adminChatHistory = new Map();

export function clearAdminHistory(sessionId) {
  adminChatHistory.delete(sessionId);
}

// ─── System Prompt ────────────────────────────────────────────────────────────

function buildAdminSystemPrompt() {
  const now    = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true });

  return `You are the Admin Control AI for the Trading Bot platform. You have full authority to manage all users, the trading engine, and system settings.

Today: ${dateStr} | ${timeStr} ET

━━━ YOUR CAPABILITIES ━━━
User Management:
• list_users — see all users, roles, credit balances, suspend status, last login
• get_user — detailed info for one user
• suspend_user — block a user from logging in
• activate_user — restore a suspended user's access
• set_credits — set a user's credit balance to an exact amount
• add_credits — add (or subtract) credits from a user
• set_role — change a user's role (viewer ↔ admin)
• reset_password — reset a user's password
• delete_user — permanently delete a user

System & Trading:
• get_system_status — DB connectivity, user counts, scanner state, broker connectivity
• get_activity_logs — recent user activity across the platform
• get_moomoo_funds — live Moomoo account: cash, total assets, unrealized P&L, realized P&L ← USE THIS for Moomoo P&L questions
• get_moomoo_positions — live Moomoo positions with cost, current price, unrealized P&L per holding
• get_positions — Alpaca paper trading positions and account balance
• get_pnl — Alpaca paper trading daily P&L vs target
• pause_scanner — stop the auto-trading scanner
• resume_scanner — start the auto-trading scanner
• get_scanner_state — check if scanner is running or paused

━━━ BROKER DISAMBIGUATION ━━━
- "Moomoo" / "my account" / "live account" / "real money" → use get_moomoo_funds or get_moomoo_positions
- "paper trading" / "Alpaca" / "daily target" → use get_pnl or get_positions
- When the user asks about "P&L" without specifying, default to Moomoo (it's the real account).
- Never say you can't access Moomoo — you have get_moomoo_funds and get_moomoo_positions.

━━━ BEHAVIOR RULES ━━━
1. ALWAYS confirm destructive actions before executing (delete_user, suspend_user).
   Ask once: "Are you sure you want to [action] for [user]?" — if the admin says yes/confirm/proceed, do it.
2. Never delete or suspend an admin account.
3. When listing users, show status clearly: 🟢 active, 🔴 suspended.
4. Credit amounts must be non-negative integers for set_credits.
5. Passwords must be at least 8 characters.
6. Be concise and action-oriented. This is an operations dashboard, not a chat.
7. Format tables and user lists in clean Markdown for readability.`;
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const ADMIN_TOOLS = [
  {
    name: 'list_users',
    description: 'List all registered users with role, credits, suspended status, and last login.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_user',
    description: 'Get detailed info for a specific user.',
    input_schema: {
      type: 'object',
      properties: { username: { type: 'string' } },
      required: ['username'],
    },
  },
  {
    name: 'suspend_user',
    description: 'Suspend a user account. They will be blocked from logging in.',
    input_schema: {
      type: 'object',
      properties: { username: { type: 'string' } },
      required: ['username'],
    },
  },
  {
    name: 'activate_user',
    description: 'Restore a suspended user\'s access so they can log in again.',
    input_schema: {
      type: 'object',
      properties: { username: { type: 'string' } },
      required: ['username'],
    },
  },
  {
    name: 'set_credits',
    description: 'Set a user\'s credit balance to an exact amount.',
    input_schema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        amount:   { type: 'number', description: 'New credit balance (0 or more)' },
      },
      required: ['username', 'amount'],
    },
  },
  {
    name: 'add_credits',
    description: 'Add credits to a user (use a negative number to subtract).',
    input_schema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        amount:   { type: 'number', description: 'Credits to add (negative to subtract)' },
      },
      required: ['username', 'amount'],
    },
  },
  {
    name: 'set_role',
    description: 'Change a user\'s role.',
    input_schema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        role:     { type: 'string', enum: ['admin', 'viewer'] },
      },
      required: ['username', 'role'],
    },
  },
  {
    name: 'reset_password',
    description: 'Reset a user\'s password. Minimum 8 characters.',
    input_schema: {
      type: 'object',
      properties: {
        username:     { type: 'string' },
        new_password: { type: 'string', description: 'New password (min 8 characters)' },
      },
      required: ['username', 'new_password'],
    },
  },
  {
    name: 'delete_user',
    description: 'Permanently delete a user. Cannot be undone. Cannot delete admin accounts.',
    input_schema: {
      type: 'object',
      properties: { username: { type: 'string' } },
      required: ['username'],
    },
  },
  {
    name: 'get_system_status',
    description: 'Check database connectivity, user counts, trading positions, scanner state, and broker status.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_activity_logs',
    description: 'Get recent user activity logs across the platform.',
    input_schema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Filter to a specific user (optional)' },
        limit:    { type: 'number', description: 'Number of entries to return (default 25, max 100)' },
      },
    },
  },
  {
    name: 'get_moomoo_funds',
    description: 'Get live Moomoo brokerage account summary: cash, total assets, market value, buying power, unrealized P&L, and realized P&L. Use this for Moomoo account P&L questions.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_moomoo_positions',
    description: 'Get all live Moomoo positions with cost basis, current price, unrealized P&L, and P&L percentage for each holding.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_positions',
    description: 'Get all currently open Alpaca paper trading positions and account balance.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_pnl',
    description: "Get today's Alpaca paper trading P&L versus the daily target.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'pause_scanner',
    description: 'Pause the auto-trading scanner. No new trades will be placed until resumed.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'resume_scanner',
    description: 'Resume the auto-trading scanner.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_scanner_state',
    description: 'Check whether the auto-trading scanner is currently running or paused.',
    input_schema: { type: 'object', properties: {} },
  },
];

// ─── Tool Executor ────────────────────────────────────────────────────────────

async function executeTool(name, input, { adminUsername } = {}) {
  const log = (action, detail) => logActivity(adminUsername || 'admin', action, detail).catch(() => {});

  try {
    switch (name) {

      case 'list_users': {
        if (!isDbAvailable()) return { error: 'Database not available' };
        const users = await listDbUsers() ?? [];
        return users.map(u => ({
          username:   u.username,
          role:       u.role,
          plan:       u.plan,
          credits:    u.credits,
          suspended:  !!u.suspended,
          email:      u.email || null,
          last_login: u.last_login,
          created_at: u.created_at,
          alpaca_paper: !!u.alpaca_api_key,
          alpaca_live:  !!u.alpaca_live_api_key,
        }));
      }

      case 'get_user': {
        if (!isDbAvailable()) return { error: 'Database not available' };
        const u = await getDbUser(input.username);
        if (!u) return { error: `User "${input.username}" not found` };
        return {
          username:     u.username,
          role:         u.role,
          plan:         u.plan,
          credits:      u.credits,
          suspended:    !!u.suspended,
          email:        u.email || null,
          last_login:   u.last_login,
          created_at:   u.created_at,
          alpaca_paper: !!u.alpaca_api_key,
          alpaca_live:  !!u.alpaca_live_api_key,
        };
      }

      case 'suspend_user': {
        if (!isDbAvailable()) return { error: 'Database not available' };
        const u = await getDbUser(input.username);
        if (!u) return { error: `User "${input.username}" not found` };
        if (u.role === 'admin') return { error: 'Cannot suspend admin accounts' };
        if (u.suspended) return { error: `${input.username} is already suspended` };
        await suspendUser(input.username);
        log('admin_suspend_user', `Suspended ${input.username}`);
        return { success: true, message: `${input.username} has been suspended. They cannot log in until activated.` };
      }

      case 'activate_user': {
        if (!isDbAvailable()) return { error: 'Database not available' };
        const u = await getDbUser(input.username);
        if (!u) return { error: `User "${input.username}" not found` };
        if (!u.suspended) return { error: `${input.username} is not suspended` };
        await unsuspendUser(input.username);
        log('admin_activate_user', `Activated ${input.username}`);
        return { success: true, message: `${input.username} is now active and can log in.` };
      }

      case 'set_credits': {
        if (!isDbAvailable()) return { error: 'Database not available' };
        const amount = Math.max(0, Math.floor(input.amount));
        const u = await getDbUser(input.username);
        if (!u) return { error: `User "${input.username}" not found` };
        await setUserCredits(input.username, amount);
        log('admin_set_credits', `Set ${input.username} credits → ${amount}`);
        return { success: true, message: `${input.username}'s credits set to ${amount}` };
      }

      case 'add_credits': {
        if (!isDbAvailable()) return { error: 'Database not available' };
        const u = await getDbUser(input.username);
        if (!u) return { error: `User "${input.username}" not found` };
        await addCredits(input.username, input.amount);
        const updated = await getDbUser(input.username);
        log('admin_add_credits', `Added ${input.amount} credits to ${input.username} → ${updated.credits} total`);
        return { success: true, new_balance: updated.credits, message: `Added ${input.amount} credits to ${input.username}. New balance: ${updated.credits}` };
      }

      case 'set_role': {
        if (!isDbAvailable()) return { error: 'Database not available' };
        const u = await getDbUser(input.username);
        if (!u) return { error: `User "${input.username}" not found` };
        await setUserRole(input.username, input.role);
        log('admin_set_role', `Set ${input.username} role → ${input.role}`);
        return { success: true, message: `${input.username}'s role changed to ${input.role}` };
      }

      case 'reset_password': {
        if (!isDbAvailable()) return { error: 'Database not available' };
        if (!input.new_password || input.new_password.length < 8) {
          return { error: 'Password must be at least 8 characters' };
        }
        const u = await getDbUser(input.username);
        if (!u) return { error: `User "${input.username}" not found` };
        const hash = await bcrypt.hash(input.new_password, 12);
        await resetUserPassword(input.username, hash);
        log('admin_reset_password', `Reset password for ${input.username}`);
        return { success: true, message: `Password reset for ${input.username}` };
      }

      case 'delete_user': {
        if (!isDbAvailable()) return { error: 'Database not available' };
        const u = await getDbUser(input.username);
        if (!u) return { error: `User "${input.username}" not found` };
        if (u.role === 'admin') return { error: 'Cannot delete admin accounts' };
        await deleteDbUser(input.username);
        log('admin_delete_user', `Deleted user ${input.username}`);
        return { success: true, message: `User ${input.username} permanently deleted` };
      }

      case 'get_system_status': {
        const dbOk    = isDbAvailable();
        const paused  = (await getScannerState('paused')) === 'true';
        const users   = dbOk ? (await listDbUsers() ?? []) : [];
        const suspended = users.filter(u => u.suspended).length;

        let alpacaStatus = 'unknown';
        let portfolioValue = null;
        try {
          const acc = await getAccount();
          alpacaStatus  = 'connected';
          portfolioValue = acc.portfolio_value;
        } catch (e) {
          alpacaStatus = `error: ${e.message}`;
        }

        return {
          database:       dbOk ? 'connected' : 'unavailable',
          total_users:    users.length,
          suspended_users: suspended,
          scanner:        paused ? 'paused' : 'running',
          alpaca:         alpacaStatus,
          portfolio_value: portfolioValue,
          timestamp:      new Date().toISOString(),
        };
      }

      case 'get_activity_logs': {
        const limit = Math.min(input.limit || 25, 100);
        const rows  = await getActivity({ username: input.username || undefined, limit });
        return { count: rows.length, logs: rows };
      }

      case 'get_moomoo_funds': {
        return await getMoomooFunds();
      }

      case 'get_moomoo_positions': {
        return await getMoomooPositions();
      }

      case 'get_positions': {
        const [account, positions] = await Promise.all([getAccount(), getPositions()]);
        return { account, positions };
      }

      case 'get_pnl': {
        return await getDailyPnL();
      }

      case 'pause_scanner': {
        const current = await getScannerState('paused');
        if (current === 'true') return { already_paused: true, message: 'Scanner is already paused' };
        await setScannerState('paused', 'true');
        log('admin_pause_scanner', 'Auto-scanner paused via Admin AI');
        return { success: true, message: 'Auto-scanner paused. No new trades will execute.' };
      }

      case 'resume_scanner': {
        const current = await getScannerState('paused');
        if (current !== 'true') return { not_paused: true, message: 'Scanner is not paused' };
        await setScannerState('paused', 'false');
        log('admin_resume_scanner', 'Auto-scanner resumed via Admin AI');
        return { success: true, message: 'Auto-scanner resumed. Trading is active.' };
      }

      case 'get_scanner_state': {
        const paused = (await getScannerState('paused')) === 'true';
        return { state: paused ? 'paused' : 'running', paused };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

export async function adminChat({ sessionId, message, adminUsername, onChunk, onTool, signal }) {
  if (!adminChatHistory.has(sessionId)) adminChatHistory.set(sessionId, []);

  const history = adminChatHistory.get(sessionId);
  history.push({ role: 'user', content: message });
  if (history.length > 40) history.splice(0, history.length - 40);

  let messages = [...history];
  let fullText = '';

  while (true) {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

    const t0     = Date.now();
    const stream = anthropic.messages.stream({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system:     buildAdminSystemPrompt(),
      tools:      ADMIN_TOOLS,
      messages,
    });

    const onAbort = () => { try { stream.controller.abort(); } catch {} };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      for await (const event of stream) {
        if (signal?.aborted) break;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullText += event.delta.text;
          if (onChunk) onChunk(event.delta.text);
        } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          if (onTool) onTool(event.content_block.name);
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

    const finalMsg = await stream.finalMessage();
    const u = finalMsg.usage || {};
    recordApiCall({
      source:       'admin_chat',
      inputTokens:  u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      toolCalls:    finalMsg.content.filter(b => b.type === 'tool_use').length,
      costUsd:      calcCost(u.input_tokens || 0, u.output_tokens || 0),
      durationMs:   Date.now() - t0,
      model:        finalMsg.model,
      username:     adminUsername,
    }).catch(() => {});

    if (finalMsg.stop_reason === 'tool_use') {
      const toolBlocks = finalMsg.content.filter(b => b.type === 'tool_use');
      messages.push({ role: 'assistant', content: finalMsg.content });

      const toolResults = await Promise.all(
        toolBlocks.map(async (tu) => ({
          type:        'tool_result',
          tool_use_id: tu.id,
          content:     JSON.stringify(await executeTool(tu.name, tu.input, { adminUsername })),
        }))
      );
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    history.push({ role: 'assistant', content: fullText });
    return fullText;
  }
}
