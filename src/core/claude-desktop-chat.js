/**
 * src/core/claude-desktop-chat.js
 *
 * Spawns the `claude` CLI (Claude Code 2.x+) in headless mode to answer chat
 * questions using Pavan's Max subscription — zero incremental Anthropic-API
 * cost. MCP tools (tradingview server with 99 tools) are inherited automatically
 * from ~/.claude/.mcp.json, so the model can call bot_verdict, portfolio_advisor,
 * why_didnt_bot_buy, signal_edge_report, weekly_bot_retrospective, system_health,
 * etc. without us having to wire each tool individually like the legacy
 * Anthropic-SDK path in ai-chat.js does.
 *
 * Design choices and tradeoffs (locked 2026-05-27):
 *  - Subprocess spawn. Each chat request = one `claude -p` invocation. Process
 *    startup is ~2-5 seconds before first token. Acceptable for dashboard chat.
 *  - We explicitly *unset* ANTHROPIC_API_KEY before spawning so the CLI falls
 *    back to OAuth/keychain Max-sub auth. Without this, the CLI would prefer
 *    the env API key and we'd be paying per token — defeating the whole point.
 *  - Concurrency cap of 3 simultaneous CLI processes. Pavan is the only user;
 *    this is to prevent a runaway loop from spawning hundreds.
 *  - Timeout: 120 seconds. Most chat responses come back in 10-30s; allow
 *    headroom for multi-step tool calling (bot_verdict + signal_edge_report etc.).
 *  - System prompt is appended via --append-system-prompt to anchor the model
 *    on trading-bot context (NOT to override Claude Code's defaults).
 *  - History is passed inline in the user prompt. Each invocation is one-shot;
 *    there's no `--continue` because dashboard chat threads aren't tied to
 *    claude-code session IDs. Keeps it simple.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const CLAUDE_BIN = '/Users/pavan/.local/bin/claude';   // hardcoded for now; could resolve via $PATH
const TIMEOUT_MS = 120_000;
const MAX_CONCURRENT = 3;
const PROJECT_DIR = '/Users/pavan/Documents/Claude_Projects/trading_view/tradingview-mcp';

let _inFlight = 0;

// Built dynamically each call so the model has TODAY's actual date instead of
// having to infer from training cutoff (which caused "May 26 was Memorial Day"
// hallucination 2026-05-27 — May 25 was actually the holiday).
function buildSystemPrompt() {
  const now = new Date();
  const sgt = now.toLocaleString('en-US', { timeZone: 'Asia/Singapore', dateStyle: 'full', timeStyle: 'short' });
  const et  = now.toLocaleString('en-US', { timeZone: 'America/New_York',  dateStyle: 'full', timeStyle: 'short' });
  return `You are the in-dashboard trading assistant for Pavan's TradingView MCP bot.

CURRENT DATE/TIME ANCHORS (use these instead of guessing from training data):
  • Now in Singapore (SGT): ${sgt}
  • Now in New York (ET):    ${et}
  • US market open:  09:30 ET = 21:30 SGT (Mon–Fri)
  • US market close: 16:00 ET = 04:00 SGT (next day)
  • Memorial Day 2026: May 25 (Monday). May 26 was a normal trading day.

You have access to MCP tools that read live trading data:

  • bot_verdict(symbol) — would the bot buy this symbol right now? Composite + setup + blockers.
  • why_didnt_bot_buy(symbol, date?) — audit historical or current bot rejections per symbol.
  • signal_edge_report(signal?, days?) — quintile-bucketed forward-return edge per signal.
  • weekly_bot_retrospective(days=7) — wins, losers, misses, gate histogram for the week.
  • portfolio_advisor(source?) — every held position, risk score, bot verdict per holding.
  • system_health() — 20 health invariants (data freshness, cron heartbeats, DB latency).
  • hedge_recommendation(symbol) — covered-call proposal for held positions.
  • signal_track_record(days?) — forward-return analysis of conviction scores by bucket.
  • uw_flow_get, uw_insider_get, uw_congress_get, uw_top_movers_get, benzinga_news_get — raw market data from DB tables.
  • quote_get / data_get_ohlcv / data_get_study_values / chart_get_state — read chart state
  • chart_set_symbol(symbol) — switch the chart to a symbol so you can quote/inspect it
  • WebSearch — live web search for breaking news, market events, analyst actions

CHART NAVIGATION RULE: quote_get and data_get_* read the CURRENT chart symbol.
To inspect ANY other symbol, you MUST first call chart_set_symbol(X) to switch.
After you're done, RESTORE the original symbol by calling chart_get_state first
and chart_set_symbol(original) at the end. Otherwise you'll leave Pavan's chart on something he didn't pick.

HARD RULES:
1. NEVER guess at numbers — call a tool. If a tool fails, say so explicitly.
2. NEVER place trades. You can recommend; Pavan clicks execute himself.
3. Be concise. Most replies should fit in 5-15 lines. Tables/lists welcome for structured data.
4. When asked about market state, use WebSearch FIRST for breaking news, then MCP tools for bot-specific data.
5. Cite sources for any external data (URL or "from benzinga_news_get tool").

Pavan trades from Singapore. Always convert US times to SGT when relevant.`;
}

/**
 * Spawn claude -p in headless mode and return the answer text.
 *
 * @param {object} opts
 * @param {string} opts.message — user's question
 * @param {Array<{role: 'user'|'assistant', content: string}>} [opts.history] — prior turns
 * @param {string} [opts.cwd=PROJECT_DIR] — working directory (defaults to project root so CLAUDE.md is auto-discovered)
 * @returns {Promise<{text: string, ms: number, ok: boolean, error?: string}>}
 */
