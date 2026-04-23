/**
 * PostgreSQL database layer.
 * Gracefully degrades — bot continues without DB if DATABASE_URL is unset.
 */

import pg from 'pg';
const { Pool } = pg;

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_history (
  id          SERIAL PRIMARY KEY,
  chat_id     BIGINT NOT NULL,
  role        VARCHAR(20) NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conv_chat_id ON conversation_history(chat_id);

CREATE TABLE IF NOT EXISTS usage_stats (
  id                  SERIAL PRIMARY KEY,
  date                DATE NOT NULL UNIQUE,
  total_messages      INT DEFAULT 0,
  total_tool_calls    INT DEFAULT 0,
  input_tokens        BIGINT DEFAULT 0,
  output_tokens       BIGINT DEFAULT 0,
  estimated_cost_usd  NUMERIC(10,4) DEFAULT 0,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trades (
  id                   SERIAL PRIMARY KEY,
  order_id             VARCHAR(100) UNIQUE,
  symbol               VARCHAR(20) NOT NULL,
  side                 VARCHAR(10) NOT NULL,
  qty                  NUMERIC(10,4),
  entry_price          NUMERIC(12,4),
  stop_loss            NUMERIC(12,4),
  take_profit          NUMERIC(12,4),
  dollars_invested     NUMERIC(12,2),
  stop_loss_pct        NUMERIC(6,2),
  take_profit_pct      NUMERIC(6,2),
  atr_pct              NUMERIC(6,2),
  conviction_score     INT,
  conviction_grade     VARCHAR(5),
  conviction_breakdown JSONB,
  status               VARCHAR(20) DEFAULT 'open',
  exit_price           NUMERIC(12,4),
  pnl_usd              NUMERIC(12,2),
  pnl_pct              NUMERIC(8,4),
  opened_at            TIMESTAMPTZ DEFAULT NOW(),
  closed_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trades_symbol    ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status    ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades(opened_at);

CREATE TABLE IF NOT EXISTS conviction_scores (
  id                SERIAL PRIMARY KEY,
  symbol            VARCHAR(20) NOT NULL,
  score             INT NOT NULL,
  grade             VARCHAR(5),
  breakdown         JSONB,
  signals           JSONB,
  tv_available      BOOLEAN,
  technical_summary TEXT,
  scored_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scores_symbol    ON conviction_scores(symbol);
CREATE INDEX IF NOT EXISTS idx_scores_scored_at ON conviction_scores(scored_at);

CREATE TABLE IF NOT EXISTS daily_pnl (
  id             SERIAL PRIMARY KEY,
  date           DATE NOT NULL UNIQUE,
  realized_pnl   NUMERIC(12,2) DEFAULT 0,
  unrealized_pnl NUMERIC(12,2) DEFAULT 0,
  total_trades   INT DEFAULT 0,
  winning_trades INT DEFAULT 0,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
`;

// ─── Pool ─────────────────────────────────────────────────────────────────────

let pool = null;
let dbAvailable = false;

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('⚠️  DATABASE_URL not set — running without database (JSON fallback active)');
    return;
  }

  pool = new Pool({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    console.error('DB pool error:', err.message);
  });

  try {
    const client = await pool.connect();
    await client.query(SCHEMA);
    client.release();
    dbAvailable = true;
    console.log('✅ Database connected and schema ready');
  } catch (err) {
    console.warn(`⚠️  Database unavailable (${err.message}) — running without database`);
    await pool.end().catch(() => {});
    pool = null;
  }
}

export function isDbAvailable() {
  return dbAvailable;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

export async function query(sql, params = []) {
  if (!pool) throw new Error('Database not available');
  const result = await pool.query(sql, params);
  return result;
}

export async function getClient() {
  if (!pool) throw new Error('Database not available');
  return pool.connect();
}

// ─── Conversation history ─────────────────────────────────────────────────────

export async function loadConversationHistory(chatId) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `SELECT role, content FROM conversation_history
       WHERE chat_id = $1 ORDER BY created_at ASC`,
      [chatId]
    );
    return rows.map(r => ({ role: r.role, content: r.content }));
  } catch (err) {
    console.error('loadConversationHistory error:', err.message);
    return null;
  }
}

export async function appendConversationMessage(chatId, role, content) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO conversation_history (chat_id, role, content) VALUES ($1, $2, $3)`,
      [chatId, role, typeof content === 'string' ? content : JSON.stringify(content)]
    );
    // Keep only last 40 messages per chat
    await query(
      `DELETE FROM conversation_history
       WHERE chat_id = $1 AND id NOT IN (
         SELECT id FROM conversation_history
         WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 40
       )`,
      [chatId]
    );
  } catch (err) {
    console.error('appendConversationMessage error:', err.message);
  }
}

export async function clearConversationHistory(chatId) {
  if (!dbAvailable) return;
  try {
    await query(`DELETE FROM conversation_history WHERE chat_id = $1`, [chatId]);
  } catch (err) {
    console.error('clearConversationHistory error:', err.message);
  }
}

// ─── Usage stats ──────────────────────────────────────────────────────────────

export async function upsertUsageStats({ inputTokens, outputTokens, toolCalls, costUsd }) {
  if (!dbAvailable) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    await query(
      `INSERT INTO usage_stats (date, total_messages, total_tool_calls, input_tokens, output_tokens, estimated_cost_usd, updated_at)
       VALUES ($1, 1, $2, $3, $4, $5, NOW())
       ON CONFLICT (date) DO UPDATE SET
         total_messages     = usage_stats.total_messages + 1,
         total_tool_calls   = usage_stats.total_tool_calls + $2,
         input_tokens       = usage_stats.input_tokens + $3,
         output_tokens      = usage_stats.output_tokens + $4,
         estimated_cost_usd = usage_stats.estimated_cost_usd + $5,
         updated_at         = NOW()`,
      [today, toolCalls ?? 0, inputTokens ?? 0, outputTokens ?? 0, costUsd ?? 0]
    );
  } catch (err) {
    console.error('upsertUsageStats error:', err.message);
  }
}

export async function getUsageStats({ days = 30 } = {}) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `SELECT * FROM usage_stats
       WHERE date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
       ORDER BY date DESC`,
      [days]
    );
    return rows;
  } catch (err) {
    console.error('getUsageStats error:', err.message);
    return null;
  }
}

