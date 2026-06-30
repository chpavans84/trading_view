// MUST be first — populates DATABASE_URL etc. from .env if the shell shadowed them.
import './env-loader.js';
import pg from 'pg';

/**
 * trading-coach v2 — tool-calling agent runner.
 *
 * The Modelfile (trading-coach-v2.Modelfile) only DECLARES that tools exist;
 * Ollama cannot run SQL itself. This module is the host loop that makes the
 * tools "live":
 *
 *   1. POST the conversation + tool schemas to Ollama /api/chat.
 *   2. If the model replies with tool_calls, run the matching read-only SQL,
 *      append each result as a {role:'tool'} message, and loop.
 *   3. When the model replies with plain content (no tool_calls), that's the
 *      final answer — return it.
 *
 * Every number the coach states therefore comes from PostgreSQL at question
 * time, never from frozen prompt text. This is the RAG/tool-calling fix for
 * v1's stale baked-in data + hallucinated "lessons".
 *
 * SAFETY: tools are SELECT-only and fully parameterised. No model-supplied
 * string is ever interpolated into SQL — args drive bind params + a small
 * whitelist (sort direction). The model cannot write, drop, or read outside
 * these queries.
 */

const OLLAMA_URL     = process.env.OLLAMA_URL || 'http://localhost:11434';
const COACH_MODEL    = process.env.OLLAMA_COACH_MODEL || 'trading-coach-v2';
// First call after idle loads the whole 19GB model — keep generous (see ollama.js).
const OLLAMA_TIMEOUT = Number(process.env.OLLAMA_TIMEOUT_MS) || 120000;
const MAX_TOOL_ROUNDS = 6; // guard against a tool-call loop that never converges

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function q(sql, params = []) {
  return (await pool.query(sql, params)).rows;
}

