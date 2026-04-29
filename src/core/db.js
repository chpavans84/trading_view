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

CREATE TABLE IF NOT EXISTS api_calls (
  id                SERIAL PRIMARY KEY,
  called_at         TIMESTAMPTZ DEFAULT NOW(),
  source            VARCHAR(40) NOT NULL,
  input_tokens      INT NOT NULL DEFAULT 0,
  output_tokens     INT NOT NULL DEFAULT 0,
  tool_calls        INT NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(10,6) NOT NULL DEFAULT 0,
  duration_ms       INT,
  model             VARCHAR(60)
);
CREATE INDEX IF NOT EXISTS idx_api_calls_called_at ON api_calls(called_at);
CREATE INDEX IF NOT EXISTS idx_api_calls_source    ON api_calls(source);
-- Add new columns to existing tables created before this migration
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_calls') THEN NULL; END IF;
END $$;

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
  name              VARCHAR(100),
  score             INT NOT NULL,
  grade             VARCHAR(5),
  breakdown         JSONB,
  signals           JSONB,
  tv_available      BOOLEAN,
  technical_summary TEXT,
  scored_at         TIMESTAMPTZ DEFAULT NOW()
);
-- Add name column to existing tables created before this migration
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conviction_scores' AND column_name='name') THEN
    ALTER TABLE conviction_scores ADD COLUMN name VARCHAR(100);
  END IF;
END $$;
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

CREATE TABLE IF NOT EXISTS doc_queries (
  id           SERIAL PRIMARY KEY,
  query        TEXT NOT NULL,
  found        BOOLEAN NOT NULL DEFAULT false,
  user_ip      VARCHAR(64),
  user_agent   TEXT,
  notified     BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_doc_queries_created ON doc_queries(created_at);
CREATE INDEX IF NOT EXISTS idx_doc_queries_found   ON doc_queries(found);

CREATE TABLE IF NOT EXISTS user_activity (
  id          SERIAL PRIMARY KEY,
  username    VARCHAR(64) NOT NULL,
  action      VARCHAR(80) NOT NULL,
  detail      TEXT,
  ip          VARCHAR(64),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_activity_username   ON user_activity(username);
CREATE INDEX IF NOT EXISTS idx_user_activity_created_at ON user_activity(created_at);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(64)  NOT NULL UNIQUE,
  email         VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'viewer',
  plan          VARCHAR(20)  NOT NULL DEFAULT 'free',
  credits       INT          NOT NULL DEFAULT 0,
  permissions   JSONB,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  last_login    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);

CREATE TABLE IF NOT EXISTS otp_tokens (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  code_hash  VARCHAR(64)  NOT NULL,
  expires_at TIMESTAMPTZ  NOT NULL,
  used       BOOLEAN      DEFAULT false,
  created_at TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_tokens(email);

-- Add username column to api_calls for per-user cost tracking
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_calls' AND column_name='username') THEN
    ALTER TABLE api_calls ADD COLUMN username VARCHAR(64);
  END IF;
END $$;
-- Add Alpaca credentials columns to users
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='alpaca_api_key') THEN
    ALTER TABLE users ADD COLUMN alpaca_api_key    VARCHAR(255);
    ALTER TABLE users ADD COLUMN alpaca_secret_key VARCHAR(255);
    ALTER TABLE users ADD COLUMN alpaca_base_url   VARCHAR(255);
  END IF;
END $$;
-- Add separate live Alpaca credential columns (paper and live stored independently)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='alpaca_live_api_key') THEN
    ALTER TABLE users ADD COLUMN alpaca_live_api_key    VARCHAR(255);
    ALTER TABLE users ADD COLUMN alpaca_live_secret_key VARCHAR(255);
  END IF;
END $$;
-- Add suspended flag for admin account control
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='suspended') THEN
    ALTER TABLE users ADD COLUMN suspended BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;
-- Add per-user bot configuration (JSONB — null means use system defaults)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='bot_config') THEN
    ALTER TABLE users ADD COLUMN bot_config JSONB DEFAULT NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS bug_reports (
  id          SERIAL PRIMARY KEY,
  username    VARCHAR(64)  NOT NULL,
  title       VARCHAR(200) NOT NULL,
  description TEXT         NOT NULL,
  page        VARCHAR(100),
  status      VARCHAR(20)  NOT NULL DEFAULT 'open',
  admin_note  TEXT,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);