// ─── Trade recording ──────────────────────────────────────────────────────────

export async function recordTrade({
  order_id, symbol, side, qty, entry_price,
  stop_loss, take_profit, dollars_invested,
  stop_loss_pct, take_profit_pct, atr_pct,
  conviction_score, conviction_grade, conviction_breakdown,
}) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `INSERT INTO trades
         (order_id, symbol, side, qty, entry_price, stop_loss, take_profit,
          dollars_invested, stop_loss_pct, take_profit_pct, atr_pct,
          conviction_score, conviction_grade, conviction_breakdown)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING id`,
      [order_id, symbol, side, qty, entry_price, stop_loss, take_profit,
       dollars_invested, stop_loss_pct, take_profit_pct, atr_pct,
       conviction_score, conviction_grade,
       conviction_breakdown ? JSON.stringify(conviction_breakdown) : null]
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error('recordTrade error:', err.message);
    return null;
  }
}

export async function closeTrade({ order_id, exit_price, pnl_usd, pnl_pct }) {
  if (!dbAvailable) return;
  try {
    await query(
      `UPDATE trades SET status='closed', exit_price=$2, pnl_usd=$3, pnl_pct=$4, closed_at=NOW()
       WHERE order_id=$1`,
      [order_id, exit_price, pnl_usd, pnl_pct]
    );
  } catch (err) {
    console.error('closeTrade error:', err.message);
  }
}

export async function getTrades({ status, limit = 50 } = {}) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `SELECT * FROM trades
       ${status ? 'WHERE status = $1' : ''}
       ORDER BY opened_at DESC LIMIT ${limit}`,
      status ? [status] : []
    );
    return rows;
  } catch (err) {
    console.error('getTrades error:', err.message);
    return null;
  }
}

// ─── Conviction score history ─────────────────────────────────────────────────

export async function recordConvictionScore({
  symbol, score, grade, breakdown, signals, tv_available, technical_summary,
}) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO conviction_scores (symbol, score, grade, breakdown, signals, tv_available, technical_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [symbol, score, grade,
       breakdown ? JSON.stringify(breakdown) : null,
       signals   ? JSON.stringify(signals)   : null,
       tv_available ?? false,
       technical_summary ?? null]
    );
  } catch (err) {
    console.error('recordConvictionScore error:', err.message);
  }
}

// ─── Daily P&L ────────────────────────────────────────────────────────────────

export async function upsertDailyPnl({ date, realized_pnl, unrealized_pnl, total_trades, winning_trades }) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO daily_pnl (date, realized_pnl, unrealized_pnl, total_trades, winning_trades, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (date) DO UPDATE SET
         realized_pnl   = $2,
         unrealized_pnl = $3,
         total_trades   = $4,
         winning_trades = $5,
         updated_at     = NOW()`,
      [date, realized_pnl ?? 0, unrealized_pnl ?? 0, total_trades ?? 0, winning_trades ?? 0]
    );
  } catch (err) {
    console.error('upsertDailyPnl error:', err.message);
  }
}

export async function getDailyPnlHistory({ days = 30 } = {}) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `SELECT * FROM daily_pnl
       WHERE date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
       ORDER BY date DESC`,
      [days]
    );
    return rows;
  } catch (err) {
    console.error('getDailyPnlHistory error:', err.message);
    return null;
  }
}