export async function chatViaClaude({ message, history = [], cwd = PROJECT_DIR }) {
  if (_inFlight >= MAX_CONCURRENT) {
    return { ok: false, error: `Concurrency limit (${MAX_CONCURRENT}) reached — try again in a moment.`, text: '', ms: 0 };
  }
  if (!message || typeof message !== 'string') {
    return { ok: false, error: 'message is required', text: '', ms: 0 };
  }

  // Build the prompt: history first, then the new user message.
  const transcript = history.map(h => `[${h.role.toUpperCase()}]\n${h.content}`).join('\n\n');
  const fullPrompt = transcript
    ? `${transcript}\n\n[USER]\n${message}`
    : message;

  _inFlight++;
  const t0 = Date.now();

  try {
    // Strip ANTHROPIC_API_KEY from the inherited env. Without this, claude CLI
    // prefers the env key (= paid API tokens) over the user's Max-sub OAuth.
    // We want Max-sub to be used, not the API.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    // Pre-allow the MCP tools we want the model to use without prompting.
    // Without this, headless `claude -p` defaults to asking for permission on
    // every tool call, which manifests as the model returning "I need approval
    // for X" instead of actually executing the call. The MCP server is named
    // "tradingview" in Pavan's ~/.claude/.mcp.json — verified 2026-05-27.
    const ALLOWED_TOOLS = [
      // Built-in Claude Code tools — WebSearch is critical for live market context.
      // Without these the dashboard chat couldn't pull breaking news while the raw
      // `claude` CLI could (verified 2026-05-27 — CLI returned live S&P numbers via
      // WebSearch, dashboard said "I can't access market data").
      'WebSearch',
      'WebFetch',
      // Read-only analysis tools (the bot intelligence MCP layer)
      'mcp__tradingview__bot_verdict',
      'mcp__tradingview__portfolio_advisor',
      'mcp__tradingview__why_didnt_bot_buy',
      'mcp__tradingview__signal_edge_report',
      'mcp__tradingview__weekly_bot_retrospective',
      'mcp__tradingview__signal_track_record',
      'mcp__tradingview__system_health',
      'mcp__tradingview__hedge_recommendation',
      // Raw market data tools (UW + Benzinga)
      'mcp__tradingview__uw_flow_get',
      'mcp__tradingview__uw_insider_get',
      'mcp__tradingview__uw_top_movers_get',
      'mcp__tradingview__uw_congress_get',
      'mcp__tradingview__benzinga_news_get',
      // Chart + price tools (read-only)
      'mcp__tradingview__quote_get',
      'mcp__tradingview__chart_get_state',
      'mcp__tradingview__data_get_ohlcv',
      'mcp__tradingview__data_get_study_values',
      'mcp__tradingview__portfolio_chart_snapshot',
      'mcp__tradingview__symbol_info',
      'mcp__tradingview__symbol_search',
      'mcp__tradingview__news_get_symbol',
      'mcp__tradingview__news_get_earnings',
      // Chart navigation — needed so model can query arbitrary symbols. quote_get
      // only reads the CURRENT chart symbol; without chart_set_symbol the chat
      // returned whatever was on Pavan's screen (FTNT once) for SPY/QQQ/VIX
      // queries (verified 2026-05-27). System prompt instructs to RESTORE the
      // original symbol after the lookup.
      'mcp__tradingview__chart_set_symbol',
      'mcp__tradingview__chart_set_timeframe',
      // Moomoo read tools
      'mcp__tradingview__moomoo_get_positions',
      'mcp__tradingview__moomoo_get_funds',
      'mcp__tradingview__moomoo_get_orders',
    ];

    // --allowedTools is variadic in commander.js — it will greedily swallow
    // any trailing positional arg (the prompt). Workaround: pass the prompt
    // via stdin instead, which the CLI explicitly supports under -p mode.
    //
    // --mcp-config is explicit here because headless `claude -p` does NOT
    // auto-discover ~/.claude/.mcp.json the way interactive mode does (verified
    // 2026-05-27 — without this flag, the model has no tradingview tools).
    const args = [
      '-p',                                              // headless / print mode
      '--append-system-prompt', buildSystemPrompt(),  // dynamic — includes current SGT + ET timestamps
      '--effort', 'medium',                              // balance speed vs depth
      '--mcp-config', '/Users/pavan/.claude/.mcp.json',   // explicit MCP server config
      '--allowedTools', ...ALLOWED_TOOLS,                // pre-approve read-only MCP tools (variadic — keep LAST)
    ];

    const text = await new Promise((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const killer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        reject(new Error(`Timed out after ${TIMEOUT_MS/1000}s`));
      }, TIMEOUT_MS);
      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('error', err => { clearTimeout(killer); reject(err); });
      child.on('close', code => {
        clearTimeout(killer);
        if (code === 0) return resolve(stdout.trim());
        reject(new Error(`claude CLI exited ${code}: ${stderr.trim().slice(0, 500)}`));
      });
      // Send prompt via stdin and close — avoids argv parsing ambiguity with the
      // variadic --allowedTools flag.
      child.stdin.write(fullPrompt);
      child.stdin.end();
    });

    return { ok: true, text, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err.message, text: '', ms: Date.now() - t0 };
  } finally {
    _inFlight--;
  }
}

/**
 * Quick health check — does the CLI work and is auth set up?
 * Used by an admin endpoint to verify wiring before users see the toggle.
 */
export async function pingClaudeCli() {
  const result = await chatViaClaude({ message: 'Reply with exactly: ok' });
  return {
    ok: result.ok && result.text.toLowerCase().includes('ok'),
    response: result.text.slice(0, 200),
    error: result.error,
    duration_ms: result.ms,
  };
}