CREATE INDEX IF NOT EXISTS idx_bug_reports_user   ON bug_reports(username);

CREATE TABLE IF NOT EXISTS scanner_state (
  key        VARCHAR(50) PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_briefings (
  id         SERIAL PRIMARY KEY,
  date       DATE NOT NULL,
  type       VARCHAR(20) NOT NULL DEFAULT 'morning',
  content    TEXT NOT NULL,
  regime     VARCHAR(50),
  direction  VARCHAR(20),
  vix        NUMERIC(6,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (date, type)
);

-- Add type column + fix unique constraint for daily_briefings (supports morning + eod per day)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='daily_briefings' AND column_name='type') THEN
    ALTER TABLE daily_briefings ADD COLUMN type VARCHAR(20) DEFAULT 'morning';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='daily_briefings_date_key' AND table_name='daily_briefings') THEN
    ALTER TABLE daily_briefings DROP CONSTRAINT daily_briefings_date_key;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='daily_briefings_date_type_key' AND table_name='daily_briefings') THEN
    ALTER TABLE daily_briefings ADD CONSTRAINT daily_briefings_date_type_key UNIQUE (date, type);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS position_monitoring (
  symbol           VARCHAR(20) PRIMARY KEY,
  entry_price      NUMERIC(12,4),
  stop_price       NUMERIC(12,4),
  target_price     NUMERIC(12,4),
  stop_moved_to_be BOOLEAN DEFAULT FALSE,
  stop_trailed     BOOLEAN DEFAULT FALSE,
  last_checked_at  TIMESTAMPTZ,
  last_price       NUMERIC(12,4)
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

export async function recordApiCall({ source, inputTokens, outputTokens, toolCalls, costUsd, durationMs, model, username }) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO api_calls (source, input_tokens, output_tokens, tool_calls, cost_usd, duration_ms, model, username)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [source, inputTokens ?? 0, outputTokens ?? 0, toolCalls ?? 0, costUsd ?? 0, durationMs ?? null, model ?? null, username ?? null]
    );
  } catch (err) {
    console.error('recordApiCall error:', err.message);
  }
}

export async function getApiCallStats({ days = 30 } = {}) {
  if (!dbAvailable) return null;
  try {
    const { rows: daily } = await query(
      `SELECT
         called_at::date AS date,
         source,
         COUNT(*)                          AS calls,
         SUM(input_tokens)                 AS input_tokens,
         SUM(output_tokens)                AS output_tokens,
         SUM(tool_calls)                   AS tool_calls,
         SUM(cost_usd)                     AS cost_usd,
         ROUND(AVG(duration_ms))           AS avg_duration_ms,
         ROUND(AVG(input_tokens))          AS avg_input_tokens,
         ROUND(AVG(output_tokens))         AS avg_output_tokens
       FROM api_calls
       WHERE called_at >= NOW() - ($1 || ' days')::INTERVAL
       GROUP BY date, source
       ORDER BY date DESC, source`,
      [days]
    );
    const { rows: totals } = await query(
      `SELECT
         source,
         COUNT(*)          AS total_calls,
         SUM(input_tokens) AS total_input,
         SUM(output_tokens)AS total_output,
         SUM(tool_calls)   AS total_tools,
         SUM(cost_usd)     AS total_cost,
         MIN(called_at)    AS first_call,
         MAX(called_at)    AS last_call
       FROM api_calls
       WHERE called_at >= NOW() - ($1 || ' days')::INTERVAL
       GROUP BY source
       ORDER BY total_cost DESC`,
      [days]
    );
    const { rows: recent } = await query(
      `SELECT source, input_tokens, output_tokens, tool_calls, cost_usd, duration_ms, model, called_at
       FROM api_calls
       ORDER BY called_at DESC LIMIT 50`
    );
    return { daily, totals, recent };
  } catch (err) {
    console.error('getApiCallStats error:', err.message);
    return null;
  }
}

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
  symbol, name, score, grade, breakdown, signals, tv_available, technical_summary,
}) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO conviction_scores (symbol, name, score, grade, breakdown, signals, tv_available, technical_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [symbol, name ?? null, Math.round(score), grade,
       breakdown ? JSON.stringify(breakdown) : null,
       signals   ? JSON.stringify(signals)   : null,
       tv_available ?? false,
       technical_summary ?? null]
    );
  } catch (err) {
    console.error('recordConvictionScore error:', err.message);
  }
}