// Clamp a model-supplied integer into a safe range (defends LIMIT etc.).
function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ── Tool registry ──────────────────────────────────────────────────────────
// Each entry: JSON-Schema function def (sent to Ollama) + a run(args) that
// returns plain JSON. All queries scope to closed trades with a real P&L,
// mirroring the proven v1 SQL in src/research/create-modelfile.js.
const TOOLS = {
  get_performance_summary: {
    def: {
      type: 'function',
      function: {
        name: 'get_performance_summary',
        description: 'Overall closed-trade performance: total trades, win rate, total and average P&L, average win, average loss. Call this for any question about how the trader is doing overall.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    run: async () => (await q(`
      SELECT COUNT(*)                                                            AS total_trades,
             SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END)                        AS wins,
             SUM(CASE WHEN pnl_usd <= 0 THEN 1 ELSE 0 END)                       AS losses,
             ROUND(100.0 * SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 1) AS win_rate_pct,
             ROUND(AVG(CASE WHEN pnl_usd > 0 THEN pnl_usd END)::numeric, 2)      AS avg_win,
             ROUND(AVG(CASE WHEN pnl_usd <= 0 THEN pnl_usd END)::numeric, 2)     AS avg_loss,
             ROUND(SUM(pnl_usd)::numeric, 2)                                     AS total_pnl,
             ROUND(AVG(pnl_usd)::numeric, 2)                                     AS avg_pnl
      FROM trades WHERE status = 'closed' AND pnl_usd IS NOT NULL
    `))[0] ?? {},
  },

  get_stats_by_grade: {
    def: {
      type: 'function',
      function: {
        name: 'get_stats_by_grade',
        description: "Win rate and average P&L grouped by the trade's conviction grade (A/B/C/F). Use for questions about whether higher-conviction trades actually do better.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    run: async () => q(`
      SELECT conviction_grade AS grade,
             COUNT(*)         AS trades,
             ROUND(100.0 * SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS win_rate_pct,
             ROUND(AVG(pnl_usd)::numeric, 2) AS avg_pnl
      FROM trades
      WHERE status = 'closed' AND pnl_usd IS NOT NULL AND conviction_grade IS NOT NULL
      GROUP BY conviction_grade ORDER BY conviction_grade
    `),
  },

  get_stats_by_regime: {
    def: {
      type: 'function',
      function: {
        name: 'get_stats_by_regime',
        description: 'Win rate and average P&L grouped by the market regime recorded at entry. Use for questions about which market conditions the trader does well or badly in.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    run: async () => q(`
      SELECT conviction_breakdown->>'regime' AS regime,
             COUNT(*)                        AS trades,
             ROUND(100.0 * SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS win_rate_pct,
             ROUND(AVG(pnl_usd)::numeric, 2) AS avg_pnl
      FROM trades
      WHERE status = 'closed' AND pnl_usd IS NOT NULL
        AND conviction_breakdown->>'regime' IS NOT NULL
      GROUP BY regime ORDER BY win_rate_pct DESC
    `),
  },

  get_symbol_performance: {
    def: {
      type: 'function',
      function: {
        name: 'get_symbol_performance',
        description: 'Per-symbol performance (symbols with >=2 closed trades). Use for best/worst symbols, or any question naming a ticker. order="best" returns highest avg P&L first; order="worst" returns lowest first.',
        parameters: {
          type: 'object',
          properties: {
            order: { type: 'string', enum: ['best', 'worst'], description: 'best = highest avg P&L first; worst = lowest first' },
            limit: { type: 'integer', description: 'How many symbols to return (1-20, default 5)' },
          },
          required: [],
        },
      },
    },
    run: async (args) => {
      const dir = args?.order === 'worst' ? 'ASC' : 'DESC'; // whitelist, never interpolate raw
      const limit = clampInt(args?.limit, 5, 1, 20);
      return q(`
        SELECT symbol,
               COUNT(*)                        AS trades,
               ROUND(SUM(pnl_usd)::numeric, 2) AS total_pnl,
               ROUND(AVG(pnl_usd)::numeric, 2) AS avg_pnl,
               ROUND(100.0 * SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS win_rate_pct
        FROM trades
        WHERE status = 'closed' AND pnl_usd IS NOT NULL
        GROUP BY symbol HAVING COUNT(*) >= 2
        ORDER BY avg_pnl ${dir}
        LIMIT $1
      `, [limit]);
    },
  },

  get_recent_trades: {
    def: {
      type: 'function',
      function: {
        name: 'get_recent_trades',
        description: 'Individual closed trades, newest first, with date, symbol, side, P&L, conviction score/grade, exit reason and thesis. Pass symbol to filter to one ticker. Use for questions about specific or recent trades.',
        parameters: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Optional ticker filter, e.g. "MU"' },
            limit:  { type: 'integer', description: 'How many trades to return (1-30, default 10)' },
          },
          required: [],
        },
      },
    },
    run: async (args) => {
      const limit = clampInt(args?.limit, 10, 1, 30);
      const sym = typeof args?.symbol === 'string' && args.symbol.trim()
        ? args.symbol.trim().toUpperCase() : null;
      return q(`
        SELECT closed_at::date          AS date,
               symbol, side,
               ROUND(pnl_usd::numeric, 2) AS pnl_usd,
               ROUND(pnl_pct::numeric, 2) AS pnl_pct,
               conviction_score, conviction_grade,
               conviction_breakdown->>'regime' AS regime,
               exit_reason, setup_type, thesis
        FROM trades
        WHERE status = 'closed' AND pnl_usd IS NOT NULL
          AND ($1::text IS NULL OR symbol = $1)
        ORDER BY closed_at DESC NULLS LAST
        LIMIT $2
      `, [sym, limit]);
    },
  },

  get_lessons: {
    def: {
      type: 'function',
      function: {
        name: 'get_lessons',
        description: 'Recorded lessons from closed trades (trade_lessons table). Optionally filter by symbol or outcome ("win"/"loss"). Use for questions about mistakes, what went wrong, or what to repeat.',
        parameters: {
          type: 'object',
          properties: {
            symbol:  { type: 'string', description: 'Optional ticker filter' },
            outcome: { type: 'string', enum: ['win', 'loss'], description: 'Optional outcome filter' },
            limit:   { type: 'integer', description: 'How many lessons (1-30, default 15)' },
          },
          required: [],
        },
      },
    },
    run: async (args) => {
      const limit = clampInt(args?.limit, 15, 1, 30);
      const sym = typeof args?.symbol === 'string' && args.symbol.trim()
        ? args.symbol.trim().toUpperCase() : null;
      const outcome = (args?.outcome === 'win' || args?.outcome === 'loss') ? args.outcome : null;
      return q(`
        SELECT date, symbol, outcome, regime,
               ROUND(pnl_usd::numeric, 2) AS pnl_usd, lesson
        FROM trade_lessons
        WHERE ($1::text IS NULL OR symbol = $1)
          AND ($2::text IS NULL OR LOWER(outcome) = $2)
        ORDER BY created_at DESC
        LIMIT $3
      `, [sym, outcome, limit]);
    },
  },
};

const TOOL_DEFS = Object.values(TOOLS).map(t => t.def);

async function ollamaChat(messages) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: COACH_MODEL,
      messages,
      tools: TOOL_DEFS,
      stream: false,
      options: { temperature: 0.3 },
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT),
  });
  if (!res.ok) throw new Error(`ollama /api/chat HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()).message; // { role, content, tool_calls? }
}

async function runTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) return { error: `unknown tool: ${name}` };
  try {
    const rows = await tool.run(args || {});
    return { ok: true, row_count: Array.isArray(rows) ? rows.length : (rows ? 1 : 0), data: rows };
  } catch (err) {
    return { error: `tool ${name} failed: ${err.message}` };
  }
}

/**
 * Ask the coach one question. Runs the full tool-calling loop and returns the
 * final natural-language answer plus a trace of which tools were called.
 *
 * @param {string} userMessage
 * @param {{ history?: Array<{role:string,content:string}>, verbose?: boolean }} [opts]
 * @returns {Promise<{ text: string, toolCalls: Array<{name:string,args:object,row_count?:number}> }>}
 */
export async function askCoach(userMessage, { history = [], verbose = false } = {}) {
  const messages = [...history, { role: 'user', content: userMessage }];
  const toolCalls = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const msg = await ollamaChat(messages);
    messages.push(msg);

    const calls = msg.tool_calls || [];
    if (calls.length === 0) {
      return { text: (msg.content || '').trim(), toolCalls };
    }

    for (const call of calls) {
      const name = call.function?.name;
      // Ollama returns arguments already parsed as an object; tolerate a string too.
      let args = call.function?.arguments ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }

      if (verbose) console.error(`  ↳ tool: ${name}(${JSON.stringify(args)})`);
      const result = await runTool(name, args);
      toolCalls.push({ name, args, row_count: result.row_count });

      messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result) });
    }
  }

  // Ran out of rounds — make one final non-tool pass for a best-effort answer.
  const final = await ollamaChat([
    ...messages,
    { role: 'user', content: 'Answer now using the data already gathered. Do not call more tools.' },
  ]);
  return { text: (final.content || '').trim(), toolCalls };
}

export async function closeCoach() {
  await pool.end();
}

// Exported for tests / the eval harness.
export { TOOLS, TOOL_DEFS };