// ─── Doc queries ─────────────────────────────────────────────────────────────

export async function recordDocQuery({ query: searchQuery, found, userIp, userAgent }) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `INSERT INTO doc_queries (query, found, user_ip, user_agent)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [searchQuery, found, userIp || null, userAgent || null]
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error('recordDocQuery error:', err.message);
    return null;
  }
}

export async function getDocQueries({ limit = 100, onlyUnanswered = false } = {}) {
  if (!dbAvailable) return [];
  try {
    const { rows } = await query(
      `SELECT id, query, found, user_ip, notified, created_at
       FROM doc_queries
       ${onlyUnanswered ? 'WHERE found = false' : ''}
       ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows;
  } catch (err) {
    console.error('getDocQueries error:', err.message);
    return [];
  }
}

export async function markDocQueryNotified(id) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE doc_queries SET notified = true WHERE id = $1`, [id]);
  } catch (_) {}
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

// ─── User activity ────────────────────────────────────────────────────────────

export async function logActivity(username, action, detail = null, ip = null) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO user_activity (username, action, detail, ip) VALUES ($1,$2,$3,$4)`,
      [username, action, detail, ip]
    );
  } catch (err) {
    console.error('logActivity error:', err.message);
  }
}

export async function getActivity({ username, limit = 100 } = {}) {
  if (!dbAvailable) return [];
  try {
    const where  = username ? 'WHERE username=$1' : '';
    const params = username ? [username, limit] : [limit];
    const { rows } = await query(
      `SELECT id, username, action, detail, ip,
              to_char(created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS ts
       FROM user_activity ${where}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return rows;
  } catch (err) {
    console.error('getActivity error:', err.message);
    return [];
  }
}

// ─── OTP tokens ──────────────────────────────────────────────────────────────

export async function createOtpToken(email, codeHash) {
  if (!dbAvailable) throw new Error('Database not available');
  // Invalidate any existing unused tokens for this email first
  await query(`UPDATE otp_tokens SET used = true WHERE email = $1 AND used = false`, [email.toLowerCase()]);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  await query(
    `INSERT INTO otp_tokens (email, code_hash, expires_at) VALUES ($1, $2, $3)`,
    [email.toLowerCase(), codeHash, expiresAt]
  );
}

export async function verifyOtpToken(email, codeHash) {
  if (!dbAvailable) return false;
  const { rows } = await query(
    `SELECT id FROM otp_tokens
     WHERE email = $1 AND code_hash = $2 AND used = false AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [email.toLowerCase(), codeHash]
  );
  if (!rows[0]) return false;
  await query(`UPDATE otp_tokens SET used = true WHERE id = $1`, [rows[0].id]);
  return true;
}

export async function cleanupOtpTokens() {
  if (!dbAvailable) return;
  await query(`DELETE FROM otp_tokens WHERE expires_at < NOW() OR used = true`).catch(() => {});
}

// ─── User management (DB-backed) ─────────────────────────────────────────────

export async function getDbUser(username) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(`SELECT * FROM users WHERE username = $1`, [username.toLowerCase()]);
    return rows[0] ?? null;
  } catch (err) {
    console.error('getDbUser error:', err.message);
    return null;
  }
}

export async function getDbUserByEmail(email) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
    return rows[0] ?? null;
  } catch (err) {
    console.error('getDbUserByEmail error:', err.message);
    return null;
  }
}

export async function createDbUser({ username, email, passwordHash, role = 'viewer', plan = 'free', credits = 100, permissions = null }) {
  const { rows } = await query(
    `INSERT INTO users (username, email, password_hash, role, plan, credits, permissions)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [username.toLowerCase(), email?.toLowerCase() ?? null, passwordHash, role, plan, credits,
     permissions ? JSON.stringify(permissions) : null]
  );
  return rows[0];
}

export async function upsertDbUser({ username, email, passwordHash, role, plan, credits, permissions }) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO users (username, email, password_hash, role, plan, credits, permissions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (username) DO NOTHING`,
      [username.toLowerCase(), email ?? null, passwordHash, role, plan ?? 'free', credits ?? 0,
       permissions ? JSON.stringify(permissions) : null]
    );
  } catch (err) {
    console.error('upsertDbUser error:', err.message);
  }
}

export async function updateDbUserLogin(username) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET last_login = NOW() WHERE username = $1`, [username.toLowerCase()]);
  } catch (err) {
    console.error('updateDbUserLogin error:', err.message);
  }
}

export async function deductCredit(username) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `UPDATE users SET credits = credits - 1 WHERE username = $1 AND credits > 0 RETURNING credits`,
      [username.toLowerCase()]
    );
    return rows[0]?.credits ?? null; // null = credits already 0, nothing deducted
  } catch (err) {
    console.error('deductCredit error:', err.message);
    return null;
  }
}

export async function addCredits(username, amount) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET credits = credits + $2 WHERE username = $1`, [username.toLowerCase(), amount]);
  } catch (err) {
    console.error('addCredits error:', err.message);
  }
}

export async function suspendUser(username) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET suspended = true WHERE username = $1`, [username.toLowerCase()]);
  } catch (err) {
    console.error('suspendUser error:', err.message);
  }
}

export async function unsuspendUser(username) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET suspended = false WHERE username = $1`, [username.toLowerCase()]);
  } catch (err) {
    console.error('unsuspendUser error:', err.message);
  }
}

export async function setUserCredits(username, amount) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET credits = $2 WHERE username = $1`, [username.toLowerCase(), amount]);
  } catch (err) {
    console.error('setUserCredits error:', err.message);
  }
}

export async function setUserRole(username, role) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET role = $2 WHERE username = $1`, [username.toLowerCase(), role]);
  } catch (err) {
    console.error('setUserRole error:', err.message);
  }
}

export async function resetUserPassword(username, passwordHash) {
  if (!dbAvailable) return;
  try {
    await query(`UPDATE users SET password_hash = $2 WHERE username = $1`, [username.toLowerCase(), passwordHash]);
  } catch (err) {
    console.error('resetUserPassword error:', err.message);
  }
}

export async function listDbUsers() {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `SELECT id, username, email, role, plan, credits, permissions, suspended, created_at, last_login
       FROM users ORDER BY created_at ASC`
    );
    return rows;
  } catch (err) {
    console.error('listDbUsers error:', err.message);
    return null;
  }
}

export async function updateDbUserPermissions(username, permissions) {
  await query(
    `UPDATE users SET permissions = $2 WHERE username = $1`,
    [username.toLowerCase(), permissions ? JSON.stringify(permissions) : null]
  );
}

export async function deleteDbUser(username) {
  await query(`DELETE FROM users WHERE username = $1`, [username.toLowerCase()]);
}

export async function saveUserAlpaca(username, { apiKey, secretKey, baseUrl, accountType }) {
  if (!dbAvailable) throw new Error('Database not available');
  if (accountType === 'live') {
    await query(
      `UPDATE users SET alpaca_live_api_key=$2, alpaca_live_secret_key=$3 WHERE username=$1`,
      [username.toLowerCase(), apiKey, secretKey]
    );
  } else {
    await query(
      `UPDATE users SET alpaca_api_key=$2, alpaca_secret_key=$3, alpaca_base_url=$4 WHERE username=$1`,
      [username.toLowerCase(), apiKey, secretKey, baseUrl]
    );
  }
}

export async function clearUserAlpaca(username) {
  if (!dbAvailable) return;
  await query(
    `UPDATE users SET alpaca_api_key=NULL, alpaca_secret_key=NULL, alpaca_base_url=NULL WHERE username=$1`,
    [username.toLowerCase()]
  );
}

export async function clearUserLiveAlpaca(username) {
  if (!dbAvailable) return;
  await query(
    `UPDATE users SET alpaca_live_api_key=NULL, alpaca_live_secret_key=NULL WHERE username=$1`,
    [username.toLowerCase()]
  );
}

// ─── Backtest Factor Weights ──────────────────────────────────────────────────
// Computes which score grade buckets historically generate alpha vs SPY.
// Cached in memory for 24h so it doesn't run on every conviction score call.

let _factorWeightsCache = null;
let _factorWeightsCacheTs = 0;
const FACTOR_WEIGHTS_TTL = 24 * 60 * 60 * 1000; // 24h

export async function getFactorWeights() {
  if (!dbAvailable) return null;
  if (_factorWeightsCache && Date.now() - _factorWeightsCacheTs < FACTOR_WEIGHTS_TTL)
    return _factorWeightsCache;

  try {
    // Win rate and avg alpha per grade across 1-month forward returns
    const { rows } = await query(`
      SELECT grade,
             COUNT(*)                                               AS signals,
             ROUND(AVG(ret_1m)::numeric, 4)                        AS avg_ret_1m,
             ROUND(AVG(ret_1m - spy_1m)::numeric, 4)               AS avg_alpha_1m,
             ROUND(100.0 * SUM(CASE WHEN ret_1m > 0 THEN 1 END) / COUNT(*), 1) AS win_rate_pct
      FROM backtest_returns
      WHERE ret_1m IS NOT NULL AND spy_1m IS NOT NULL
      GROUP BY grade
      ORDER BY grade
    `);

    // Express as a multiplier: grade A gets highest bonus, F gets a penalty
    const gradeAlpha = {};
    for (const r of rows) gradeAlpha[r.grade] = parseFloat(r.avg_alpha_1m);

    // Normalize to a -10..+10 point adjustment range
    const vals   = Object.values(gradeAlpha);
    const maxAlpha = Math.max(...vals);
    const minAlpha = Math.min(...vals);
    const range  = maxAlpha - minAlpha || 1;
    const adjustments = {};
    for (const [g, a] of Object.entries(gradeAlpha))
      adjustments[g] = +((a - minAlpha) / range * 20 - 10).toFixed(1);

    _factorWeightsCache = { by_grade: rows, adjustments, computed_at: new Date().toISOString() };
    _factorWeightsCacheTs = Date.now();
    return _factorWeightsCache;
  } catch (err) {
    console.error('getFactorWeights error:', err.message);
    return null;
  }
}

// ─── Per-User Bot Configuration ───────────────────────────────────────────────

export const BOT_CONFIG_DEFAULTS = {
  profile:              'moderate',
  daily_profit_target:  150,
  daily_loss_limit:     200,
  max_open_positions:   2,
  min_conviction_score: 50,
  auto_execute:         true,
  max_vix_for_scan:     30,
  position_sizing: {
    min_dollars:             1500,
    max_dollars:             5000,
    target_profit_per_trade: 150,
    stop_multiplier:         1.5,
    target_multiplier:       3.0,
    min_atr_pct:             1.0,
  },
  vix_thresholds: {
    defensive: 25,
    crisis:    35,
  },
  sectors_blocklist: [],
};

function _deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const key of Object.keys(overrides || {})) {
    if (overrides[key] !== null && typeof overrides[key] === 'object' && !Array.isArray(overrides[key])) {
      result[key] = _deepMerge(defaults[key] || {}, overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

export async function getUserBotConfig(username) {
  if (!isDbAvailable()) return { ...BOT_CONFIG_DEFAULTS };
  try {
    const r = await query('SELECT bot_config FROM users WHERE username = $1', [username.toLowerCase()]);
    const stored = r.rows[0]?.bot_config;
    if (!stored) return { ...BOT_CONFIG_DEFAULTS };
    return _deepMerge(BOT_CONFIG_DEFAULTS, stored);
  } catch {
    return { ...BOT_CONFIG_DEFAULTS };
  }
}

export async function setUserBotConfig(username, config) {
  if (!isDbAvailable()) throw new Error('Database not available');
  await query('UPDATE users SET bot_config = $1 WHERE username = $2', [JSON.stringify(config), username.toLowerCase()]);
}

// ─── Bug Reports ──────────────────────────────────────────────────────────────

export async function createBugReport({ username, title, description, page }) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `INSERT INTO bug_reports (username, title, description, page)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [username, title, description, page || null]
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error('createBugReport error:', err.message);
    return null;
  }
}

export async function getBugReports({ status, limit = 100 } = {}) {
  if (!dbAvailable) return [];
  try {
    const { rows } = await query(
      `SELECT id, username, title, description, page, status, admin_note, created_at, resolved_at
       FROM bug_reports
       ${status ? 'WHERE status = $1' : ''}
       ORDER BY created_at DESC LIMIT ${limit}`,
      status ? [status] : []
    );
    return rows;
  } catch (err) {
    console.error('getBugReports error:', err.message);
    return [];
  }
}

export async function updateBugReport({ id, status, admin_note }) {
  if (!dbAvailable) return false;
  try {
    const resolved_at = status === 'resolved' ? 'NOW()' : 'NULL';
    await query(
      `UPDATE bug_reports
       SET status     = COALESCE($2, status),
           admin_note = COALESCE($3, admin_note),
           resolved_at = CASE WHEN $2 = 'resolved' THEN NOW() ELSE resolved_at END
       WHERE id = $1`,
      [id, status || null, admin_note ?? null]
    );
    return true;
  } catch (err) {
    console.error('updateBugReport error:', err.message);
    return false;
  }
}

// ─── Scanner State (replaces .scanner-paused flag file) ───────────────────────

export async function getScannerState(key) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(`SELECT value FROM scanner_state WHERE key = $1`, [key]);
    return rows[0]?.value ?? null;
  } catch (err) {
    console.error('getScannerState error:', err.message);
    return null;
  }
}

export async function setScannerState(key, value) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO scanner_state (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  } catch (err) {
    console.error('setScannerState error:', err.message);
  }
}

// ─── Daily Briefings ──────────────────────────────────────────────────────────

export async function saveDailyBriefing({ date, content, regime = null, direction = null, vix = null, type = 'morning' }) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO daily_briefings (date, type, content, regime, direction, vix)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (date, type) DO UPDATE SET content=$3, regime=$4, direction=$5, vix=$6, created_at=NOW()`,
      [date, type, content, regime, direction, vix]
    );
  } catch (err) {
    console.error('saveDailyBriefing error:', err.message);
  }
}

export async function getDailyBriefing(date, type = 'morning') {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(
      `SELECT * FROM daily_briefings WHERE date = $1 AND type = $2`, [date, type]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error('getDailyBriefing error:', err.message);
    return null;
  }
}

// ─── Position Monitoring State ─────────────────────────────────────────────────

export async function upsertPositionMonitoring(row) {
  if (!dbAvailable) return;
  try {
    await query(
      `INSERT INTO position_monitoring
         (symbol, entry_price, stop_price, target_price, stop_moved_to_be, stop_trailed, last_checked_at, last_price)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
       ON CONFLICT (symbol) DO UPDATE SET
         entry_price      = COALESCE($2, position_monitoring.entry_price),
         stop_price       = COALESCE($3, position_monitoring.stop_price),
         target_price     = COALESCE($4, position_monitoring.target_price),
         stop_moved_to_be = $5,
         stop_trailed     = $6,
         last_checked_at  = NOW(),
         last_price       = $7`,
      [row.symbol, row.entry_price, row.stop_price, row.target_price,
       row.stop_moved_to_be ?? false, row.stop_trailed ?? false, row.last_price]
    );
  } catch (err) {
    console.error('upsertPositionMonitoring error:', err.message);
  }
}

export async function getPositionMonitoring(symbol) {
  if (!dbAvailable) return null;
  try {
    const { rows } = await query(`SELECT * FROM position_monitoring WHERE symbol = $1`, [symbol]);
    return rows[0] ?? null;
  } catch (err) { return null; }
}

export async function getAllPositionMonitoring() {
  if (!dbAvailable) return [];
  try {
    const { rows } = await query(`SELECT * FROM position_monitoring`);
    return rows;
  } catch (err) { return []; }
}

export async function deletePositionMonitoring(symbol) {
  if (!dbAvailable) return;
  try {
    await query(`DELETE FROM position_monitoring WHERE symbol = $1`, [symbol]);
  } catch (err) { console.error('deletePositionMonitoring error:', err.message); }
}
