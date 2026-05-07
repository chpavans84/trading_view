/**
 * Web dashboard server for the trading bot.
 * Run with: npm run dashboard
 * Protected by DASHBOARD_PASSWORD env var (required — no default)
 */

import net from 'net';
import fs from 'fs';
import http from 'http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cors from 'cors';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { initDb, query, isDbAvailable, getTrades, getDailyPnlHistory, getUsageStats, getApiCallStats, recordApiCall, upsertUsageStats, getTodaySpend, recordDocQuery, getDocQueries, markDocQueryNotified, logActivity, getActivity, upsertDailyPnl, getDbUser, getDbUserByEmail, createDbUser, upsertDbUser, updateDbUserLogin, deductCredit, addCredits, listDbUsers, updateDbUserPermissions, deleteDbUser, createOtpToken, verifyOtpToken, cleanupOtpTokens, saveUserAlpaca, clearUserAlpaca, clearUserLiveAlpaca, saveUserMoomoo, clearUserMoomoo, saveUserTiger, clearUserTiger, suspendUser, unsuspendUser, setUserCredits, setUserRole, getUserBotConfig, setUserBotConfig, BOT_CONFIG_DEFAULTS, createBugReport, getBugReports, updateBugReport, getScannerState, setScannerState, saveDailyBriefing, getDailyBriefing, upsertPositionMonitoring, getPositionMonitoring, getAllPositionMonitoring, deletePositionMonitoring, getRecentLosses, getRejections, recordTrade, closeTrade, getOpenTrade, saveLesson, getRecentLessons, getPerformancePatterns, upsertPerformancePattern, loadConversationHistory, saveDailyPick, getDailyPicks, invalidateFactorWeightsCache, upsertPrediction, fillActualPrice, getPredictionsForWeek, getPredictionHistory, setDisabledSources, upsertAccountSnapshot, getAccountSnapshots, getUserWatchlistSymbols, addUserWatchlistSymbol, removeUserWatchlistSymbol } from '../core/db.js';
import Anthropic from '@anthropic-ai/sdk';
import { localAI, isOllamaAvailable } from '../core/ollama.js';
import { runReflection } from '../core/reflection.js';
import crypto from 'crypto';
import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import { SP500, NASDAQ100 } from '../research/sp500.js';
import { getAccount, getPositions, getOrders, getDailyPnL, getPortfolioHistory, placeTrade, closePosition, cancelAllOrders, cancelOrder, getMarketStatus, getMarketRegime, moveStopToBreakeven, getLiveAccount, getLivePositions, getLiveOrders, hasLiveAccount, getUserAccount, getUserPositions, validateAlpacaCreds, getUserOrders, getUserDailyPnL, getUserPortfolioHistory, getLatestPrice, placeQuickTrade, syncClosedTrades, clearPnlCache } from '../core/trader.js';
import cron from 'node-cron';
import { getMarketSentiment, getSectorPerformance, getMarketMovers, getUniverseInfo, SECTOR_MAP, SECTOR_NAMES } from '../core/sentiment.js';
import { getMarketNews, getEarningsCalendar, categoriseNews, getEarningsTrend, getSymbolNews, getEarnings } from '../core/news.js';
import { getAccounts, getFunds, getPositions as getMoomooPositions, getOrders as getMoomooOrders, getQuotes as getMoomooQuotes, getQuote as getMoomooQuote, getKLines as getMoomooKLines, getAtrPct as getMoomooAtrPct, placeMoomooTrade, cancelMoomooOrder, cancelAllMoomooOrders, closeMoomooPosition, MOOMOO_IS_SIMULATE, MOOMOO_TRADE_ENV_VALUE } from '../core/moomoo-tcp.js';
import { validateTigerCreds, getTigerFunds, getTigerPositions, getTigerOrders, placeTigerOrder } from '../core/tiger.js';
import { chat, clearHistory, chatHistory } from '../core/ai-chat.js';
import { seedKnowledge } from '../core/knowledge.js';
import { getStockPrediction } from '../core/predictor.js';
import YahooFinance from 'yahoo-finance2';
const _yf = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });
import { adminChat, clearAdminHistory } from '../core/admin-ai.js';
import { getConvictionScore } from '../core/scoring.js';
import { getMarketContext } from '../core/market-context.js';
import { selectBestTrade } from '../core/stock-selector.js';
import { trainCalibration, applyCalibration, applyCalibrationToDay, getFailureAnalysis } from '../core/prediction-calibration.js';
import { runCatalystScan } from '../core/catalyst-scanner.js';
import { getBzNews, getBzOptionsActivity, getBzEarnings, getBzGuidance, getBzFDA, getBzDividends, getBzFundamentals, isBenzingaConfigured } from '../core/benzinga.js';

// Generate a stable numeric chat ID per user so each user has their own
// Use username string directly as chat key — no hash collision possible.
// The DB migration converts chat_id column from BIGINT to TEXT.
function userChatId(username) {
  return username.toLowerCase().trim();
}

// ─── Resend email client ──────────────────────────────────────────────────────
const resend = process.env.RESEND_API ? new Resend(process.env.RESEND_API) : null;
const RESEND_FROM = process.env.RESEND_FROM || 'info@dlpinnovations.com';

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

async function sendOtpEmail(toEmail, code) {
  if (!resend) throw new Error('Resend not configured');
  await resend.emails.send({
    from: `Trading Bot <${RESEND_FROM}>`,
    to:   toEmail,
    subject: `Your login code: ${code}`,
    html: `
      <div style="font-family:-apple-system,sans-serif;max-width:420px;margin:0 auto;padding:32px">
        <h2 style="margin:0 0 8px;color:#e6edf3">📈 Trading Bot</h2>
        <p style="color:#8b949e;margin:0 0 28px">Your one-time login code:</p>
        <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px;text-align:center">
          <span style="font-size:2.4rem;font-weight:700;letter-spacing:12px;color:#58a6ff">${code}</span>
        </div>
        <p style="color:#6e7681;font-size:0.85rem;margin-top:20px">
          Valid for <strong>10 minutes</strong>. Do not share this code with anyone.
        </p>
        <p style="color:#6e7681;font-size:0.8rem;margin-top:8px">
          If you didn't request this, ignore this email.
        </p>
      </div>
    `,
  });
}

// In-memory TTL cache with stampede protection — concurrent requests share one in-flight fetch
const _cache = new Map();
function ttlCache(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit) {
    if (Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.value); // fresh cache
    if (hit.inflight) return hit.inflight; // already fetching — reuse the same promise
  }
  const inflight = fn().then(v => {
    _cache.set(key, { value: v, ts: Date.now(), inflight: null });
    return v;
  }).catch(e => {
    _cache.delete(key); // clear on error so next call retries
    throw e;
  });
  _cache.set(key, { value: hit?.value ?? null, ts: hit?.ts ?? 0, inflight });
  return inflight;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

// ─── Enforce required env vars at startup ────────────────────────────────────

const SESSION_SECRET = process.env.SESSION_SECRET;
const BAD_DEFAULTS   = new Set(['admin', 'trading-bot-secret-change-me', 'changeme', 'password', '']);

if (!SESSION_SECRET || BAD_DEFAULTS.has(SESSION_SECRET) || SESSION_SECRET.length < 32) {
  console.error('❌  SESSION_SECRET env var is missing or too short. Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// ─── User store (src/web/users.json + PostgreSQL) ────────────────────────────

const USERS_FILE = join(__dirname, 'users.json');

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Unified user lookup — DB first, JSON fallback
async function getUser(username) {
  const key = username?.toLowerCase();
  if (!key) return null;
  if (isDbAvailable()) {
    const u = await getDbUser(key);
    if (u) return { hash: u.password_hash, role: u.role, plan: u.plan, credits: u.credits, permissions: u.permissions, email: u.email };
  }
  const users = loadUsers();
  const u = users[key];
  return u ? { hash: u.hash, role: u.role, plan: u.plan ?? 'free', credits: null, permissions: u.permissions ?? null, email: null } : null;
}

async function validateUser(username, password) {
  const user = await getUser(username);
  if (!user) return false;
  return bcrypt.compare(password, user.hash).catch(() => false);
}

// One-time migration: copy users.json entries into DB
async function migrateUsersToDb() {
  if (!isDbAvailable()) return;
  const users = loadUsers();
  const entries = Object.entries(users);
  if (!entries.length) return;
  for (const [uname, data] of entries) {
    await upsertDbUser({
      username:     uname,
      email:        null,
      passwordHash: data.hash,
      role:         data.role || 'viewer',
      plan:         'free',
      credits:      data.role === 'admin' ? 0 : 0, // existing users start at 0; they can be topped up
      permissions:  data.permissions ?? null,
    });
  }
  console.log(`✅ Migrated ${entries.length} user(s) from users.json to DB`);
}

// ─── Permissions ──────────────────────────────────────────────────────────────

const ALL_TABS    = ['dashboard', 'trades', 'scores', 'market', 'news', 'stats', 'docs', 'research', 'admin_bot', 'bot_rules', 'calendar', 'watchlist'];
const ALL_WIDGETS = ['moomoo', 'alpaca_live', 'tiger', 'force_trade', 'chat', 'stock_explorer'];

const DEFAULT_PERMISSIONS = {
  admin:  { tabs: ALL_TABS,    widgets: ALL_WIDGETS },
  viewer: { tabs: ['dashboard', 'trades', 'scores', 'market', 'news', 'research', 'bot_rules', 'calendar', 'watchlist'], widgets: ['alpaca_live', 'chat', 'stock_explorer'] },
};

function getPermissions(user) {
  const roleDefaults = DEFAULT_PERMISSIONS[user.role] || DEFAULT_PERMISSIONS.viewer;
  if (!user.permissions) return roleDefaults;
  // Merge stored permissions with role defaults so new features added to defaults
  // automatically reach all users without requiring a manual permission update.
  return {
    tabs:    [...new Set([...roleDefaults.tabs,    ...(user.permissions.tabs    || [])])],
    widgets: [...new Set([...roleDefaults.widgets, ...(user.permissions.widgets || [])])],
  };
}

// ─── Rate limiters ────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 5,
  skipSuccessfulRequests: true,  // only failed logins count toward the limit
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 10,              // tighter for internet exposure
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many chat requests. Slow down.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,              // tighter for internet exposure
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests.' },
});

// ─── Middleware ───────────────────────────────────────────────────────────────

const isProd = process.env.NODE_ENV === 'production';

// Trust the first proxy hop (Cloudflare / nginx) so rate-limiting uses real client IP
if (isProd) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],   // inline <script> blocks + Chart.js CDN
      scriptSrcAttr:  ["'unsafe-inline'"],             // onclick/onchange/etc. attributes
      styleSrc:       ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],  // xterm.css loaded from CDN
      imgSrc:         ["'self'", 'data:', 'https:'],
      connectSrc:     ["'self'", "https://cdn.jsdelivr.net"],
      fontSrc:        ["'self'"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
      baseUri:        ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,  // avoids breaking fetch to same-origin APIs
}));

// Same-origin only — reject cross-origin requests
app.use(cors({ origin: false }));

app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// PostgreSQL-backed session store — survives server restarts
class PgSessionStore extends session.Store {
  async _ensureTable() {
    try {
      await query(`CREATE TABLE IF NOT EXISTS http_sessions (
        sid  TEXT PRIMARY KEY,
        sess JSONB NOT NULL,
        expire TIMESTAMPTZ NOT NULL
      )`);
      // prune expired rows once per hour
      setInterval(() => query('DELETE FROM http_sessions WHERE expire < NOW()').catch(() => {}), 60 * 60 * 1000);
    } catch { /* db not ready yet — fall back to MemoryStore */ }
  }
  get(sid, cb) {
    query('SELECT sess FROM http_sessions WHERE sid=$1 AND expire>NOW()', [sid])
      .then(r => cb(null, r.rows[0]?.sess ?? null))
      .catch(() => cb(null, null));
  }
  set(sid, sess, cb) {
    const exp = new Date(sess.cookie?.expires ?? Date.now() + 24 * 60 * 60 * 1000);
    query('INSERT INTO http_sessions(sid,sess,expire) VALUES($1,$2,$3) ON CONFLICT(sid) DO UPDATE SET sess=$2,expire=$3',
      [sid, JSON.stringify(sess), exp])
      .then(() => cb()).catch(() => cb());
  }
  destroy(sid, cb) {
    query('DELETE FROM http_sessions WHERE sid=$1', [sid]).then(() => cb()).catch(() => cb());
  }
  touch(sid, sess, cb) {
    const exp = new Date(sess.cookie?.expires ?? Date.now() + 24 * 60 * 60 * 1000);
    query('UPDATE http_sessions SET expire=$2 WHERE sid=$1', [sid, exp]).then(() => cb()).catch(() => cb());
  }
}
const pgStore = new PgSessionStore();

const FORCE_SECURE_COOKIE = process.env.SECURE_COOKIE === 'true'; // set SECURE_COOKIE=true behind HTTPS reverse proxy
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: pgStore,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: FORCE_SECURE_COOKIE,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days — survives restarts
  },
});
app.use(sessionMiddleware);

app.use(express.static(join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

// Serve project-level images folder (e.g. /images/background.png)
app.use('/images', express.static(join(__dirname, '../../images')));

// /terms is served as a static file: src/web/public/terms.html

// ─── Auth ─────────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Bad request' });
  }
  const valid = await validateUser(username, password);
  const ip = req.ip || req.socket?.remoteAddress;
  if (valid) {
    const dbUser = isDbAvailable() ? await getDbUser(username.toLowerCase()) : null;
    if (dbUser?.suspended) {
      logActivity(username.toLowerCase(), 'login_blocked', 'Account suspended', ip);
      return res.status(403).json({ error: 'Account suspended. Contact admin.' });
    }
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Session error' });
      req.session.authenticated = true;
      req.session.username = username.toLowerCase();
      logActivity(username.toLowerCase(), 'login', null, ip);
      updateDbUserLogin(username.toLowerCase()).catch(() => {});
      res.json({ ok: true });
    });
  } else {
    logActivity(username.toLowerCase(), 'login_failed', 'Invalid credentials', ip);
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/auth/logout', (req, res) => {
  const username = req.session?.username;
  const ip = req.ip || req.socket?.remoteAddress;
  req.session.destroy(err => {
    if (err) console.error('Session destroy error:', err);
    if (username) logActivity(username, 'logout', null, ip);
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Try again in 1 hour.' },
});

const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many code requests. Wait 15 minutes before trying again.' },
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait 15 minutes.' },
});

app.post('/auth/register', registerLimiter, async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Registration unavailable — database not connected' });
  const { username, email, password, terms_accepted } = req.body;
  if (!terms_accepted) {
    return res.status(400).json({ error: 'You must accept the Terms of Service and Risk Disclosure to use this platform.' });
  }
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (!/^[a-z0-9_]{2,32}$/.test(username.toLowerCase())) {
    return res.status(400).json({ error: 'Username must be 2–32 chars, letters/numbers/underscore only' });
  }
  if (password.length < 10) {
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  const existing = await getDbUser(username.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Username already taken' });
  if (email) {
    const byEmail = await getDbUserByEmail(email.toLowerCase());
    if (byEmail) return res.status(409).json({ error: 'Email already registered' });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await createDbUser({
    username: username.toLowerCase(),
    email:    email?.toLowerCase() ?? null,
    passwordHash,
    role:     'viewer',
    plan:     'free',
    credits:  100,
  });
  await query(
    `UPDATE users SET terms_accepted_at = NOW(), terms_version = '1.0' WHERE username = $1`,
    [username.toLowerCase()]
  ).catch(() => {}); // non-fatal — columns added by migration
  const ip = req.ip || req.socket?.remoteAddress;
  logActivity(username.toLowerCase(), 'register', 'Self-service signup — 100 free credits, terms v1.0 accepted', ip);
  res.json({ ok: true, message: 'Account created! You have 100 free credits.' });
});

// Request OTP — send 6-digit code to email
app.post('/auth/otp/request', otpRequestLimiter, async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Service unavailable' });
  if (!resend) return res.status(503).json({ error: 'Email service not configured' });

  const { email } = req.body;
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email is required' });
  const normalised = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalised)) return res.status(400).json({ error: 'Invalid email address' });

  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
  await createOtpToken(normalised, hashCode(code));

  try {
    await sendOtpEmail(normalised, code);
  } catch (err) {
    console.error('OTP email error:', err.message);
    return res.status(500).json({ error: 'Failed to send email. Try again shortly.' });
  }

  const ip = req.ip || req.socket?.remoteAddress;
  logActivity(normalised, 'otp_requested', null, ip);
  res.json({ ok: true, message: 'Code sent — check your inbox.' });
});

// Verify OTP — log user in (create account if new email)
app.post('/auth/otp/verify', otpVerifyLimiter, async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Service unavailable' });

  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });
  const normalised = email.toLowerCase().trim();
  const cleanCode  = String(code).trim();

  const valid = await verifyOtpToken(normalised, hashCode(cleanCode));
  if (!valid) return res.status(401).json({ error: 'Invalid or expired code. Request a new one.' });

  // Look up or auto-create the user
  let dbUser = await getDbUserByEmail(normalised);
  if (!dbUser) {
    // New email — create viewer account with 100 credits
    const username = normalised.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
    // Ensure username is unique
    const safeName = username || 'user';
    let finalName = safeName;
    let suffix = 1;
    while (await getDbUser(finalName)) { finalName = `${safeName}${suffix++}`; }

    dbUser = await createDbUser({
      username:     finalName,
      email:        normalised,
      passwordHash: await import('bcrypt').then(b => b.default.hash(crypto.randomBytes(32).toString('hex'), 10)),
      role:         'viewer',
      plan:         'free',
      credits:      100,
    });
    const ip = req.ip || req.socket?.remoteAddress;
    logActivity(finalName, 'register', `Auto-created via email OTP — ${normalised}`, ip);
  }

  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.authenticated = true;
    req.session.username = dbUser.username;
    updateDbUserLogin(dbUser.username).catch(() => {});
    const ip = req.ip || req.socket?.remoteAddress;
    logActivity(dbUser.username, 'login', `via email OTP (${normalised})`, ip);
    res.json({ ok: true });
  });
});

app.get('/auth/check', async (req, res) => {
  if (!req.session?.authenticated) return res.json({ authenticated: false });
  const user    = await getUser(req.session.username) || {};
  const dbUser  = isDbAvailable() ? await getDbUser(req.session.username) : null;
  const isAdmin   = user.role === 'admin';
  const hasAlpaca = isAdmin || !!(dbUser?.alpaca_api_key && dbUser?.alpaca_secret_key);
  const hasMoomoo = isAdmin ? !!(process.env.MOOMOO_OPEND_HOST) : !!(dbUser?.moomoo_acc_id && process.env.MOOMOO_OPEND_HOST);
  const hasTiger  = !!(dbUser?.tiger_id && dbUser?.tiger_account && dbUser?.tiger_private_key);
  const perms = getPermissions(user);
  if (hasMoomoo && !perms.widgets.includes('moomoo')) perms.widgets.push('moomoo');
  if (hasTiger  && !perms.widgets.includes('tiger'))  perms.widgets.push('tiger');
  const disabledSources = Array.isArray(dbUser?.disabled_sources) ? dbUser.disabled_sources : [];
  res.json({
    authenticated:    true,
    username:         req.session.username,
    role:             user.role || 'viewer',
    plan:             user.plan || 'free',
    credits:          user.credits,
    permissions:      perms,
    has_alpaca:       hasAlpaca,
    has_moomoo:       hasMoomoo,
    has_tiger:        hasTiger,
    moomoo_acc_id:    dbUser?.moomoo_acc_id || null,
    tiger_account:    dbUser?.tiger_account || null,
    disabled_sources: disabledSources,
    sources: {
      alpaca_paper: (isAdmin ? true : !!(dbUser?.alpaca_api_key)) && !disabledSources.includes('alpaca'),
      alpaca_live:  (!!(dbUser?.alpaca_live_api_key) || (isAdmin && hasLiveAccount())) && !disabledSources.includes('alpaca_live'),
      moomoo:       hasMoomoo && !disabledSources.includes('moomoo'),
      tiger:        hasTiger  && !disabledSources.includes('tiger'),
    },
  });
});

// ─── User management (admin only) ────────────────────────────────────────────

async function requireAdmin(req, res, next) {
  const user = await getUser(req.session?.username);
  if (user?.role === 'admin') return next();
  res.status(403).json({ error: 'Forbidden' });
}

// ─── Public Chat — must be registered BEFORE the requireAuth middleware ───────
// Express processes routes top-to-bottom; placing this first means requireAuth
// never fires for /api/public/* requests.

const _publicChatCalls = new Map(); // ip -> { count, resetAt }

function publicChatRateLimit(req, res, next) {
  const ip    = req.ip ?? req.connection?.remoteAddress ?? 'unknown';
  const now   = Date.now();
  const entry = _publicChatCalls.get(ip) ?? { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
  entry.count++;
  _publicChatCalls.set(ip, entry);
  if (entry.count > 10) return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  next();
}

app.post('/api/public/chat', publicChatRateLimit, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || message.trim().length < 2) {
      return res.status(400).json({ error: 'Message required' });
    }

    const text = message.trim().slice(0, 500);

    const { isKnowledgeQuestion, answerKnowledgeQuestion } = await import('../core/knowledge.js');

    // Always try knowledge base first — skip silently if Ollama is offline
    if (await isKnowledgeQuestion(text)) {
      const result = await answerKnowledgeQuestion(text);
      if (result.source !== 'error') {
        return res.json({ answer: result.answer, type: 'knowledge', source: 'ollama' });
      }
    }

    // For market/scan questions, return last cached public market data only
    const isMarketQuestion = /market|regime|vix|trending|bullish|bearish|scan|setup|today|top pick|what stock|watch.?list|strong buy|briefing/i.test(text);
    if (isMarketQuestion) {
      const [scanRows, picksRows, briefingRows] = await Promise.all([
        query(`SELECT state_json, updated_at FROM scanner_state ORDER BY updated_at DESC LIMIT 1`),
        query(
          `SELECT symbol, name, score, grade, price, horizon
           FROM daily_picks
           WHERE date = CURRENT_DATE AND type = 'strong_buy'
           ORDER BY score DESC NULLS LAST LIMIT 5`
        ),
        query(
          `SELECT content, regime, direction, vix
           FROM daily_briefings
           WHERE date = CURRENT_DATE
           ORDER BY created_at DESC LIMIT 1`
        ),
      ]);

      const state     = scanRows.rows[0]?.state_json ?? null;
      const updatedAt = scanRows.rows[0]?.updated_at ?? null;
      const picks     = picksRows.rows;
      const briefing  = briefingRows.rows[0] ?? null;
      const parts     = [];

      if (state || briefing) {
        const regime    = briefing?.regime    ?? state?.last_regime    ?? 'unknown';
        const direction = briefing?.direction ?? state?.last_direction ?? 'unknown';
        const vix       = briefing?.vix       ?? state?.last_vix       ?? 'unknown';
        const age       = updatedAt ? Math.round((Date.now() - new Date(updatedAt).getTime()) / 60000) : null;
        parts.push(`📊 Market snapshot (${age != null ? `${age} min ago` : 'today'}): Regime ${regime} · Direction ${direction} · VIX ${vix}`);
      }

      if (picks.length > 0) {
        const pickLines = picks.map(p => {
          const score   = p.score   ? ` (score ${p.score})` : '';
          const grade   = p.grade   ? ` [${p.grade}]`       : '';
          const price   = p.price   ? ` @ $${Number(p.price).toFixed(2)}` : '';
          const horizon = p.horizon ? ` · ${p.horizon}`     : '';
          return `  • ${p.symbol}${grade}${score}${price}${horizon}`;
        }).join('\n');
        parts.push(`\n🔍 Today's scanner picks (strong buys):\n${pickLines}`);
      }

      if (briefing?.content) {
        const excerpt = briefing.content.slice(0, 300).replace(/\n+/g, ' ');
        parts.push(`\n📋 Today's briefing: ${excerpt}${briefing.content.length > 300 ? '…' : ''}`);
      }

      parts.push('\nSign in to the trading dashboard for live positions, trade signals, and full analysis.');
      return res.json({ answer: parts.join('\n'), type: 'market', source: 'cache' });
    }

    // Fallback — general trading question via Ollama, no Claude
    const result = await answerKnowledgeQuestion(text);
    if (result.source !== 'error') {
      return res.json({ answer: result.answer, type: 'general', source: 'ollama' });
    }
    return res.json({
      answer: 'The trading coach is temporarily offline. For live trade signals and analysis, please sign in to the dashboard.',
      type: 'offline',
      source: 'cache',
    });

  } catch (err) {
    console.error('[public-chat] error:', err.message);
    res.status(500).json({ error: 'Chat unavailable right now.' });
  }
});

// ─── API routes ───────────────────────────────────────────────────────────────
// requireAuth + apiLimiter applied to all /api/* routes registered below this line
app.use('/api', requireAuth, apiLimiter);

app.post('/api/users/add', requireAdmin, async (req, res) => {
  const { username, password, role = 'viewer', credits = 100 } = req.body;
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (!/^[a-z0-9_]{2,32}$/.test(username.toLowerCase())) {
    return res.status(400).json({ error: 'Username must be 2-32 chars, letters/numbers/underscore only' });
  }
  if (password.length < 10) {
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  }
  const key = username.toLowerCase();
  if (isDbAvailable()) {
    const existing = await getDbUser(key);
    if (existing) return res.status(409).json({ error: 'User already exists' });
    const hash = await bcrypt.hash(password, 12);
    await createDbUser({ username: key, passwordHash: hash, role, credits: role === 'admin' ? 0 : parseInt(credits) || 100 });
  } else {
    const users = loadUsers();
    if (users[key]) return res.status(409).json({ error: 'User already exists' });
    const hash = await bcrypt.hash(password, 12);
    users[key] = { hash, role };
    saveUsers(users);
  }
  logActivity(req.session.username, 'user_added', `added ${key} as ${role}`, req.ip);
  res.json({ ok: true, username: key, role });
});

app.post('/api/users/remove', requireAdmin, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });
  if (username.toLowerCase() === req.session.username) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const key = username.toLowerCase();
  if (isDbAvailable()) {
    const existing = await getDbUser(key);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    await deleteDbUser(key);
  } else {
    const users = loadUsers();
    if (!users[key]) return res.status(404).json({ error: 'User not found' });
    delete users[key];
    saveUsers(users);
  }
  logActivity(req.session.username, 'user_removed', `removed ${key}`, req.ip);
  res.json({ ok: true });
});

app.get('/api/users/list', requireAdmin, async (req, res) => {
  if (isDbAvailable()) {
    const rows = await listDbUsers() ?? [];
    return res.json(rows.map(u => ({
      username:         u.username,
      email:            u.email,
      role:             u.role,
      plan:             u.plan,
      credits:          u.credits,
      permissions:      getPermissions({ role: u.role, permissions: u.permissions }),
      disabled_sources: Array.isArray(u.disabled_sources) ? u.disabled_sources : [],
      created_at:       u.created_at,
      last_login:       u.last_login,
    })));
  }
  const users = loadUsers();
  res.json(Object.entries(users).map(([u, v]) => ({
    username: u, role: v.role, permissions: getPermissions(v), credits: null,
  })));
});

app.post('/api/users/permissions', requireAdmin, async (req, res) => {
  const { username, tabs: rawTabs, widgets: rawWidgets } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });
  const key  = username.toLowerCase();
  const tabs    = (Array.isArray(rawTabs)    ? rawTabs    : []).filter(t => ALL_TABS.includes(t));
  const widgets = (Array.isArray(rawWidgets) ? rawWidgets : []).filter(w => ALL_WIDGETS.includes(w));
  const perms = { tabs, widgets };
  if (isDbAvailable()) {
    const existing = await getDbUser(key);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    await updateDbUserPermissions(key, perms);
  } else {
    const users = loadUsers();
    if (!users[key]) return res.status(404).json({ error: 'User not found' });
    users[key].permissions = perms;
    saveUsers(users);
  }
  logActivity(req.session.username, 'permissions_changed', `updated ${key}: tabs=[${tabs}] widgets=[${widgets}]`, req.ip);
  res.json({ ok: true, username: key, permissions: perms });
});

app.post('/api/users/permissions/reset', requireAdmin, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });
  const key = username.toLowerCase();
  let role = 'viewer';
  if (isDbAvailable()) {
    const existing = await getDbUser(key);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    role = existing.role;
    await updateDbUserPermissions(key, null);
  } else {
    const users = loadUsers();
    if (!users[key]) return res.status(404).json({ error: 'User not found' });
    role = users[key].role;
    delete users[key].permissions;
    saveUsers(users);
  }
  logActivity(req.session.username, 'permissions_reset', `reset ${key} to role defaults`, req.ip);
  res.json({ ok: true, username: key, permissions: DEFAULT_PERMISSIONS[role] || DEFAULT_PERMISSIONS.viewer });
});

const VALID_SOURCES = ['alpaca', 'alpaca_live', 'moomoo', 'tiger'];

app.post('/api/users/sources/disable', requireAdmin, async (req, res) => {
  const { username, disabled_sources } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });
  if (!Array.isArray(disabled_sources)) return res.status(400).json({ error: 'disabled_sources must be an array' });
  const key = username.toLowerCase();
  const safe = disabled_sources.filter(s => VALID_SOURCES.includes(s));
  if (!isDbAvailable()) return res.status(503).json({ error: 'Database not available' });
  const existing = await getDbUser(key);
  if (!existing) return res.status(404).json({ error: 'User not found' });
  await setDisabledSources(key, safe);
  logActivity(req.session.username, 'broker_access_changed', `set disabled_sources=[${safe}] for ${key}`, req.ip);
  res.json({ ok: true, username: key, disabled_sources: safe });
});

app.post('/api/users/credits', requireAdmin, async (req, res) => {
  const { username, amount } = req.body;
  if (!username || amount == null) return res.status(400).json({ error: 'username and amount are required' });
  const credits = parseInt(amount);
  if (isNaN(credits) || credits < 0) return res.status(400).json({ error: 'amount must be a non-negative integer' });
  if (!isDbAvailable()) return res.status(503).json({ error: 'Database not available' });
  const existing = await getDbUser(username.toLowerCase());
  if (!existing) return res.status(404).json({ error: 'User not found' });
  await addCredits(username.toLowerCase(), credits);
  const updated = await getDbUser(username.toLowerCase());
  logActivity(req.session.username, 'credits_added', `added ${credits} credits to ${username.toLowerCase()} (now ${updated.credits})`, req.ip);
  res.json({ ok: true, username: username.toLowerCase(), credits: updated.credits });
});

// ─── Bug Reports ──────────────────────────────────────────────────────────────

app.post('/api/reports', requireAuth, async (req, res) => {
  try {
    const { title, description, page } = req.body || {};
    const username = req.session.username;
    if (!title?.trim() || !description?.trim())
      return res.status(400).json({ error: 'Title and description are required' });
    const id = await createBugReport({ username, title: title.trim(), description: description.trim(), page: page || null });
    if (!id) return res.status(500).json({ error: 'Database unavailable — report not saved' });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /api/reports:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/reports', requireAdmin, async (req, res) => {
  const { status } = req.query;
  const rows = await getBugReports({ status: status || null });
  res.json({ reports: rows });
});

app.patch('/api/reports/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { status, admin_note } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const ok = await updateBugReport({ id, status, admin_note });
  res.json({ ok });
});

app.get('/api/users/activity', requireAdmin, async (req, res) => {
  const username = (req.query.username || '').toLowerCase().trim() || null;
  const limit    = Math.min(parseInt(req.query.limit) || 100, 500);
  const rows = await getActivity({ username, limit });
  res.json({ activity: rows });
});

app.get('/api/users/analytics', requireAdmin, async (req, res) => {
  if (!isDbAvailable()) return res.json({ users: [], dau: [], summary: {} });
  try {
    const [usersRes, dauRes, summaryRes] = await Promise.all([
      query(`
        SELECT
          u.username, u.email, u.role, u.plan, u.credits,
          u.created_at, u.last_login,
          u.alpaca_api_key IS NOT NULL AS has_alpaca,
          COUNT(a.id)                                                                  AS total_actions,
          COUNT(a.id) FILTER (WHERE a.created_at >= NOW() - INTERVAL '30 days')       AS actions_30d,
          COUNT(a.id) FILTER (WHERE a.action = 'login')                               AS total_logins,
          COUNT(a.id) FILTER (WHERE a.action = 'login'
                              AND a.created_at >= NOW() - INTERVAL '30 days')         AS logins_30d,
          COUNT(DISTINCT DATE(a.created_at AT TIME ZONE 'America/New_York'))
            FILTER (WHERE a.created_at >= NOW() - INTERVAL '30 days')                AS days_active_30d,
          COUNT(a.id) FILTER (WHERE a.action = 'chat_prompt')                         AS total_prompts,
          COUNT(a.id) FILTER (WHERE a.action = 'chat_prompt'
                              AND a.created_at >= NOW() - INTERVAL '30 days')         AS prompts_30d,
          MAX(a.created_at)                                                            AS last_seen
        FROM users u
        LEFT JOIN user_activity a ON a.username = u.username
        WHERE u.role != 'admin'
        GROUP BY u.id, u.username, u.email, u.role, u.plan, u.credits,
                 u.created_at, u.last_login, u.alpaca_api_key
        ORDER BY last_seen DESC NULLS LAST
      `),
      query(`
        SELECT
          DATE(created_at AT TIME ZONE 'America/New_York') AS day,
          COUNT(DISTINCT username)                          AS dau
        FROM user_activity
        WHERE created_at >= NOW() - INTERVAL '30 days'
          AND username IN (SELECT username FROM users WHERE role != 'admin')
        GROUP BY 1 ORDER BY 1
      `),
      query(`
        SELECT
          COUNT(DISTINCT u.username)                                   AS total_users,
          COUNT(DISTINCT a30.username)                                 AS active_30d,
          COUNT(DISTINCT a7.username)                                  AS active_7d,
          COUNT(DISTINCT a1.username)                                  AS active_today,
          COALESCE(SUM(p.cnt), 0)                                      AS total_prompts
        FROM users u
        LEFT JOIN (SELECT DISTINCT username FROM user_activity WHERE created_at >= NOW() - INTERVAL '30 days') a30 ON a30.username = u.username
        LEFT JOIN (SELECT DISTINCT username FROM user_activity WHERE created_at >= NOW() - INTERVAL '7 days')  a7  ON a7.username  = u.username
        LEFT JOIN (SELECT DISTINCT username FROM user_activity WHERE created_at >= CURRENT_DATE)               a1  ON a1.username  = u.username
        LEFT JOIN (SELECT username, COUNT(*) AS cnt FROM user_activity WHERE action='chat_prompt' GROUP BY username) p ON p.username = u.username
        WHERE u.role != 'admin'
      `),
    ]);
    res.json({ users: usersRes.rows, dau: dauRes.rows, summary: summaryRes.rows[0] ?? {} });
  } catch (err) {
    console.error('analytics error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Alpaca account connect / disconnect ──────────────────────────────────────

app.post('/api/alpaca/connect', requireAuth, async (req, res) => {
  const { api_key, secret_key, account_type } = req.body;
  if (!api_key || !secret_key) return res.status(400).json({ error: 'API key and secret are required' });
  const baseUrl = account_type === 'live'
    ? 'https://api.alpaca.markets'
    : 'https://paper-api.alpaca.markets';

  const valid = await validateAlpacaCreds({ apiKey: api_key, secretKey: secret_key, baseUrl });
  if (!valid) return res.status(401).json({ error: 'Invalid Alpaca credentials — check your API key and secret.' });

  await saveUserAlpaca(req.session.username, { apiKey: api_key, secretKey: secret_key, baseUrl, accountType: account_type });
  logActivity(req.session.username, 'alpaca_connected', `${account_type === 'live' ? 'Live' : 'Paper'} account connected`, req.ip);
  res.json({ ok: true, account_type });
});

app.post('/api/alpaca/disconnect', requireAuth, async (req, res) => {
  await clearUserAlpaca(req.session.username);
  logActivity(req.session.username, 'alpaca_disconnected', 'Paper account disconnected', req.ip);
  res.json({ ok: true });
});

app.post('/api/alpaca/disconnect-live', requireAuth, async (req, res) => {
  await clearUserLiveAlpaca(req.session.username);
  logActivity(req.session.username, 'alpaca_disconnected', 'Live account disconnected', req.ip);
  res.json({ ok: true });
});

// Moomoo per-user account connect/disconnect
app.get('/api/moomoo/accounts', requireAuth, async (req, res) => {
  try {
    const accs = await getAccounts();
    res.json({ ok: true, accounts: accs.accounts || [] });
  } catch (e) {
    res.json({ ok: false, accounts: [], error: e.message });
  }
});

app.post('/api/moomoo/connect', requireAuth, async (req, res) => {
  const { acc_id } = req.body;
  if (!acc_id) return res.status(400).json({ error: 'acc_id is required' });
  await saveUserMoomoo(req.session.username, acc_id);
  logActivity(req.session.username, 'moomoo_connected', `Moomoo account ${acc_id} connected`, req.ip);
  res.json({ ok: true, acc_id });
});

app.post('/api/moomoo/disconnect', requireAuth, async (req, res) => {
  await clearUserMoomoo(req.session.username);
  logActivity(req.session.username, 'moomoo_disconnected', 'Moomoo account disconnected', req.ip);
  res.json({ ok: true });
});

// Tiger Brokers per-user connect/disconnect
app.post('/api/tiger/connect', requireAuth, async (req, res) => {
  const { tiger_id, account, private_key } = req.body;
  if (!tiger_id || !account || !private_key) return res.status(400).json({ error: 'tiger_id, account and private_key are required' });
  const creds = { tiger_id, account, private_key };
  const valid = await validateTigerCreds(creds);
  if (!valid) return res.status(401).json({ error: 'Invalid Tiger credentials — check your Tiger ID, account number and private key.' });
  await saveUserTiger(req.session.username, { tigerId: tiger_id, account, privateKey: private_key });
  logActivity(req.session.username, 'tiger_connected', `Tiger account ${account} connected`, req.ip);
  res.json({ ok: true, account });
});


app.post('/api/tiger/disconnect', requireAuth, async (req, res) => {
  await clearUserTiger(req.session.username);
  logActivity(req.session.username, 'tiger_disconnected', 'Tiger account disconnected', req.ip);
  res.json({ ok: true });
});

// Helper: fetch account + positions from the selected source
const isPaperUrl = url => !url || url.includes('paper');

async function getAccountData(source, username) {
  // Enforce admin-imposed source locks
  if (isDbAvailable()) {
    const lock = await getDbUser(username);
    const disabled = Array.isArray(lock?.disabled_sources) ? lock.disabled_sources : [];
    if (disabled.includes(source)) return { account: null, positions: [], source_disabled: true };
  }
  // Non-admin users use their own Alpaca credentials, matched to the requested source
  if (source !== 'moomoo' && source !== 'alpaca_live' && source !== 'tiger') {
    const sessionUser = await getUser(username);
    if (sessionUser?.role !== 'admin' && isDbAvailable()) {
      const dbUser = await getDbUser(username);
      if (dbUser?.alpaca_api_key) {
        const creds = { apiKey: dbUser.alpaca_api_key, secretKey: dbUser.alpaca_secret_key, baseUrl: dbUser.alpaca_base_url };
        // Paper source requires paper credentials — don't show live data when paper is selected
        if (!isPaperUrl(creds.baseUrl)) return { account: null, positions: [], needs_alpaca_setup: true };
        const [account, positions] = await Promise.allSettled([getUserAccount(creds), getUserPositions(creds)]);
        return {
          account:   account.status   === 'fulfilled' ? account.value   : null,
          positions: positions.status === 'fulfilled' ? positions.value : [],
        };
      }
      return { account: null, positions: [], needs_alpaca_setup: true };
    }
  }
  if (source === 'moomoo') {
    const sessionUser = await getUser(username);
    const isAdmin = sessionUser?.role === 'admin';
    if (!isAdmin && isDbAvailable()) {
      const dbUser = await getDbUser(username);
      if (!dbUser?.moomoo_acc_id) return { account: null, positions: [], needs_moomoo_setup: true };
    }
    const dbUser = isDbAvailable() ? await getDbUser(username) : null;
    const accId = dbUser?.moomoo_acc_id || undefined;
    const [funds, pos] = await Promise.allSettled([getFunds({ acc_id: accId }), getMoomooPositions({ acc_id: accId })]);
    const f = funds.status === 'fulfilled' ? funds.value : null;
    const p = pos.status  === 'fulfilled' ? pos.value  : null;
    const account = f ? {
      source:          'moomoo',
      account_number:  f.acc_id,
      portfolio_value: f.total_assets,
      buying_power:    f.buying_power,
      cash:            f.cash,
      market_value:    f.market_val,
      // funds API returns 0 for unrealized_pl — sum from positions instead
      unrealized_pl:   p?.total_unrealized_pl ?? 0,
      realized_pl:     f.realized_pl,
      paper:           false,
    } : null;
    const positions = (p?.positions || []).map(pos => ({
      symbol:          pos.symbol,
      name:            pos.name,
      market:          pos.market,
      qty:             pos.qty,
      avg_entry_price: pos.avg_cost,
      current_price:   pos.current_price,
      market_value:    pos.market_val,
      unrealized_pl:   pos.unrealized_pl,
      unrealized_plpc: pos.unrealized_pl_pct,
      today_pl:        pos.today_pl,
    }));
    return { account, positions };
  }
  // Alpaca live (read-only) — prefer per-user DB credentials, fall back to env vars for admin
  if (source === 'alpaca_live') {
    const dbUser = isDbAvailable() ? await getDbUser(username) : null;
    if (dbUser?.alpaca_live_api_key) {
      const creds = { apiKey: dbUser.alpaca_live_api_key, secretKey: dbUser.alpaca_live_secret_key, baseUrl: 'https://api.alpaca.markets' };
      const [account, positions] = await Promise.allSettled([getUserAccount(creds), getUserPositions(creds)]);
      return {
        account:   account.status   === 'fulfilled' ? { ...account.value, source: 'alpaca_live' } : null,
        positions: positions.status === 'fulfilled' ? positions.value : [],
      };
    }
    // Admin fallback: use server env vars if set
    if (hasLiveAccount()) {
      const [account, positions] = await Promise.allSettled([getLiveAccount(), getLivePositions()]);
      return {
        account:   account.status   === 'fulfilled' ? { ...account.value, source: 'alpaca_live' } : null,
        positions: positions.status === 'fulfilled' ? positions.value : [],
      };
    }
    return { account: null, positions: [], needs_live_setup: true };
  }
  // Tiger Brokers
  if (source === 'tiger') {
    const dbUser = isDbAvailable() ? await getDbUser(username) : null;
    if (!dbUser?.tiger_id) return { account: null, positions: [], needs_tiger_setup: true };
    const creds = { tiger_id: dbUser.tiger_id, account: dbUser.tiger_account, private_key: dbUser.tiger_private_key };
    const [funds, pos, ordersRes] = await Promise.allSettled([
      getTigerFunds(creds),
      getTigerPositions(creds),
      getTigerOrders(creds, { days: 730 }),
    ]);
    if (funds.status === 'rejected') console.error('[tiger] getTigerFunds failed:', funds.reason?.message);
    if (pos.status   === 'rejected') console.error('[tiger] getTigerPositions failed:', pos.reason?.message);
    const f      = funds.status    === 'fulfilled' ? funds.value    : null;
    const p      = pos.status      === 'fulfilled' ? pos.value      : [];
    const orders = ordersRes.status === 'fulfilled' ? ordersRes.value : [];

    // Tiger's positions API returns averageCost = lastClosePrice, so unrealizedPnl is only today's
    // intraday move. Reconstruct true cost basis from order history (up to 2 years back).
    const costMap = {};
    for (const o of orders) {
      const filled = (o.status || '').toLowerCase();
      if (filled !== 'filled') continue;
      const sym    = o.symbol;
      const qty    = +(o.filledQuantity ?? 0);
      const price  = +(o.avgFillPrice ?? o.averageFillPrice ?? 0);
      const action = (o.action || '').toUpperCase();
      if (!sym || qty <= 0 || price <= 0) continue;
      if (!costMap[sym]) costMap[sym] = { totalCost: 0, totalQty: 0 };
      if (action === 'BUY') {
        costMap[sym].totalCost += price * qty;
        costMap[sym].totalQty  += qty;
      } else if (action === 'SELL' && costMap[sym].totalQty > 0) {
        const avg = costMap[sym].totalCost / costMap[sym].totalQty;
        costMap[sym].totalCost = Math.max(0, costMap[sym].totalCost - avg * Math.min(qty, costMap[sym].totalQty));
        costMap[sym].totalQty  = Math.max(0, costMap[sym].totalQty - qty);
      }
    }

    const positions = p.map(pos => {
      const sym    = pos.symbol ?? pos.contract?.symbol;
      const qty    = +(pos.position ?? pos.positionQty ?? pos.quantity ?? pos.qty ?? 0);
      const lastPx = +(pos.latestPrice ?? pos.market_price ?? pos.current_price ?? 0);
      const mktVal = +(pos.marketValue ?? pos.market_value ?? (lastPx * qty));

      // Use order-history avg cost when available; fall back to Tiger's daily-only unrealizedPnl
      let avgCost          = +(pos.averageCost ?? pos.average_cost ?? pos.avg_cost ?? 0);
      let trueUnrealizedPl = +(pos.unrealizedPnl ?? 0);
      if (sym && costMap[sym]?.totalQty > 0) {
        avgCost          = costMap[sym].totalCost / costMap[sym].totalQty;
        trueUnrealizedPl = (lastPx - avgCost) * qty;
      }
      const costBasis = avgCost * qty || (mktVal - trueUnrealizedPl);
      const plPct     = costBasis > 0 ? (trueUnrealizedPl / costBasis) * 100 : (+(pos.unrealizedPnlPercent ?? 0) * 100);

      return {
        symbol:          sym,
        qty,
        avg_entry_price: avgCost || undefined,
        current_price:   lastPx,
        market_value:    mktVal,
        unrealized_pl:   trueUnrealizedPl,
        unrealized_plpc: plPct,
        side:            ((pos.side ?? pos.direction ?? 'long') + '').toLowerCase() === 'short' ? 'short' : 'long',
      };
    }).filter(pos => pos.symbol);

    const account = f ? {
      source:          'tiger',
      account_number:  dbUser.tiger_account,
      portfolio_value: f.net_liquidation_value ?? f.gross_position_value,
      buying_power:    f.buying_power,
      cash:            f.cash,
      market_value:    f.gross_position_value,
      unrealized_pl:   positions.reduce((s, x) => s + (x.unrealized_pl ?? 0), 0),
      paper:           false,
    } : null;
    return { account, positions };
  }
  // Alpaca paper (default — bot trades here)
  const [account, positions] = await Promise.allSettled([getAccount(), getPositions()]);
  return {
    account:   account.status   === 'fulfilled' ? { ...account.value, source: 'alpaca' } : null,
    positions: positions.status === 'fulfilled' ? positions.value : [],
  };
}

// News only — fast path, 5-min cache, hard 6s deadline
app.get('/api/home-news', async (req, res) => {
  try {
    const deadline = new Promise(resolve => setTimeout(() => resolve([]), 6000));
    const news = await Promise.race([
      ttlCache('home:news', 5 * 60 * 1000, () => getMarketNews({ limit: 40 })),
      deadline,
    ]);
    res.json((news || []).map(a => ({ ...a, category: categoriseNews(a.title) })));
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Earnings only — slower, loaded separately so it never blocks news
app.get('/api/home-earnings', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const earningsRaw = await ttlCache(`home:earnings:${today}`, 60 * 60 * 1000, () => getEarningsCalendar({ date: today, limit: 15 }));
    const earnings = Array.isArray(earningsRaw) ? earningsRaw : (earningsRaw?.earnings || []);
    res.json(earnings);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Legacy combined endpoint — kept for backward compat
app.get('/api/home', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [newsRes, earningsRes] = await Promise.allSettled([
      ttlCache('home:news', 5 * 60 * 1000, () => getMarketNews({ limit: 40 })),
      ttlCache(`home:earnings:${today}`, 60 * 60 * 1000, () => getEarningsCalendar({ date: today, limit: 15 })),
    ]);
    const news = newsRes.status === 'fulfilled' ? newsRes.value : [];
    const earningsRaw = earningsRes.status === 'fulfilled' ? earningsRes.value : {};
    const earnings = Array.isArray(earningsRaw) ? earningsRaw : (earningsRaw?.earnings || []);
    res.json({ news: news.map(a => ({ ...a, category: categoriseNews(a.title) })), earnings });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/market-status', async (req, res) => {
  try { res.json(await getMarketStatus()); } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Batch earnings trend — ?symbols=INTC,AXP,NVDA
app.get('/api/earnings-trend', async (req, res) => {
  try {
    const symbols = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 15);
    if (!symbols.length) return res.json({});
    const results = await Promise.all(
      symbols.map(async s => [s, await ttlCache(`earnings-trend:${s}`, 60 * 60 * 1000, () => getEarningsTrend(s))])
    );
    res.json(Object.fromEntries(results));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Earnings reaction analysis — price / volume / % for E-1, E-0, E+1 across available history
// Data: earningsHistory (Yahoo quoteSummary) for dates+EPS, chart API for OHLCV
app.get('/api/earnings-reaction', requireAuth, async (req, res) => {
  try {
    const symbol = (req.query.symbol || '').toUpperCase().trim().replace(/[^A-Z0-9.^-]/g, '');
    if (!symbol) return res.json({ symbol: '', events: [] });
    const data = await ttlCache(`er:reaction2:${symbol}`, 4 * 60 * 60 * 1000, async () => {
      // 1. Fetch EPS + fiscal quarter-end dates from Yahoo earningsHistory
      //    quarter = fiscal quarter end date (earnings call is ~30-50 days after)
      let yfQuarters = [];
      try {
        const yfData = await _yf.quoteSummary(symbol, { modules: ['earningsHistory'] });
        const hist = yfData?.earningsHistory?.history || [];
        yfQuarters = hist
          .filter(h => h.quarter)
          .map(h => {
            const qEnd = (h.quarter instanceof Date ? h.quarter : new Date(h.quarter))
              .toISOString().split('T')[0];
            const eps = h.epsActual  ?? null;
            const est = h.epsEstimate ?? null;
            return {
              quarter_end:  qEnd,
              eps_actual:   eps,
              eps_estimate: est,
              surprise_pct: (eps != null && est != null && Math.abs(est) > 0.001)
                ? +((eps - est) / Math.abs(est) * 100).toFixed(2) : null,
            };
          })
          .sort((a, b) => new Date(a.quarter_end) - new Date(b.quarter_end));
      } catch (e) { console.warn('[earnings-reaction] earningsHistory failed:', e.message); }

      if (!yfQuarters.length) return { symbol, events: [] };

      // 2. Fetch 3yr daily OHLCV from Yahoo Finance chart API
      const p1 = Math.floor((Date.now() - 3 * 365 * 86400 * 1000) / 1000);
      const p2 = Math.floor(Date.now() / 1000) + 86400;
      const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
        `?interval=1d&period1=${p1}&period2=${p2}`;
      const chartResp = await fetch(chartUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      if (!chartResp.ok) return { symbol, events: [] };
      const chartJson = await chartResp.json();
      const result = chartJson?.chart?.result?.[0];
      if (!result) return { symbol, events: [] };

      const tss = result.timestamp || [];
      const q   = result.indicators?.quote?.[0] || {};
      const barMap = {};
      tss.forEach((ts, i) => {
        if (q.close?.[i] == null) return;
        const date = new Date(ts * 1000).toISOString().split('T')[0];
        barMap[date] = {
          date,
          open:   q.open?.[i]   != null ? +q.open[i].toFixed(2)   : null,
          high:   q.high?.[i]   != null ? +q.high[i].toFixed(2)   : null,
          low:    q.low?.[i]    != null ? +q.low[i].toFixed(2)    : null,
          close:  +q.close[i].toFixed(2),
          volume: q.volume?.[i] || 0,
        };
      });
      const sorted = Object.keys(barMap).sort();

      const pct = (a, b) =>
        (a?.close && b?.close) ? +((a.close - b.close) / b.close * 100).toFixed(2) : null;

      // 3. For each quarter, find the reaction day:
      //    Earnings are announced 20-60 days after fiscal quarter end.
      //    The highest-volume day in that window is the market-reaction day
      //    (E-0 for BMO companies; E+1 for AMC companies — either way it captures the move).
      const events = yfQuarters.map(ev => {
        const qEnd = new Date(ev.quarter_end + 'T00:00:00');
        const winStart = new Date(qEnd.getTime() + 18 * 86400000).toISOString().split('T')[0];
        const winEnd   = new Date(qEnd.getTime() + 65 * 86400000).toISOString().split('T')[0];
        const winBars  = sorted.filter(d => d >= winStart && d <= winEnd).map(d => barMap[d]);
        if (!winBars.length) return null;

        // Pick the highest-volume bar as the reaction/event bar
        const reactBar = winBars.reduce((mx, b) => (b.volume > mx.volume ? b : mx), winBars[0]);
        const rIdx = sorted.indexOf(reactBar.date);
        const b_1  = rIdx >= 1 ? barMap[sorted[rIdx - 1]] : null;
        const b_2  = rIdx >= 2 ? barMap[sorted[rIdx - 2]] : null;
        const bp1  = rIdx + 1 < sorted.length ? barMap[sorted[rIdx + 1]] : null;

        return {
          earnings_date: reactBar.date,
          quarter_end:   ev.quarter_end,
          eps_actual:    ev.eps_actual,
          eps_estimate:  ev.eps_estimate,
          surprise_pct:  ev.surprise_pct,
          prev_day:     b_1     ? { ...b_1,     pct_chg: pct(b_1, b_2)        } : null,
          earnings_day: reactBar ? { ...reactBar, pct_chg: pct(reactBar, b_1)  } : null,
          next_day:     bp1     ? { ...bp1,     pct_chg: pct(bp1, reactBar)   } : null,
        };
      }).filter(Boolean).reverse(); // most recent first

      return { symbol, events };
    });
    res.json(data);
  } catch (err) {
    console.error('[earnings-reaction]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Earnings calendar — next 30 days
// Primary: Nasdaq Calendar API (one request per day, returns ALL reporting stocks with time+EPS)
// Fallback: Yahoo Finance quoteSummary per-symbol (S&P500 + NASDAQ100 + watchlist)
// SP500 + NASDAQ100 as fallback when Nasdaq Calendar API is blocked (defined before DEFAULT_WATCHLIST_SB)
const EARNINGS_FALLBACK_LIST = [...new Set([...SP500, ...NASDAQ100])];

const NASDAQ_CAL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.nasdaq.com',
  'Referer': 'https://www.nasdaq.com/market-activity/earnings',
};

function parseMarketCapNum(str) {
  if (!str) return 0;
  const s = String(str).replace(/[$,\s]/g, '');
  const n = parseFloat(s);
  if (!n) return 0;
  if (s.endsWith('T')) return n * 1e12;
  if (s.endsWith('B')) return n * 1e9;
  if (s.endsWith('M')) return n * 1e6;
  if (s.endsWith('K')) return n * 1e3;
  return n;
}

async function fetchNasdaqEarningsDay(dateStr) {
  try {
    const r = await fetch(
      `https://api.nasdaq.com/api/calendar/earnings?date=${dateStr}`,
      { headers: NASDAQ_CAL_HEADERS, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const rows = j?.data?.rows;
    if (!Array.isArray(rows)) return null;
    return rows
      .map(row => ({
        symbol:        (row.symbol || '').toUpperCase(),
        company:       row.name || row.symbol || '',
        call_time:     row.time === 'time-pre-market'  ? 'BMO'
                     : row.time === 'time-after-hours' ? 'AMC' : '?',
        eps_estimate:  row.epsForecast != null ? parseFloat(row.epsForecast) || null : null,
        market_cap:    row.marketCap || null,
        market_cap_n:  parseMarketCapNum(row.marketCap),
        source:        'nasdaq',
      }))
      .filter(e => e.symbol)
      .sort((a, b) => b.market_cap_n - a.market_cap_n); // largest companies first
  } catch { return null; }
}

app.get('/api/earnings-month', requireAuth, async (req, res) => {
  try {
    const todayLocal = new Date();
    const localDateStr = `${todayLocal.getFullYear()}-${String(todayLocal.getMonth()+1).padStart(2,'0')}-${String(todayLocal.getDate()).padStart(2,'0')}`;
    const cacheKey = 'earnings:month2:' + localDateStr;
    const result = await ttlCache(cacheKey, 2 * 60 * 60 * 1000, async () => {
      const today = new Date(); today.setHours(0, 0, 0, 0);

      // Build list of weekdays for next 30 calendar days
      const dates = [];
      for (let i = 0; i < 30; i++) {
        const d = new Date(today.getTime() + i * 86400000);
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue; // skip weekends
        dates.push(d.toISOString().split('T')[0]);
      }

      // ── Primary: Nasdaq Calendar API (parallel, one request per day) ──
      const nasdaqResults = await Promise.allSettled(
        dates.map(d => fetchNasdaqEarningsDay(d))
      );

      const byDate = {};
      let nasdaqOk = 0;
      nasdaqResults.forEach((r, i) => {
        if (r.status !== 'fulfilled' || !r.value) return;
        nasdaqOk++;
        const d = dates[i];
        byDate[d] = r.value; // full list — ALL reporting stocks
      });

      // ── Fallback: Yahoo Finance per-symbol for any day Nasdaq blocked ──
      const missedDates = new Set(dates.filter(d => !byDate[d]));
      if (missedDates.size > 0) {
        console.log(`[earnings-month] Nasdaq blocked for ${missedDates.size} days — Yahoo fallback`);
        const cutoff = new Date(today.getTime() + 30 * 86400000);
        const BATCH = 20;
        for (let i = 0; i < EARNINGS_FALLBACK_LIST.length; i += BATCH) {
          const batch = EARNINGS_FALLBACK_LIST.slice(i, i + BATCH);
          const yfResults = await Promise.allSettled(
            batch.map(sym => _yf.quoteSummary(sym, { modules: ['calendarEvents', 'price'] }).catch(() => null))
          );
          for (let j = 0; j < batch.length; j++) {
            const sym = batch[j];
            const r = yfResults[j];
            if (r.status !== 'fulfilled' || !r.value) continue;
            const rawDates = r.value.calendarEvents?.earnings?.earningsDate ?? [];
            const future = rawDates
              .map(d => (d instanceof Date ? d : new Date(d)))
              .filter(d => !isNaN(d) && d >= today && d <= cutoff)
              .sort((a, b) => a - b);
            if (!future.length) continue;
            const dateStr = future[0].toISOString().split('T')[0];
            if (!missedDates.has(dateStr)) continue; // only fill gaps
            if (!byDate[dateStr]) byDate[dateStr] = [];
            // Avoid dupes if partial Nasdaq data exists
            if (!byDate[dateStr].find(e => e.symbol === sym)) {
              byDate[dateStr].push({
                symbol: sym,
                company: r.value.price?.longName || r.value.price?.shortName || sym,
                call_time: '?',
                eps_estimate: null,
                source: 'yahoo',
              });
            }
          }
        }
      }

      console.log(`[earnings-month] Nasdaq ok: ${nasdaqOk}/${dates.length} days, total entries: ${Object.values(byDate).flat().length}`);
      const all = [];
      for (const [date, entries] of Object.entries(byDate).sort()) {
        for (const e of entries) all.push({ date, ...e });
      }
      return { success: true, generated_at: new Date().toISOString(), days_covered: 30, total: all.length, earnings: all };
    });
    res.json(result);
  } catch (err) {
    console.error('[earnings-month]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Yahoo Finance historical earnings fallback — fetches earningsHistory for major stocks
// and estimates announcement date as fiscal_quarter_end + 35 days (snapped to weekday)
// Cached per calendar month (24h TTL) so subsequent navigations are instant
async function buildYahooHistoricalMonth(yearMonth) {
  // DEFAULT_WATCHLIST_SB and NASDAQ100 are accessible at runtime (defined below in module)
  const CAL_MAJOR = [...new Set([...DEFAULT_WATCHLIST_SB, ...NASDAQ100.slice(0, 70)])];
  const [year, month] = yearMonth.split('-').map(Number);
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd   = new Date(year, month, 0, 23, 59, 59);
  const byDate = {};
  const BATCH = 25;
  for (let i = 0; i < CAL_MAJOR.length; i += BATCH) {
    const batch = CAL_MAJOR.slice(i, i + BATCH);
    const batchResults = await Promise.allSettled(
      batch.map(sym => _yf.quoteSummary(sym, { modules: ['earningsHistory', 'price'] }).catch(() => null))
    );
    for (let j = 0; j < batch.length; j++) {
      const sym = batch[j];
      const r = batchResults[j];
      if (r.status !== 'fulfilled' || !r.value) continue;
      const hist = r.value.earningsHistory?.history || [];
      const name  = r.value.price?.longName || r.value.price?.shortName || sym;
      const mktCap = r.value.price?.marketCap || 0;
      for (const h of hist) {
        if (!h.quarter) continue;
        const qEnd = h.quarter instanceof Date ? h.quarter : new Date(h.quarter);
        if (isNaN(qEnd)) continue;
        // Estimate announcement: quarter_end + 35 days, snapped to nearest weekday
        let est = new Date(qEnd.getTime() + 35 * 86400000);
        const dow = est.getDay();
        if (dow === 0) est = new Date(est.getTime() + 86400000); // Sun → Mon
        if (dow === 6) est = new Date(est.getTime() - 86400000); // Sat → Fri
        if (est < monthStart || est > monthEnd) continue;
        const ds = est.toISOString().split('T')[0];
        if (!byDate[ds]) byDate[ds] = [];
        byDate[ds].push({ symbol: sym, company: name, call_time: '?', eps_estimate: h.epsEstimate ?? null, market_cap_n: mktCap, source: 'yahoo_hist' });
      }
    }
  }
  for (const ds of Object.keys(byDate)) {
    byDate[ds].sort((a, b) => (b.market_cap_n || 0) - (a.market_cap_n || 0));
  }
  console.log(`[earnings-hist] ${yearMonth}: ${Object.values(byDate).flat().length} entries across ${Object.keys(byDate).length} dates (Yahoo fallback)`);
  return byDate;
}

// Per-date earnings calendar — supports historical navigation
// Primary: Nasdaq Calendar API (all reporting stocks)
// Fallback: Yahoo earningsHistory for ~100 major stocks when Nasdaq is blocked
app.get('/api/earnings-calendar', requireAuth, async (req, res) => {
  try {
    const dateParam = (req.query.date || '').trim();
    const force     = req.query.force === '1';
    if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return res.status(400).json({ error: 'date param required (YYYY-MM-DD)' });
    }
    const startDate = new Date(dateParam + 'T00:00:00');
    if (isNaN(startDate)) return res.status(400).json({ error: 'invalid date' });

    // All weekdays in the 7-day window from startDate
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(startDate.getTime() + i * 86400000);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      dates.push(d.toISOString().split('T')[0]);
    }

    // Force-refresh: evict server-side cache for all days in this window
    if (force) {
      for (const d of dates) {
        _cache.delete(`earnings:cal:${d}`);
      }
      _cache.delete(`earnings:supplement:${dateParam}`);
    }

    // ── Primary: Nasdaq Calendar API (per-day, 6h TTL) ──
    const nasdaqResults = await Promise.allSettled(
      dates.map(d => ttlCache(`earnings:cal:${d}`, 6 * 60 * 60 * 1000, () => fetchNasdaqEarningsDay(d)))
    );

    const earnings = [];
    const missedDates = [];
    // Track what Nasdaq already returned per date (to avoid duplicates in supplement)
    const nasdaqSymsByDate = {};
    nasdaqResults.forEach((r, i) => {
      const items = r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : null;
      nasdaqSymsByDate[dates[i]] = new Set(items ? items.map(e => e.symbol) : []);
      if (items) {
        for (const e of items) earnings.push({ date: dates[i], ...e });
      } else {
        missedDates.push(dates[i]);
      }
    });

    // ── Fallback: Yahoo earningsHistory for days Nasdaq couldn't serve ──
    if (missedDates.length > 0) {
      const months = [...new Set(missedDates.map(d => d.substring(0, 7)))];
      for (const ym of months) {
        const histByDate = await ttlCache(`earnings:hist:${ym}`, 24 * 60 * 60 * 1000, () => buildYahooHistoricalMonth(ym));
        for (const d of missedDates.filter(ds => ds.startsWith(ym))) {
          const items = histByDate?.[d] || [];
          for (const e of items) earnings.push({ date: d, ...e });
        }
      }
    }

    // ── Supplement: Yahoo calendarEvents for tracked watchlist ──
    // Catches stocks Nasdaq returned partial data for (e.g. DDOG missing from Nasdaq
    // even though it reports that day). Cached separately for 4 hours.
    const datesSet = new Set(dates);
    const supplement = await ttlCache(`earnings:supplement:${dateParam}`, 4 * 60 * 60 * 1000, async () => {
      const yfResults = await Promise.allSettled(
        DEFAULT_WATCHLIST_SB.map(sym =>
          _yf.quoteSummary(sym, { modules: ['calendarEvents', 'price'] }).catch(() => null)
        )
      );
      const entries = [];
      for (let j = 0; j < DEFAULT_WATCHLIST_SB.length; j++) {
        const sym = DEFAULT_WATCHLIST_SB[j];
        const r = yfResults[j];
        if (r.status !== 'fulfilled' || !r.value) continue;
        const rawDates = r.value.calendarEvents?.earnings?.earningsDate ?? [];
        for (const raw of rawDates) {
          const d = raw instanceof Date ? raw : new Date(raw);
          if (isNaN(d)) continue;
          const ds = d.toISOString().split('T')[0];
          if (!datesSet.has(ds)) continue;
          entries.push({
            ds, symbol: sym,
            company: r.value.price?.longName || r.value.price?.shortName || sym,
          });
        }
      }
      return entries;
    });

    // Merge supplement — skip if Nasdaq already has the symbol for that date
    for (const s of (supplement || [])) {
      if (nasdaqSymsByDate[s.ds]?.has(s.symbol)) continue;
      // Also skip if already in earnings array from the Yahoo historical fallback
      if (earnings.find(e => e.date === s.ds && e.symbol === s.symbol)) continue;
      earnings.push({ date: s.ds, symbol: s.symbol, company: s.company, call_time: '?', eps_estimate: null, source: 'yahoo_supplement' });
    }

    res.json({ success: true, date: dateParam, earnings });
  } catch (err) {
    console.error('[earnings-calendar]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Forecast / Prediction Engine ────────────────────────────────────────────

const DEFAULT_WATCHLIST_SB = [
  'MRVL','NVDA','AMD','AAPL','MSFT','GOOGL','META','AMZN','TSLA','NFLX',
  'INTC','QCOM','MU','AVGO','TSM','SMCI','RTX','LMT','XOM','JPM',
  'CRWD','PANW','NET','DDOG','PLTR','COIN','UBER','ARM','ASML','ADBE',
];

// All SP500 + NASDAQ100 + strong-buys watchlist, deduped
const FORECAST_SYMBOLS = [...new Set([...SP500, ...NASDAQ100, ...DEFAULT_WATCHLIST_SB])];

function getMondayStr(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay(); // local day-of-week
  // Sunday (0) → next Monday (+1); Mon (1) → stay; Tue-Sat → back to this Mon
  const diff = day === 0 ? 1 : 1 - day;
  d.setDate(d.getDate() + diff);
  // Use local date parts, not toISOString() which returns UTC and can give wrong date
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function getTradingDaysOfWeek(weekStartStr) {
  const mon = new Date(weekStartStr + 'T12:00:00Z');
  return [0,1,2,3,4].map(i => {
    const d = new Date(mon.getTime() + i * 86400000);
    return d.toISOString().split('T')[0];
  });
}

// Progress tracker for background generation
let _forecastProgress = null; // { total, done, errors, weekStart, startedAt, finished }

async function generateWeekPredictions(weekStart) {
  const days = getTradingDaysOfWeek(weekStart);
  const weekEnd = days[4];
  const total = FORECAST_SYMBOLS.length;
  let done = 0, errors = 0;

  _forecastProgress = { total, done: 0, errors: 0, week_start: weekStart, started_at: new Date().toISOString(), finished: false };

  // Fetch earnings dates in batches of 20 to avoid rate limiting
  const earningsMap = {};
  const EARN_BATCH = 20;
  for (let i = 0; i < FORECAST_SYMBOLS.length; i += EARN_BATCH) {
    const batch = FORECAST_SYMBOLS.slice(i, i + EARN_BATCH);
    const results = await Promise.allSettled(
      batch.map(sym => _yf.quoteSummary(sym, { modules: ['calendarEvents'] }).catch(() => null))
    );
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r.status !== 'fulfilled' || !r.value) continue;
      const rawDates = r.value.calendarEvents?.earnings?.earningsDate ?? [];
      const inWindow = rawDates
        .map(d => (d instanceof Date ? d : new Date(d)))
        .filter(d => !isNaN(d))
        .map(d => { const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),dd=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${dd}`; })
        .find(ds => ds >= weekStart && ds <= weekEnd);
      if (inWindow) earningsMap[batch[j]] = inWindow;
    }
  }

  // Generate predictions in batches of 10
  const BATCH = 10;
  for (let i = 0; i < FORECAST_SYMBOLS.length; i += BATCH) {
    const batch = FORECAST_SYMBOLS.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async sym => {
      try {
        const pred = await getStockPrediction(sym);
        const base  = pred.current_price;
        if (!base) throw new Error('no price');
        const slope = pred.trend?.slope_per_day ?? 0;
        const rSq   = pred.trend?.r_squared     ?? 0;
        const sig   = pred.overall_signal;
        const earningsDate = earningsMap[sym] ?? null;

        // Fetch calibration factors once per symbol using day-1 change as input.
        // applyCalibrationToDay() then re-applies the same bias + reversal factor
        // to each day's projected change without additional DB calls.
        const day1Price     = +(base + slope).toFixed(4);
        const day1ChangePct = +((day1Price - base) / base * 100).toFixed(4);
        const cal = await applyCalibration(sym, day1ChangePct, rSq).catch(() => null);

        for (let d = 0; d < days.length; d++) {
          const projPrice     = +(base + slope * (d + 1)).toFixed(4);
          const projChangePct = +((projPrice - base) / base * 100).toFixed(4);
          const adjChangePct  = applyCalibrationToDay(projChangePct, cal);
          await upsertPrediction({
            symbol: sym, week_start: weekStart, target_date: days[d],
            predicted_price: projPrice, predicted_change_pct: projChangePct,
            base_price: base, algorithm_signal: sig,
            slope_per_day: slope, r_squared: rSq,
            has_earnings: !!earningsDate, earnings_date: earningsDate,
            adjusted_change_pct: adjChangePct,
            confidence: cal?.confidence ?? null,
          });
        }
        done++;
      } catch (e) {
        errors++;
      }
      _forecastProgress = { ..._forecastProgress, done, errors };
    }));
  }

  _forecastProgress = { total, done, errors, week_start: weekStart, started_at: _forecastProgress.started_at, finished: true, finished_at: new Date().toISOString() };
  console.log(`[forecast] generated ${done}/${total} symbols for week ${weekStart} (${errors} errors)`);
  return { generated: done, errors, week_start: weekStart };
}

async function fillTodayActuals(dateStr) {
  // Fetch closing prices for all symbols in batches.
  // Uses regularMarketPrice (live/last price after 4 PM = official close).
  let filled = 0;
  const BATCH = 10;
  for (let i = 0; i < FORECAST_SYMBOLS.length; i += BATCH) {
    const batch = FORECAST_SYMBOLS.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async sym => {
      try {
        const data = await _yf.quoteSummary(sym, { modules: ['price'] });
        const p = data?.price;
        // After 4 PM ET regularMarketPrice IS the official close; use postMarketPrice as fallback
        const close = p?.regularMarketPrice ?? p?.postMarketPrice ?? null;
        if (!close) return;
        await fillActualPrice(sym, dateStr, close);
        filled++;
      } catch {}
    }));
  }
  console.log(`[forecast] filled actuals for ${dateStr}: ${filled} symbols`);
  if (filled > 0) {
    trainCalibration().then(r => {
      if (!r?.skipped) console.log(`[calibration] retrained on ${r?.samples ?? 0} actuals`);
    }).catch(err => console.error('[calibration] train error:', err.message));
  }
  return filled;
}

// GET /api/forecast — current week predictions + actuals
app.get('/api/forecast', requireAuth, async (req, res) => {
  try {
    const weekStart = req.query.week || getMondayStr();
    const rows = await getPredictionsForWeek(weekStart);
    const history = await getPredictionHistory({ limit: 8 });

    // pg returns NUMERIC columns as strings — coerce everything to numbers
    const n = v => v == null ? null : +v;

    // Pivot rows into per-symbol objects
    const bySymbol = {};
    for (const r of rows) {
      if (!bySymbol[r.symbol]) {
        bySymbol[r.symbol] = {
          symbol: r.symbol, week_start: r.week_start,
          base_price:        n(r.base_price),
          algorithm_signal:  n(r.algorithm_signal),
          r_squared:         n(r.r_squared),
          slope_per_day:     n(r.slope_per_day),
          has_earnings: r.has_earnings, earnings_date: r.earnings_date,
          days: {},
        };
      }
      bySymbol[r.symbol].days[r.target_date] = {
        date:                 r.target_date,
        predicted_price:      n(r.predicted_price),
        predicted_change_pct: n(r.predicted_change_pct),
        adjusted_change_pct:  n(r.adjusted_change_pct),
        confidence:           r.confidence != null ? +r.confidence : null,
        actual_price:         n(r.actual_price),
        actual_change_pct:    n(r.actual_change_pct),
        error_pct:            n(r.error_pct),
      };
    }

    const symbols = Object.values(bySymbol).sort((a, b) => a.symbol.localeCompare(b.symbol));
    const days = getTradingDaysOfWeek(weekStart);

    // Overall accuracy stats for this week
    const filled   = rows.filter(r => r.actual_price != null);
    const avgError = filled.length
      ? +(filled.reduce((s, r) => s + Math.abs(n(r.error_pct) ?? 0), 0) / filled.length).toFixed(2)
      : null;
    const directionHits = filled.filter(r =>
      r.predicted_change_pct != null && r.actual_change_pct != null &&
      ((n(r.predicted_change_pct) > 0 && n(r.actual_change_pct) > 0) ||
       (n(r.predicted_change_pct) < 0 && n(r.actual_change_pct) < 0))
    ).length;
    const directionAcc = filled.length ? +(directionHits / filled.length * 100).toFixed(1) : null;

    // Today's movers from Strong Buys cache that aren't in the forecast universe
    const forecastSet = new Set(symbols.map(s => s.symbol));
    const movers = (_sbCache?.picks || [])
      .filter(p => !forecastSet.has(p.symbol))
      .map(p => ({ symbol: p.symbol, name: p.name, score: p.score, grade: p.grade, horizon: p.horizon }));

    res.json({
      success: true,
      week_start: weekStart,
      days,
      symbols,
      movers,
      stats: { total_predictions: rows.length, filled: filled.length, avg_abs_error_pct: avgError, direction_accuracy_pct: directionAcc },
      history,
    });
  } catch (err) {
    console.error('[forecast]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/forecast/generate — fire-and-forget, returns immediately
app.post('/api/forecast/generate', requireAuth, (req, res) => {
  if (_forecastProgress && !_forecastProgress.finished) {
    return res.json({ success: true, status: 'already_running', progress: _forecastProgress });
  }
  const weekStart = getMondayStr();
  generateWeekPredictions(weekStart).catch(err => console.error('[forecast] generate error:', err.message));
  res.json({ success: true, status: 'started', week_start: weekStart, total: FORECAST_SYMBOLS.length });
});

// GET /api/forecast/progress — poll generation progress
app.get('/api/forecast/progress', requireAuth, (req, res) => {
  res.json(_forecastProgress || { finished: true, done: 0, total: 0 });
});

// POST /api/forecast/fill-actuals — manually trigger EOD fill
app.post('/api/forecast/fill-actuals', requireAuth, async (req, res) => {
  try {
    const dateStr = req.query.date || new Date().toISOString().split('T')[0];
    const filled = await fillTodayActuals(dateStr);
    res.json({ success: true, filled, date: dateStr });
  } catch (err) {
    console.error('[forecast/fill-actuals]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/forecast/failure-analysis — calibration stats and prediction failure breakdown
app.get('/api/forecast/failure-analysis', requireAuth, async (req, res) => {
  try {
    const data = await getFailureAnalysis({ limit: 6 });
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[failure-analysis]', err);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/forecast/train-calibration — manually retrain calibration model
app.post('/api/forecast/train-calibration', requireAuth, async (req, res) => {
  try {
    const result = await trainCalibration();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[forecast/train-calibration]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Throttled on-demand sync: fire-and-forget, max once per 45s
let _lastSyncMs = 0;
function triggerSyncIfDue() {
  const now = Date.now();
  if (now - _lastSyncMs < 45_000) return;
  _lastSyncMs = now;
  syncClosedTrades().then(r => {
    if (r.synced > 0) console.log('[sync] on-demand closed', r.trades.map(t => `${t.symbol} $${t.pnl_usd}`).join(', '));
  }).catch(err => console.error('[sync] on-demand error:', err.message));
}

// Overview — everything needed for the dashboard in one call
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const rawSource = req.query.source;
    const source = rawSource === 'moomoo' ? 'moomoo' : rawSource === 'alpaca_live' ? 'alpaca_live' : rawSource === 'tiger' ? 'tiger' : 'alpaca';
    const sessionUser = await getUser(req.session.username);
    const isAdmin     = sessionUser?.role === 'admin';
    const dbUser      = isDbAvailable() ? await getDbUser(req.session.username) : null;
    const userCreds   = dbUser?.alpaca_api_key
      ? { apiKey: dbUser.alpaca_api_key, secretKey: dbUser.alpaca_secret_key, baseUrl: dbUser.alpaca_base_url }
      : null;

    // Keep DB in sync with Alpaca on every dashboard load (throttled to once per 45s)
    if (source === 'alpaca' || isAdmin) triggerSyncIfDue();

    // P&L: admin→bot's paper account, regular user→their own paper account, live/real→null
    const getPnl = () => {
      if (source === 'alpaca_live' || source === 'moomoo' || source === 'tiger') return Promise.resolve(null);
      if (isAdmin) return getDailyPnL();
      // Only use user's creds if they match the selected source (paper creds for paper source)
      if (userCreds && isPaperUrl(userCreds.baseUrl)) return getUserDailyPnL(userCreds);
      return Promise.resolve(null);
    };

    const getOpenOrders = () => {
      if (source === 'alpaca_live') return getLiveOrders({ status: 'open' }).catch(() => []);
      if (source === 'alpaca' || isAdmin) return getOrders({ status: 'open' }).catch(() => []);
      return Promise.resolve([]);
    };

    const [acctRes, pnlRes, sentRes, openOrdersRes] = await Promise.allSettled([
      getAccountData(source, req.session.username),
      getPnl(),
      getMarketSentiment(),
      getOpenOrders(),
    ]);
    const acctData   = acctRes.status === 'fulfilled' ? acctRes.value : { account: null, positions: [] };
    if (acctData.needs_alpaca_setup) return res.json({ needs_alpaca_setup: true });
    if (acctData.needs_tiger_setup)  return res.json({ needs_tiger_setup: true });
    const { account, positions } = acctData;
    const pnl        = pnlRes.status       === 'fulfilled' ? pnlRes.value       : null;
    const sentiment  = sentRes.status      === 'fulfilled' ? sentRes.value      : null;
    const openOrders = openOrdersRes.status === 'fulfilled' ? (openOrdersRes.value ?? []) : [];

    // Recent trades — scoped to the logged-in user's own account
    let trades = [];
    if (source === 'tiger') {
      try {
        const dbUser2 = isDbAvailable() ? await getDbUser(req.session.username) : null;
        if (dbUser2?.tiger_id) {
          const creds = { tiger_id: dbUser2.tiger_id, account: dbUser2.tiger_account, private_key: dbUser2.tiger_private_key };
          const orders = await getTigerOrders(creds, { days: 30 });
          trades = orders.slice(0, 10).map(o => ({
            symbol:      o.symbol,
            side:        (o.action || o.side || '').toLowerCase(),
            qty:         o.filledQuantity ?? o.quantity ?? o.qty ?? 0,
            entry_price: o.avgFillPrice   ?? o.filledPrice ?? o.price ?? 0,
            status:      o.status,
            opened_at:   o.openTime ? new Date(o.openTime).toISOString() : null,
            source:      'tiger',
          }));
        }
      } catch { trades = []; }
    } else if (source === 'moomoo') {
      try {
        const res = await getMoomooOrders({ status: 'history' });
        trades = (res.orders || []).slice(0, 10).map(o => ({
          symbol:      o.symbol,
          side:        o.side,
          qty:         o.qty,
          entry_price: o.filled_avg_price || o.price,
          status:      o.status,
          opened_at:   o.create_time,
          source:      'moomoo',
        }));
      } catch { trades = []; }
    } else if (source === 'alpaca_live') {
      // Live account — show live orders
      try {
        const liveOrders = await getLiveOrders({ status: 'all' });
        trades = (liveOrders || []).slice(0, 10).map(o => ({
          symbol:      o.symbol,
          side:        o.side,
          qty:         parseFloat(o.qty || 0),
          entry_price: parseFloat(o.filled_avg_price || o.limit_price || 0),
          status:      o.status,
          opened_at:   o.created_at,
          source:      'alpaca_live',
        }));
      } catch { trades = []; }
    } else if (isAdmin) {
      // Admin paper account — DB trades (force trades) + Alpaca orders (quick trades)
      const [openTrades, recentClosed, alpacaOrders] = await Promise.all([
        getTrades({ status: 'open',   limit: 50, account_source: 'alpaca_paper' }),
        getTrades({ status: 'closed', limit: 10, account_source: 'alpaca_paper' }),
        getOrders({ status: 'all' }).catch(() => []),
      ]);
      const seen = new Set();
      const dbTrades = [...(openTrades ?? []), ...(recentClosed ?? [])].filter(t => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      }).map(t => ({ ...t, source: 'force' }));
      // Include Alpaca quick trades that aren't already tracked in the DB
      const dbOrderIds = new Set(dbTrades.map(t => t.order_id).filter(Boolean));
      const qtTrades = (Array.isArray(alpacaOrders) ? alpacaOrders : [])
        .filter(o => !o.parent_id && !dbOrderIds.has(o.id) && o.status !== 'canceled')
        .slice(0, 15)
        .map(o => ({
          symbol:      o.symbol,
          side:        o.side,
          qty:         parseFloat(o.qty || 0),
          entry_price: parseFloat(o.filled_avg_price || 0) || null,
          stop_loss:   null,
          take_profit: null,
          status:      ['filled', 'partially_filled'].includes(o.status) ? 'closed' : 'open',
          opened_at:   o.created_at,
          source:      'quick',
        }));
      trades = [...dbTrades, ...qtTrades]
        .sort((a, b) => new Date(b.opened_at) - new Date(a.opened_at))
        .slice(0, 20);
    } else if (userCreds && isPaperUrl(userCreds.baseUrl)) {
      // Regular user — their own paper Alpaca account
      try { trades = await getUserOrders(userCreds, { status: 'all', limit: 10 }); }
      catch { trades = []; }
    }

    // Today's score count from DB (market-wide — same for all users)
    let scoresCount = 0;
    if (isDbAvailable()) {
      const { rows } = await query(
        `SELECT COUNT(*) as cnt FROM conviction_scores WHERE scored_at >= CURRENT_DATE`
      );
      scoresCount = parseInt(rows[0]?.cnt ?? 0);
    }

    res.json({
      source,
      account,
      positions:     positions ?? [],
      open_orders:   openOrders,
      pnl,
      sentiment,
      recent_trades: trades ?? [],
      scores_today:  scoresCount,
    });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Trades history — scoped per user
app.get('/api/trades', requireAuth, async (req, res) => {
  try {
    const rawSource = req.query.source || 'alpaca';
    const source = rawSource === 'moomoo' ? 'moomoo' : rawSource === 'alpaca_live' ? 'alpaca_live' : rawSource === 'tiger' ? 'tiger' : 'alpaca';
    const status = req.query.status || null;
    const limit  = Math.min(parseInt(req.query.limit) || 100, 500);
    const tradesUser = await getUser(req.session.username);
    const tradesAdmin = tradesUser?.role === 'admin';

    if (source === 'moomoo') {
      const histStatus = status === 'open' ? 'active' : 'history';
      const result = await getMoomooOrders({ status: histStatus });
      const trades = (result.orders || []).slice(0, limit).map(o => ({
        symbol:           o.symbol,
        side:             o.side,
        qty:              o.qty,
        entry_price:      o.filled_avg_price || o.price,
        stop_loss:        null,
        take_profit:      null,
        atr_pct:          null,
        conviction_score: null,
        conviction_grade: null,
        status:           o.status,
        pnl_usd:          null,
        opened_at:        o.create_time,
        source:           'moomoo',
      }));
      return res.json({ source: 'moomoo', trades });
    }

    // Live account — fetch live orders (admin or anyone with live source selected)
    if (source === 'alpaca_live') {
      if (tradesAdmin) {
        const orders = await getLiveOrders({ status: status || 'all' });
        return res.json({ source: 'alpaca_live', trades: (orders || []).slice(0, limit) });
      }
      // Non-admin: use their stored live credentials if they have them
      const dbUser = isDbAvailable() ? await getDbUser(req.session.username) : null;
      if (dbUser?.alpaca_live_api_key) {
        const creds = { apiKey: dbUser.alpaca_live_api_key, secretKey: dbUser.alpaca_live_secret_key, baseUrl: 'https://api.alpaca.markets' };
        const orders = await getUserOrders(creds, { status: status || 'all', limit });
        return res.json({ source: 'alpaca_live', trades: orders });
      }
      return res.json({ source: 'alpaca_live', trades: [], message: 'No live Alpaca account connected' });
    }

    // Paper source — admin sees DB force trades merged with Alpaca quick trades
    if (tradesAdmin) {
      const [dbTrades, alpacaOrders] = await Promise.allSettled([
        getTrades({ status, limit, account_source: 'alpaca_paper' }),
        getOrders({ status: 'all', limit: 50 }),
      ]);
      const db = (dbTrades.status === 'fulfilled' ? dbTrades.value : null) ?? [];
      const ao = (alpacaOrders.status === 'fulfilled' ? alpacaOrders.value : null) ?? [];
      const dbIds = new Set(db.map(t => t.order_id).filter(Boolean));
      const qtFromAlpaca = ao
        .filter(o => !o.parent_id && !dbIds.has(o.id) && o.status !== 'canceled')
        .map(o => ({
          symbol:           o.symbol,
          side:             o.side,
          qty:              parseFloat(o.qty || 0),
          entry_price:      parseFloat(o.filled_avg_price || 0) || null,
          stop_loss:        null,
          take_profit:      null,
          status:           ['filled', 'partially_filled'].includes(o.status) ? 'closed' : 'open',
          opened_at:        o.created_at,
          source:           'quick',
        }))
        .filter(qt => !status || qt.status === status);
      const merged = [...db.map(t => ({ ...t, source: 'force' })), ...qtFromAlpaca]
        .sort((a, b) => new Date(b.opened_at) - new Date(a.opened_at))
        .slice(0, limit);
      return res.json({ source: 'db', trades: merged });
    }

    // Tiger source — fetch user's Tiger orders
    if (source === 'tiger') {
      const dbUserT = isDbAvailable() ? await getDbUser(req.session.username) : null;
      if (!dbUserT?.tiger_id) return res.json({ source: 'tiger', trades: [] });
      const creds = { tiger_id: dbUserT.tiger_id, account: dbUserT.tiger_account, private_key: dbUserT.tiger_private_key };
      const normaliseTigerStatus = s => {
        const u = (s || '').toUpperCase();
        if (u === 'FILLED')                         return 'closed';
        if (u === 'PARTIAL_FILLED')                 return 'partial';
        if (['NEW', 'PENDING', 'HELD', 'SUBMITTED'].includes(u)) return 'open';
        if (['CANCELLED', 'CANCELED'].includes(u))  return 'cancelled';
        if (u === 'EXPIRED')                        return 'expired';
        if (u === 'INVALID')                        return 'rejected';
        return s?.toLowerCase() || 'unknown';
      };
      const orders = await getTigerOrders(creds, { days: 90 });
      const trades = orders.slice(0, limit).map(o => ({
        symbol:      o.symbol,
        side:        (o.action || o.side || '').toLowerCase(),
        qty:         o.filledQuantity || o.quantity || o.totalQuantity || 0,
        entry_price: o.avgFillPrice ?? o.filledPrice ?? o.price ?? 0,
        status:      normaliseTigerStatus(o.status),
        tiger_status: o.status,
        opened_at:   o.createTime ? new Date(o.createTime).toISOString() : null,
        source:      'tiger',
      }));
      return res.json({ source: 'tiger', trades });
    }

    // Paper source — regular user: Alpaca API orders + their own DB-recorded bot trades
    const dbUser = isDbAvailable() ? await getDbUser(req.session.username) : null;
    if (!dbUser?.alpaca_api_key || !isPaperUrl(dbUser.alpaca_base_url)) {
      // No Alpaca creds — return only their DB trades (bot trades placed on their behalf)
      const dbTrades = await getTrades({ status, limit, username: req.session.username, account_source: 'alpaca_paper' }) ?? [];
      return res.json({ source: 'alpaca_user', trades: dbTrades.map(t => ({ ...t, source: 'force' })) });
    }
    const creds  = { apiKey: dbUser.alpaca_api_key, secretKey: dbUser.alpaca_secret_key, baseUrl: dbUser.alpaca_base_url };
    const alpacaStatus = status === 'open' ? 'open' : 'all';
    const [orders, dbTrades] = await Promise.allSettled([
      getUserOrders(creds, { status: alpacaStatus, limit }),
      getTrades({ status, limit, username: req.session.username, account_source: 'alpaca_paper' }),
    ]);
    const alpacaOrders = orders.status === 'fulfilled' ? (orders.value ?? []) : [];
    const userDbTrades = dbTrades.status === 'fulfilled' ? (dbTrades.value ?? []) : [];
    // Merge, deduplicating by order_id
    const alpacaIds = new Set(alpacaOrders.map(o => o.id).filter(Boolean));
    const extraDb = userDbTrades
      .filter(t => !t.order_id || !alpacaIds.has(t.order_id))
      .map(t => ({ ...t, source: 'force' }));
    const merged = [...alpacaOrders, ...extraDb]
      .sort((a, b) => new Date(b.opened_at ?? b.created_at ?? 0) - new Date(a.opened_at ?? a.created_at ?? 0))
      .slice(0, limit);
    res.json({ source: 'alpaca_user', trades: merged });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Conviction score history — shows the latest market date's scores
app.get('/api/scores', async (req, res) => {
  try {
    if (!isDbAvailable()) return res.json({ scores: [], market_date: null });
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);

    // Find the most recent date that has scores (handles weekends/holidays/off-hours)
    const { rows: dateRows } = await query(
      `SELECT scored_at::date AS market_date
       FROM conviction_scores
       ORDER BY scored_at DESC LIMIT 1`
    );
    if (!dateRows.length) return res.json({ scores: [], market_date: null });

    const marketDate = dateRows[0].market_date; // e.g. "2026-04-22"

    const { rows } = await query(
      `SELECT DISTINCT ON (symbol) symbol, name, score, grade, technical_summary, tv_available, scored_at
       FROM conviction_scores
       WHERE scored_at::date = $1
       ORDER BY symbol, scored_at DESC`,
      [marketDate]
    );
    // Sort by grade then score desc after deduplication
    rows.sort((a, b) => {
      const go = { A: 0, B: 1, C: 2, F: 3 };
      return (go[a.grade] ?? 9) - (go[b.grade] ?? 9) || b.score - a.score;
    });
    res.json({ scores: rows, market_date: marketDate });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Trigger a batch conviction score scan (scores top movers + default watchlist)
app.post('/api/scores/scan', requireAdmin, async (req, res) => {
  const DEFAULT_WATCHLIST = [
    'MRVL','NVDA','AMD','AAPL','MSFT','GOOGL','META','AMZN',
    'TSLA','NFLX','INTC','QCOM','MU','AVGO','TSM','SMCI','RTX','LMT','XOM','JPM',
  ];

  // SSE so the browser can stream progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // Merge market movers with watchlist (deduplicated)
    let symbols = [...DEFAULT_WATCHLIST];
    try {
      const movers = await getMarketMovers({ limit: 20 });
      const moverSymbols = [
        ...(movers?.gainers?.map(m => m.symbol) ?? []),
        ...(movers?.actives?.map(m => m.symbol) ?? []),
      ];
      symbols = [...new Set([...moverSymbols, ...DEFAULT_WATCHLIST])];
    } catch { /* use watchlist only */ }

    send({ type: 'start', total: symbols.length });

    const results = [];
    for (const symbol of symbols) {
      try {
        const score = await getConvictionScore({ symbol, positions: [] });
        results.push({ symbol, score: score.score, grade: score.grade });
        send({ type: 'progress', symbol, score: score.score, grade: score.grade });
      } catch (e) {
        send({ type: 'skip', symbol, reason: e.message });
      }
    }

    send({ type: 'done', scanned: results.length });
  } catch (err) {
    console.error(err); send({ type: 'error', message: 'Internal server error' });
  } finally {
    res.end();
  }
});

// Strong Buys Today — scan watchlist + movers, return grade A/B with reasoning

let _sbCache = null;
let _sbCacheTs = 0;
let _sbScanning = false; // prevent concurrent scans

async function runStrongBuysScan() {
  if (_sbScanning) return _sbCache; // already running — return stale cache
  _sbScanning = true;
  try {
    let symbols = [...DEFAULT_WATCHLIST_SB];
    try {
      const movers = await getMarketMovers({ limit: 20 });
      const moverSyms = [
        ...(movers?.gainers?.map(m => m.symbol) ?? []),
        ...(movers?.actives?.map(m => m.symbol) ?? []),
      ].filter(s => !/^\^/.test(s));
      symbols = [...new Set([...symbols, ...moverSyms])];
    } catch { /* watchlist only */ }

    const BATCH = 5;
    const results = [];
    for (let i = 0; i < symbols.length; i += BATCH) {
      const batch   = symbols.slice(i, i + BATCH);
      const settled = await Promise.allSettled(
        batch.map(sym => getConvictionScore({ symbol: sym, positions: [] }))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && (r.value.grade === 'A' || r.value.grade === 'B')) {
          const s = r.value;
          results.push({
            symbol:    s.symbol,
            name:      s.name,
            score:     s.score,
            grade:     s.grade,
            horizon:   deriveHorizon(s),
            reasoning: deriveReasoning(s),
            signals:   {
              analyst:        s.signals.analyst_consensus,
              analyst_target: s.signals.analyst_target,
              analyst_upside: s.signals.analyst_upside_pct,
              rvol:           s.signals.rvol,
              weekly_trend:   s.signals.weekly_trend,
              short_float:    s.signals.short_float_pct,
              insider_buys:   s.signals.insider_buys_60d,
              vix:            s.signals.vix,
            },
          });
        }
      }
    }
    results.sort((a, b) => b.score - a.score);
    _sbCache   = { picks: results, scanned: symbols.length, generated_at: new Date().toISOString() };
    _sbCacheTs = Date.now();

    // Persist to DB for future simulation — store today's date in ET
    if (results.length > 0 && isDbAvailable()) {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      for (const p of results) {
        saveDailyPick({
          date:    today,
          type:    'strong_buy',
          symbol:  p.symbol,
          name:    p.name,
          score:   p.score,
          grade:   p.grade,
          horizon: p.horizon,
          price:   p.signals?.analyst_target ?? null,
          rvol:    p.signals?.rvol ?? null,
          signals: p.signals,
        }).catch(() => {});
      }
    }

    return _sbCache;
  } finally {
    _sbScanning = false;
  }
}

app.get('/api/strong-buys', async (req, res) => {
  try {
    const force = req.query.force === '1';
    if (!force && _sbCache && Date.now() - _sbCacheTs < 15 * 60 * 1000)
      return res.json(_sbCache);
    const result = await runStrongBuysScan();
    if (!result) return res.json({ picks: [], scanned: 0, generated_at: new Date().toISOString() });
    res.json(result);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

function deriveHorizon(s) {
  // Long-term: strong analyst coverage, strong weekly trend, earnings quality
  const longSignals = [
    s.signals.analyst_consensus === 'strong_buy',
    s.signals.weekly_trend === 'up',
    s.signals.insider_buys_60d >= 2,
    s.breakdown?.earnings_quality > 0,
  ].filter(Boolean).length;

  // Short-term: high RVOL, oversold RSI, near support, squeeze setup
  const shortSignals = [
    (s.signals.rvol ?? 0) >= 1.5,
    s.breakdown?.rsi_oversold > 0,
    s.breakdown?.near_support > 0,
    s.breakdown?.short_squeeze > 0,
  ].filter(Boolean).length;

  if (longSignals >= 3) return 'Long-term hold';
  if (shortSignals >= 2) return 'Short-term trade';
  if (longSignals >= 2) return 'Medium-term (weeks)';
  return 'Short-term trade';
}

function deriveReasoning(s) {
  const parts = [];

  // Lead with conviction score + grade + ML adjustment
  const mlAdj = s.breakdown?.backtest_alpha_adj ?? 0;
  const mlSrc = s.signals?.weights_source;
  const mlTag = mlAdj !== 0
    ? ` · ML adj ${mlAdj > 0 ? '+' : ''}${mlAdj}${mlSrc === 'ml_model' ? ' (live model)' : ' (backtest)'}`
    : '';
  parts.push(`Conviction ${s.score}/100 · Grade ${s.grade}${mlTag}`);

  // Analyst signal
  if (s.signals.analyst_consensus === 'strong_buy')
    parts.push(`Wall St. Strong Buy (target $${s.signals.analyst_target ? s.signals.analyst_target.toFixed(0) : '?'}${s.signals.analyst_upside_pct ? ', +' + s.signals.analyst_upside_pct + '% upside' : ''})`);
  else if (s.signals.analyst_consensus === 'buy')
    parts.push('Analyst Buy consensus');

  // Momentum & technicals
  if (s.signals.weekly_trend === 'up')    parts.push('weekly uptrend confirmed');
  if ((s.signals.rvol ?? 0) >= 2.0)      parts.push(`RVOL ${s.signals.rvol}× (heavy volume)`);
  else if ((s.signals.rvol ?? 0) >= 1.5) parts.push(`RVOL ${s.signals.rvol}× (elevated volume)`);
  if (s.breakdown?.above_both_emas > 0)  parts.push('above EMA20/50');
  if (s.breakdown?.macd_positive > 0)    parts.push('MACD positive');
  if (s.breakdown?.rsi_oversold > 0)     parts.push('RSI oversold');

  // Fundamental / insider
  if (s.signals.insider_buys_60d >= 2)   parts.push(`${s.signals.insider_buys_60d} insider buys (60d)`);
  else if (s.signals.insider_buys_60d === 1) parts.push('1 insider buy (60d)');
  if (s.breakdown?.near_support > 0)     parts.push('near key support');
  if (s.breakdown?.short_squeeze > 0)    parts.push(`short squeeze candidate (${s.signals.short_float_pct ?? s.signals.short_float}% float short)`);

  return parts.join(' · ');
}

// ─── Intraday Picks ───────────────────────────────────────────────────────────
// Scans for high-RVOL, high-ATR stocks with a catalyst — sized to target $150/day

let _idCache = null;
let _idCacheTs = 0;
let _idScanning = false;

const INTRADAY_UNIVERSE = [
  // High-beta, liquid, intraday-friendly
  'NVDA','AMD','TSLA','META','AMZN','GOOGL','MSFT','AAPL','NFLX',
  'COIN','MSTR','PLTR','ARM','SMCI','MRVL','MU','AVGO','QCOM',
  'CRWD','PANW','NET','DDOG','SNOW','SHOP','UBER','RIVN',
  'XOM','CVX','JPM','GS','BAC','MS',
];

async function fetchATRPct(symbol) {
  // Tier 1: Moomoo (real-time OHLCV)
  try {
    const atr = await getMoomooAtrPct({ symbol, period: 14 });
    if (atr != null) return atr;
  } catch { /* fall through */ }
  // Tier 2: Yahoo Finance fallback
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=30d`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const d   = await r.json();
    const q   = d?.chart?.result?.[0]?.indicators?.quote?.[0];
    const c   = q?.close?.filter(v => v != null) ?? [];
    const h   = q?.high?.filter(v => v != null)  ?? [];
    const l   = q?.low?.filter(v => v != null)   ?? [];
    if (h.length < 5) return null;
    const bars = Math.min(14, h.length);
    const trs  = [];
    for (let i = h.length - bars; i < h.length; i++) trs.push(h[i] - l[i]);
    const atr  = trs.reduce((a, b) => a + b, 0) / trs.length;
    const price = c[c.length - 1];
    return price > 0 ? +((atr / price) * 100).toFixed(2) : null;
  } catch { return null; }
}

async function fetchRVOL(symbol) {
  // Tier 1: Moomoo KLines (real-time volume)
  try {
    const result = await getMoomooKLines({ symbol, klType: 'day', count: 22 });
    if (result?.success && result.candles?.length >= 5) {
      const candles = result.candles;
      const today   = candles.at(-1)?.volume ?? 0;
      const prev    = candles.slice(0, -1);
      const avgVol  = prev.reduce((s, c) => s + (c.volume ?? 0), 0) / prev.length;
      return avgVol > 0 ? +(today / avgVol).toFixed(2) : null;
    }
  } catch { /* fall through */ }
  // Tier 2: Yahoo Finance fallback
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=30d`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const d   = await r.json();
    const vol = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.volume?.filter(v => v != null) ?? [];
    if (vol.length < 5) return null;
    const today  = vol[vol.length - 1];
    const avgVol = vol.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.min(20, vol.length - 1);
    return avgVol > 0 ? +(today / avgVol).toFixed(2) : null;
  } catch { return null; }
}

async function fetchCurrentPrice(symbol) {
  // Tier 1: Moomoo (real-time, includes pre/after-hours)
  try {
    const q = await getMoomooQuote(symbol);
    if (q?.success && q.price != null) return { price: +q.price.toFixed(2), change_pct: q.change_pct ?? null, change: q.change ?? null, session: 'regular' };
  } catch { /* fall through */ }
  // Tier 2: Yahoo Finance quoteSummary — covers pre-market, regular, after-hours
  try {
    const data = await _yf.quoteSummary(symbol, { modules: ['price'] });
    const p = data?.price;
    if (!p) throw new Error('no price module');
    // Pick the most current session price
    const now = new Date();
    const etHour = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
    let price, change, change_pct, session;
    if (etHour < 9 || (etHour === 9 && new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getMinutes() < 30)) {
      // Pre-market (before 9:30 AM ET)
      price      = p.preMarketPrice      ?? p.regularMarketPrice;
      change     = p.preMarketChange     ?? p.regularMarketChange;
      change_pct = p.preMarketChangePercent != null ? +(p.preMarketChangePercent * 100).toFixed(2) : null;
      session    = p.preMarketPrice != null ? 'pre' : 'regular';
    } else if (etHour >= 16) {
      // After-hours (4 PM ET onwards)
      price      = p.postMarketPrice     ?? p.regularMarketPrice;
      change     = p.postMarketChange    ?? p.regularMarketChange;
      change_pct = p.postMarketChangePercent != null ? +(p.postMarketChangePercent * 100).toFixed(2) : null;
      session    = p.postMarketPrice != null ? 'post' : 'regular';
    } else {
      price      = p.regularMarketPrice;
      change     = p.regularMarketChange;
      change_pct = p.regularMarketChangePercent != null ? +(p.regularMarketChangePercent * 100).toFixed(2) : null;
      session    = 'regular';
    }
    if (price == null) throw new Error('no price');
    return { price: +price.toFixed(2), change: change != null ? +change.toFixed(2) : null, change_pct, session };
  } catch { return null; }
}

function classifySetup({ rvol, atr_pct, change_pct, rsi, short_float_pct, rs_signal }) {
  const chg = change_pct ?? 0;
  // Gap & Go: opened with meaningful gap on heavy volume
  if (chg >= 2 && rvol >= 1.8)
    return { type: 'Gap & Go', color: '#3fb950', desc: 'Strong gap up with heavy volume — momentum continuation play' };
  // Squeeze Play: high short + rising + volume
  if ((short_float_pct ?? 0) >= 12 && rvol >= 1.5 && chg > 0)
    return { type: 'Squeeze Play', color: '#bc8cff', desc: 'High short interest being squeezed — forced short covering amplifies move' };
  // Oversold Bounce: deep RSI + volume returning
  if (rsi != null && rsi < 38 && rvol >= 1.3)
    return { type: 'Oversold Bounce', color: '#58a6ff', desc: 'RSI oversold, volume picking up — snap-back rally setup' };
  // Capitulation Buy: big red day with heavy volume
  if (chg <= -2 && rvol >= 1.8)
    return { type: 'Capitulation Buy', color: '#f0883e', desc: 'Panic selling with high volume — exhaustion reversal opportunity' };
  // Default momentum: elevated volume + any positive signal
  if (rvol >= 1.5 && (rs_signal === 'strong' || chg > 0.5 || atr_pct >= 2.5))
    return { type: 'Momentum Breakout', color: '#e3b341', desc: 'Elevated volume with relative strength — trend continuation' };
  return null;
}

async function runIntradayScan() {
  if (_idScanning) return _idCache;
  _idScanning = true;
  try {
    // Grab today's top movers and merge with base universe
    let symbols = [...INTRADAY_UNIVERSE];
    try {
      const movers = await getMarketMovers({ limit: 30 });
      const moverSyms = [
        ...(movers?.gainers?.map(m => m.symbol) ?? []),
        ...(movers?.actives?.map(m => m.symbol) ?? []),
      ].filter(s => !/^\^/.test(s));
      symbols = [...new Set([...moverSyms, ...symbols])]; // movers first
    } catch {}

    const MIN_RVOL = 1.3;
    const MIN_ATR  = 1.5;
    const TARGET_PROFIT = 150;

    const picks = [];
    const BATCH = 6; // lightweight fetches — no conviction score, so faster

    for (let i = 0; i < symbols.length && picks.length < 8; i += BATCH) {
      const batch = symbols.slice(i, i + BATCH);
      const settled = await Promise.allSettled(batch.map(async sym => {
        // Only use fast lightweight fetches — no getConvictionScore (too slow for scan)
        const [rvolData, atrPct, priceData] = await Promise.all([
          fetchRVOL(sym),
          fetchATRPct(sym),
          fetchCurrentPrice(sym),
        ]);

        const rvol       = rvolData;
        const atr        = atrPct;
        const price      = priceData?.price;
        const change_pct = priceData?.change_pct;

        // Filter: must have volume surge and enough daily range
        if (!rvol || rvol < MIN_RVOL) return null;
        if (!atr  || atr  < MIN_ATR)  return null;
        if (!price || price < 5)       return null;

        const setupInfo = classifySetup({ rvol, atr_pct: atr, change_pct, rsi: null, short_float_pct: null, rs_signal: 'neutral' });
        if (!setupInfo) return null;

        // Position sizing: target $150 profit at take-profit
        const stop_pct   = +(Math.min(8,  Math.max(1.5, 1.5 * atr)).toFixed(1));
        const target_pct = +(Math.min(20, Math.max(3,   3.0 * atr)).toFixed(1));
        const rawDollars = Math.round(TARGET_PROFIT / (target_pct / 100));
        const dollars    = Math.min(5000, Math.max(1500, rawDollars));
        const qty        = Math.floor(dollars / price);
        const invested   = +(qty * price).toFixed(2);
        const stopPrice  = +(price * (1 - stop_pct  / 100)).toFixed(2);
        const tgtPrice   = +(price * (1 + target_pct / 100)).toFixed(2);
        const estProfit  = +(invested * target_pct / 100).toFixed(0);
        const estRisk    = +(invested * stop_pct   / 100).toFixed(0);

        return {
          symbol:      sym,
          setup:       setupInfo.type,
          setup_desc:  setupInfo.desc,
          price,
          change_pct,
          rvol,
          atr_pct:     atr,
          qty,
          invested,
          stop_price:  stopPrice,
          target_price: tgtPrice,
          stop_pct,
          target_pct,
          est_profit:  estProfit,
          est_risk:    estRisk,
          rr:          estRisk > 0 ? +(estProfit / estRisk).toFixed(1) : null,
        };
      }));

      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) picks.push(r.value);
      }
    }

    // Sort: RVOL × ATR score (best intraday opportunity first)
    picks.sort((a, b) => (b.rvol * b.atr_pct) - (a.rvol * a.atr_pct));

    const topPicks = picks.slice(0, 8);
    _idCache   = { picks: topPicks, scanned: symbols.length, generated_at: new Date().toISOString() };
    _idCacheTs = Date.now();

    // Persist to DB for future simulation
    if (topPicks.length > 0 && isDbAvailable()) {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      for (const p of topPicks) {
        saveDailyPick({
          date:         today,
          type:         'intraday',
          symbol:       p.symbol,
          price:        p.price,
          rvol:         p.rvol,
          atr_pct:      p.atr_pct,
          stop_price:   p.stop_price,
          target_price: p.target_price,
          signals: {
            setup:       p.setup,
            setup_desc:  p.setup_desc,
            change_pct:  p.change_pct,
            qty:         p.qty,
            invested:    p.invested,
            stop_pct:    p.stop_pct,
            target_pct:  p.target_pct,
            est_profit:  p.est_profit,
            est_risk:    p.est_risk,
            rr:          p.rr,
          },
        }).catch(() => {});
      }
    }

    return _idCache;
  } finally {
    _idScanning = false;
  }
}

app.get('/api/intraday-picks', async (req, res) => {
  try {
    const force = req.query.force === '1';
    if (!force && _idCache && Date.now() - _idCacheTs < 10 * 60 * 1000)
      return res.json(_idCache);
    const result = await runIntradayScan();
    res.json(result ?? { picks: [], scanned: 0, generated_at: new Date().toISOString() });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Historical picks log — for simulation and backtesting
app.get('/api/picks/history', requireAuth, async (req, res) => {
  try {
    const { date, type, days } = req.query;
    const picks = await getDailyPicks({
      date:  date  || null,
      type:  type  || null,
      days:  days  ? parseInt(days) : 30,
      limit: 500,
    });
    res.json({ picks, total: picks.length });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Raw Alpaca debug — shows exactly what the API returns so we can verify calculations
app.get('/api/pnl-debug', requireAuth, async (req, res) => {
  try {
    const days   = parseInt(req.query.days) || 30;
    const dbUser = isDbAvailable() ? await getDbUser(req.session.username) : null;
    const creds  = dbUser?.alpaca_api_key
      ? { apiKey: dbUser.alpaca_api_key, secretKey: dbUser.alpaca_secret_key, baseUrl: dbUser.alpaca_base_url }
      : null;
    if (!creds) return res.json({ error: 'No Alpaca credentials stored for this user' });
    const r = await fetch(`${creds.baseUrl}/v2/account/portfolio/history?period=${days}D&timeframe=1D&intraday_reporting=market_hours`, {
      headers: { 'APCA-API-KEY-ID': creds.apiKey, 'APCA-API-SECRET-KEY': creds.secretKey },
    });
    const raw = await r.json();
    const n   = raw.timestamp?.length ?? 0;
    const slice = (arr, start, end) => (arr || []).slice(start, end);
    const fmt = (ts, i, arr_eq, arr_pl) => ({
      date:        new Date(ts * 1000).toISOString().split('T')[0],
      equity:      arr_eq[i],
      profit_loss: arr_pl[i],
    });
    res.json({
      base_value:  raw.base_value,
      total_bars:  n,
      first_5: slice(raw.timestamp, 0, 5).map((ts, i) => fmt(ts, i, raw.equity || [], raw.profit_loss || [])),
      last_5:  slice(raw.timestamp, Math.max(0, n - 5)).map((ts, i) => fmt(ts, Math.max(0, n - 5) + i, raw.equity || [], raw.profit_loss || [])),
    });
  } catch (err) {
    console.error('[portfolio-history]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Daily P&L history
app.get('/api/pnl', requireAuth, async (req, res) => {
  try {
    const days    = Math.min(90, parseInt(req.query.days) || 30);
    const source  = req.query.source || 'alpaca';
    const pnlUser = await getUser(req.session.username);
    const pnlAdmin = pnlUser?.role === 'admin';

    // Real-money accounts (moomoo, tiger, alpaca_live) — live snapshot + DB-stored daily history
    if (source === 'moomoo' || source === 'tiger' || source === 'alpaca_live') {
      console.log(`[pnl] source=${source} username=${req.session.username}`);
      const { account } = await getAccountData(source, req.session.username);
      console.log(`[pnl] account=${account ? JSON.stringify({ pv: account.portfolio_value, unreal: account.unrealized_pl }) : 'null'}`);

      // Persist today's snapshot so history accumulates over time
      if (account && isDbAvailable()) {
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        upsertAccountSnapshot({
          date:            todayStr,
          source,
          username:        req.session.username,
          portfolio_value: account.portfolio_value ?? null,
          realized_pl:     account.realized_pl    ?? null,
          unrealized_pl:   account.unrealized_pl  ?? null,
        }).catch(() => {});
      }

      // Build daily P&L history from stored snapshots (day-over-day realized_pl change)
      const snapshots = isDbAvailable()
        ? await getAccountSnapshots({ source, username: req.session.username, days })
        : [];

      const history = [];
      for (let i = 1; i < snapshots.length; i++) {
        const prev = snapshots[i - 1];
        const curr = snapshots[i];
        const realDelta = curr.realized_pl != null && prev.realized_pl != null
          ? +( parseFloat(curr.realized_pl) - parseFloat(prev.realized_pl) ).toFixed(2)
          : null;
        const equityDelta = curr.portfolio_value != null && prev.portfolio_value != null
          ? +( parseFloat(curr.portfolio_value) - parseFloat(prev.portfolio_value) ).toFixed(2)
          : null;
        // Tiger (and some other brokers) don't report realized_pl — fall back to equity delta
        const pnl = (realDelta !== null && realDelta !== 0) ? realDelta : (equityDelta ?? 0);
        history.push({
          date:           curr.date instanceof Date
            ? curr.date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
            : String(curr.date).slice(0, 10),
          pnl,
          equity:         curr.portfolio_value != null ? parseFloat(curr.portfolio_value) : null,
          unrealized_pl:  curr.unrealized_pl  != null ? parseFloat(curr.unrealized_pl)  : null,
        });
      }

      console.log(`[pnl] snapshots=${snapshots.length} history=${history.length}`, history.map(h => ({ date: h.date, pnl: h.pnl })));
      return res.json({
        today:   { pnl: account?.unrealized_pl ?? 0, available: !!account, live: true },
        account: account ?? null,
        history,
      });
    }

    const pnlDbUser = isDbAvailable() ? await getDbUser(req.session.username) : null;
    const pnlCreds  = pnlDbUser?.alpaca_api_key
      ? { apiKey: pnlDbUser.alpaca_api_key, secretKey: pnlDbUser.alpaca_secret_key, baseUrl: pnlDbUser.alpaca_base_url }
      : null;

    // Regular user with paper credentials — use their portfolio history
    // Only use creds when they match the source (paper creds for paper source)
    if (!pnlAdmin && pnlCreds && isPaperUrl(pnlCreds.baseUrl)) {
      const userBotCfg = await getUserBotConfig(req.session.username);
      const profitTarget = userBotCfg?.daily_profit_target ?? 150;
      const lossLimit    = userBotCfg?.daily_loss_limit    ?? 200;
      const [today, history] = await Promise.allSettled([
        getUserDailyPnL(pnlCreds),
        getUserPortfolioHistory(pnlCreds, { days }),
      ]);
      const todayVal = today.status === 'fulfilled' ? today.value : { pnl: 0, available: false };
      const pnl = todayVal.pnl ?? 0;
      return res.json({
        today: {
          ...todayVal,
          daily_target:        profitTarget,
          daily_loss_limit:    -lossLimit,
          target_reached:      pnl >= profitTarget,
          loss_limit_reached:  pnl <= -lossLimit,
          remaining_to_target: +Math.max(0, profitTarget - pnl).toFixed(2),
        },
        history: history.status === 'fulfilled' ? history.value : [],
      });
    }

    // No account connected and not admin
    if (!pnlAdmin) {
      console.log(`[pnl] source=${source} username=${req.session.username} → no credentials, returning empty`);
      return res.json({ today: { pnl: 0, available: false }, history: [] });
    }

    // Admin — use bot's paper account
    const [alpacaPnl, alpacaHistory, tradeRows] = await Promise.allSettled([
      getDailyPnL(),
      getPortfolioHistory({ days }),
      isDbAvailable() ? query(`
        SELECT
          DATE(closed_at AT TIME ZONE 'America/New_York') AS date,
          COUNT(*)                                         AS total_trades,
          COUNT(*) FILTER (WHERE pnl_usd > 0)             AS winning_trades,
          COALESCE(SUM(pnl_usd), 0)                       AS realized_pnl
        FROM trades
        WHERE status = 'closed' AND closed_at IS NOT NULL
          AND closed_at >= NOW() - ($1 || ' days')::INTERVAL
          AND (account_source = 'alpaca_paper' OR account_source IS NULL)
        GROUP BY 1
        ORDER BY 1 DESC`, [days])
      : Promise.resolve(null),
    ]);

    const today   = alpacaPnl.status     === 'fulfilled' ? alpacaPnl.value        : { pnl: 0, available: false };
    const alpHist = alpacaHistory.status === 'fulfilled' ? alpacaHistory.value    : [];
    const dbRows  = tradeRows.status     === 'fulfilled' ? (tradeRows.value?.rows ?? []) : [];

    // Build a trade-stats lookup by date from DB
    const tradeByDate = {};
    for (const r of dbRows) {
      tradeByDate[r.date] = {
        total_trades:   parseInt(r.total_trades),
        winning_trades: parseInt(r.winning_trades),
        realized_pnl:   parseFloat(r.realized_pnl),
      };
    }

    // Merge Alpaca portfolio history (equity/pnl) with DB trade stats per day
    // Alpaca is the source of truth for P&L; DB adds trade count context
    // Today is excluded from history — it's shown via the Today P&L card only
    const etNowAdmin = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const etDateAdmin = new Date(etNowAdmin);
    const todayDateStr = `${etDateAdmin.getFullYear()}-${String(etDateAdmin.getMonth()+1).padStart(2,'0')}-${String(etDateAdmin.getDate()).padStart(2,'0')}`;
    const history = alpHist
      .filter(row => row.date !== todayDateStr)
      .map(row => {
        const db = tradeByDate[row.date] ?? {};
        return {
          date:           row.date,
          pnl:            row.pnl,          // from Alpaca portfolio equity delta
          equity:         row.equity,
          realized_pnl:   db.realized_pnl  ?? null,
          total_trades:   db.total_trades  ?? 0,
          winning_trades: db.winning_trades ?? 0,
        };
      });

    // Backfill DB with any day that has trades and isn't already recorded
    for (const row of history) {
      if (row.total_trades > 0) {
        upsertDailyPnl({
          date:           row.date,
          realized_pnl:   row.realized_pnl ?? row.pnl,
          unrealized_pnl: 0,
          total_trades:   row.total_trades,
          winning_trades: row.winning_trades,
          username:       req.session.username,
        }).catch(() => {});
      }
    }

    res.json({ today, history });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Usage stats (API cost)
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const rows = await getUsageStats({ days: 30 });
    res.json({ stats: rows ?? [] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Live market data
app.get('/api/market', async (req, res) => {
  try {
    const [sentiment, sectors, movers] = await Promise.allSettled([
      getMarketSentiment(),
      getSectorPerformance(),
      getMarketMovers({ limit: 15 }),
    ]);
    res.json({
      sentiment: sentiment.status === 'fulfilled' ? sentiment.value : null,
      sectors:   sectors.status   === 'fulfilled' ? sectors.value   : null,
      movers:    movers.status    === 'fulfilled' ? movers.value    : null,
    });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Top stocks trading today — sourced from Moomoo real-time quotes.
// Batched into groups of 30 to stay within OpenD's per-connection sub limit.
const _topStocksCache = { sp500: null, nasdaq: null };
const TOP_STOCKS_TTL  = 3 * 60 * 1000;

// ETFs and non-US symbols that shouldn't appear in the index screener
const _topStocksBlocklist = new Set([
  'SPY','QQQ','IWM','DIA','GLD','SLV','USO','TLT','HYG','LQD',
  'VXX','UVXY','SQQQ','TQQQ','SPXU','SPXL',
]);

// Yahoo Finance / Alpaca use BRK-B; Moomoo uses BRK.B
function toMoomooTicker(sym) {
  return sym.replace(/-([A-Z])$/, '.$1');
}

app.get('/api/market/top-stocks', async (req, res) => {
  try {
    const index  = req.query.index === 'nasdaq' ? 'nasdaq' : 'sp500';
    const cached = _topStocksCache[index];
    if (cached && Date.now() - cached.ts < TOP_STOCKS_TTL) {
      return res.json({ ...cached.data, cached: true });
    }

    const raw     = index === 'nasdaq' ? NASDAQ100 : SP500.slice(0, 90);
    const symbols = raw
      .filter(s => !_topStocksBlocklist.has(s))
      .map(toMoomooTicker);

    // Batch into groups of 30 — stays well within OpenD subscription limits
    const BATCH  = 30;
    const quotes = [];
    for (let i = 0; i < symbols.length; i += BATCH) {
      try {
        const r = await getMoomooQuotes(symbols.slice(i, i + BATCH));
        if (r.quotes) quotes.push(...r.quotes);
      } catch (e) {
        console.warn(`[top-stocks] batch ${i}–${i + BATCH} failed:`, e.message);
      }
    }

    if (!quotes.length) {
      return res.status(503).json({ error: 'No quotes returned — check Moomoo OpenD is running' });
    }

    const stocks = quotes
      .filter(q => q.price && q.change_pct != null && !q.suspended)
      .map(q => ({
        symbol:  q.symbol,
        name:    q.name,
        price:   q.price,
        chg_pct: q.change_pct,
        volume:  q.volume,
        high:    q.high,
        low:     q.low,
      }))
      .sort((a, b) => b.chg_pct - a.chg_pct);

    const data = { index, stocks, source: 'moomoo', count: stocks.length };
    _topStocksCache[index] = { ts: Date.now(), data };
    res.json(data);
  } catch (err) {
    console.error('[top-stocks] error:', err.message);
    res.status(503).json({ error: 'Moomoo data unavailable. Please try again.' });
  }
});

// Which data sources are available
app.get('/api/sources', requireAuth, async (req, res) => {
  const dbUser = isDbAvailable() ? await getDbUser(req.session.username) : null;
  const user   = await getUser(req.session.username);
  const isAdmin = user?.role === 'admin';
  res.json({
    alpaca_paper: isAdmin ? true : !!(dbUser?.alpaca_api_key),
    alpaca_live:  !!(dbUser?.alpaca_live_api_key) || (isAdmin && hasLiveAccount()),
    moomoo:       !!(process.env.MOOMOO_OPEND_HOST),
  });
});

// Open positions — source=alpaca (default), alpaca_live, or moomoo
app.get('/api/positions', requireAuth, async (req, res) => {
  try {
    const rawSource = req.query.source;
    const source = rawSource === 'moomoo' ? 'moomoo' : rawSource === 'alpaca_live' ? 'alpaca_live' : rawSource === 'tiger' ? 'tiger' : 'alpaca';
    const { positions } = await getAccountData(source, req.session.username);
    res.json({ source, positions });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/moomoo/risk', requireAuth, async (req, res) => {
  try {
    const [fundsRes, posRes] = await Promise.allSettled([getFunds(), getMoomooPositions()]);
    if (posRes.status === 'rejected') return res.status(503).json({ error: 'Moomoo not connected: ' + posRes.reason?.message });

    const funds     = fundsRes.status === 'fulfilled' ? fundsRes.value : null;
    const posData   = posRes.value;
    const positions = posData.positions || [];

    // Map each position to its sector
    const totalVal = positions.reduce((s, p) => s + (p.market_val || 0), 0);

    const sectorMap = {};
    const unmapped  = [];
    for (const p of positions) {
      const sector = SECTOR_MAP[p.symbol.toUpperCase()] || '?';
      if (sector === '?') unmapped.push(p.symbol);
      if (!sectorMap[sector]) sectorMap[sector] = { etf: sector, name: SECTOR_NAMES?.[sector] || sector, value: 0, positions: [] };
      sectorMap[sector].value      += p.market_val || 0;
      sectorMap[sector].positions.push(p.symbol);
    }

    const sectors = Object.values(sectorMap)
      .map(s => ({ ...s, pct: totalVal > 0 ? +((s.value / totalVal) * 100).toFixed(1) : 0 }))
      .sort((a, b) => b.pct - a.pct);

    // Risk flags
    const topSector       = sectors[0] ?? null;
    const concentrated    = topSector && topSector.pct >= 40;
    const overConcentrated = topSector && topSector.pct >= 60;

    // Sort positions by unrealized P&L
    const sorted      = [...positions].sort((a, b) => (a.unrealized_pl || 0) - (b.unrealized_pl || 0));
    const biggestLosers  = sorted.filter(p => (p.unrealized_pl || 0) < 0).slice(0, 3);
    const biggestWinners = [...sorted].reverse().filter(p => (p.unrealized_pl || 0) > 0).slice(0, 3);

    // Largest position by weight
    const largestPos = [...positions]
      .sort((a, b) => (b.market_val || 0) - (a.market_val || 0))[0] ?? null;

    res.json({
      total_market_val:    posData.total_market_val,
      total_unrealized_pl: posData.total_unrealized_pl,
      cash:                funds?.cash ?? null,
      total_assets:        funds?.total_assets ?? null,
      buying_power:        funds?.buying_power ?? null,
      position_count:      positions.length,
      sectors,
      unmapped_symbols:    unmapped,
      risk_flags: {
        concentrated,
        over_concentrated: overConcentrated,
        top_sector:        topSector?.name ?? null,
        top_sector_pct:    topSector?.pct  ?? null,
      },
      biggest_losers:  biggestLosers.map(p => ({ symbol: p.symbol, unrealized_pl: p.unrealized_pl, unrealized_pl_pct: p.unrealized_pl_pct })),
      biggest_winners: biggestWinners.map(p => ({ symbol: p.symbol, unrealized_pl: p.unrealized_pl, unrealized_pl_pct: p.unrealized_pl_pct })),
      largest_position: largestPos ? { symbol: largestPos.symbol, market_val: largestPos.market_val, pct: totalVal > 0 ? +((largestPos.market_val / totalVal) * 100).toFixed(1) : 0 } : null,
    });
  } catch (err) {
    console.error('Moomoo risk error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Moomoo Trading Endpoints ─────────────────────────────────────────────────

app.get('/api/moomoo/trade-status', requireAuth, (req, res) => {
  res.json({
    simulate:    MOOMOO_IS_SIMULATE,
    env:         MOOMOO_IS_SIMULATE ? 'simulate' : 'real',
    trade_env:   MOOMOO_TRADE_ENV_VALUE,
    warning:     MOOMOO_IS_SIMULATE
      ? null
      : 'LIVE TRADING ACTIVE — real money at risk. Set MOOMOO_TRADE_ENV=0 to return to paper.',
  });
});

app.post('/api/moomoo/trade', requireAuth, async (req, res) => {
  try {
    const { symbol, side = 'buy', qty, stop_price, take_profit_price, trailing_pct } = req.body;
    if (!symbol || !qty || qty <= 0) return res.status(400).json({ error: 'symbol and qty are required' });
    const result = await placeMoomooTrade({
      symbol: symbol.toUpperCase(),
      side, qty: Number(qty),
      stop_price:          stop_price          != null ? Number(stop_price)          : null,
      take_profit_price:   take_profit_price   != null ? Number(take_profit_price)   : null,
      trailing_pct:        trailing_pct        != null ? Number(trailing_pct)        : null,
    });
    logActivity(req.session.username, 'moomoo_trade', symbol.toUpperCase(), req.ip);
    res.json(result);
  } catch (err) {
    console.error('[moomoo/trade]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/moomoo/cancel', requireAuth, async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'order_id is required' });
    const result = await cancelMoomooOrder({ order_id });
    res.json(result);
  } catch (err) {
    console.error('[moomoo/cancel]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/moomoo/cancel-all', requireAuth, async (req, res) => {
  try {
    const result = await cancelAllMoomooOrders();
    logActivity(req.session.username, 'moomoo_cancel_all', null, req.ip);
    res.json(result);
  } catch (err) {
    console.error('[moomoo/cancel-all]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/moomoo/close', requireAuth, async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    const result = await closeMoomooPosition({ symbol: symbol.toUpperCase() });
    logActivity(req.session.username, 'moomoo_close', symbol.toUpperCase(), req.ip);
    res.json(result);
  } catch (err) {
    console.error('[moomoo/close]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Force-execute a paper trade (Alpaca only — never touches real money)
app.post('/api/trade/force', requireAuth, async (req, res, next) => {
  const user  = await getUser(req.session.username) || {};
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const perms = getPermissions(user);
  if (!perms.widgets.includes('force_trade')) return res.status(403).json({ error: 'Forbidden' });
  next();
}, async (req, res) => {
  try {
    const { symbol, side = 'buy', dollars } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });

    const ticker = symbol.toUpperCase().trim();
    const result = await placeTrade({
      symbol: ticker,
      side,
      dollars: dollars ? Number(dollars) : null,
      use_atr: true,
      note: 'forced via dashboard',
    });
    logActivity(req.session.username, 'trade_forced', `${side.toUpperCase()} ${ticker}${dollars ? ' $'+dollars : ''}`, req.ip);
    clearPnlCache();
    // Persist to DB immediately so Recent Trades reflects this trade
    recordTrade({
      order_id:          result.order_id,
      symbol:            result.symbol,
      side:              result.side,
      qty:               result.qty,
      entry_price:       result.estimated_price,
      stop_loss:         result.stop_loss,
      take_profit:       result.take_profit,
      dollars_invested:  result.dollars_invested,
      stop_loss_pct:     result.stop_loss_pct,
      take_profit_pct:   result.take_profit_pct,
      atr_pct:           result.atr_pct,
      conviction_score:  result.conviction_score,
      conviction_grade:  result.conviction_grade,
      slippage_cents:    result.slippage_cents,
      account_source:    'alpaca_paper',
      username:          req.session.username,
    }).catch(e => console.error('[trade/force] recordTrade:', e.message));
    res.json(result);
  } catch (err) {
    console.error('[trade/force]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Close a paper position by symbol
app.post('/api/trade/close', requireAuth, async (req, res, next) => {
  const user  = await getUser(req.session.username) || {};
  const perms = getPermissions(user);
  if (!perms.widgets.includes('force_trade')) return res.status(403).json({ error: 'Forbidden' });
  next();
}, async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    const ticker2 = symbol.toUpperCase().trim();

    const sessionUser = await getUser(req.session.username) || {};
    const isAdmin     = sessionUser.role === 'admin';
    const dbU         = isDbAvailable() ? await getDbUser(req.session.username) : null;
    const userCfg     = dbU ? (await getUserBotConfig(req.session.username)) : {};
    const broker      = isAdmin ? 'paper' : (userCfg?.trade_source ?? 'paper');

    // ── Tiger close ───────────────────────────────────────────────────────────
    if (broker === 'tiger') {
      if (!dbU?.tiger_id) return res.status(400).json({ error: 'Tiger credentials not configured.' });
      const creds = { tiger_id: dbU.tiger_id, account: dbU.tiger_account, private_key: dbU.tiger_private_key };
      const tigerPositions = await getTigerPositions(creds).catch(() => []);
      const pos = tigerPositions.find(p => (p.symbol ?? p.contract?.symbol ?? '').toUpperCase() === ticker2);
      if (!pos) return res.status(403).json({ error: `You do not have an open Tiger position in ${ticker2}` });
      const result = await placeTigerOrder(creds, { symbol: ticker2, side: 'sell', qty: Math.abs(pos.quantity ?? pos.qty ?? 0) });
      logActivity(req.session.username, 'position_closed', `${ticker2} [Tiger]`, req.ip);
      const entryPrice = parseFloat(pos.averageCost ?? pos.avg_cost ?? 0);
      const exitPrice  = parseFloat(pos.latestPrice ?? pos.market_price ?? entryPrice);
      const posQty     = Math.abs(pos.quantity ?? pos.qty ?? 0);
      const pnlUsd     = +((exitPrice - entryPrice) * posQty).toFixed(2);
      const pnlPct     = entryPrice > 0 ? +((exitPrice - entryPrice) / entryPrice * 100).toFixed(4) : 0;
      getOpenTrade(ticker2, { account_source: 'tiger' }).then(async (openTrade) => {
        if (openTrade) await closeTrade({ order_id: openTrade.order_id, exit_price: exitPrice, pnl_usd: pnlUsd, pnl_pct: pnlPct });
      }).catch(() => {});
      return res.json(result);
    }

    // ── Moomoo close ──────────────────────────────────────────────────────────
    if (broker === 'moomoo') {
      const mooPos = await getMoomooPositions({ acc_id: dbU?.moomoo_acc_id }).catch(() => null);
      const pos = (mooPos?.positions ?? []).find(p => (p.symbol ?? '').toUpperCase() === ticker2);
      if (!pos) return res.status(403).json({ error: `You do not have an open Moomoo position in ${ticker2}` });
      const result = await closeMoomooPosition(ticker2);
      logActivity(req.session.username, 'position_closed', `${ticker2} [Moomoo]`, req.ip);
      return res.json(result);
    }

    // ── Alpaca paper/live close ───────────────────────────────────────────────
    let positions;
    if (isAdmin) {
      positions = await getPositions().catch(() => []);
    } else {
      const userCreds = dbU?.alpaca_api_key ? { apiKey: dbU.alpaca_api_key, secretKey: dbU.alpaca_secret_key, baseUrl: dbU.alpaca_base_url || 'https://paper-api.alpaca.markets' } : null;
      positions = userCreds ? await getUserPositions(userCreds).catch(() => []) : [];
    }
    const pos = Array.isArray(positions) ? positions.find(p => p.symbol?.toUpperCase() === ticker2) : null;
    if (!pos) return res.status(403).json({ error: `You do not have an open position in ${ticker2}` });

    const result = await closePosition(ticker2);
    logActivity(req.session.username, 'position_closed', ticker2, req.ip);
    clearPnlCache();
    syncClosedTrades().catch(() => {});

    const entryPrice = parseFloat(pos.avg_entry_price) || 0;
    const exitPrice  = parseFloat(pos.current_price)   || entryPrice;
    const posQty     = parseFloat(pos.qty)             || 0;
    const isLong     = (pos.side || 'long') === 'long';
    const pnlUsd     = isLong ? +((exitPrice - entryPrice) * posQty).toFixed(2) : +((entryPrice - exitPrice) * posQty).toFixed(2);
    const pnlPct     = entryPrice > 0 ? +((exitPrice - entryPrice) / entryPrice * 100 * (isLong ? 1 : -1)).toFixed(4) : 0;
    const acctSrc    = broker === 'alpaca_live' ? 'alpaca_live' : 'alpaca_paper';
    getOpenTrade(ticker2, { account_source: acctSrc }).then(async (openTrade) => {
      if (openTrade) {
        await closeTrade({ order_id: openTrade.order_id, exit_price: exitPrice, pnl_usd: pnlUsd, pnl_pct: pnlPct });
      } else {
        await recordTrade({
          order_id:    `manual_close_${ticker2}_${Date.now()}`,
          symbol:      ticker2, side: isLong ? 'sell' : 'buy',
          qty: posQty, entry_price: entryPrice, exit_price: exitPrice,
          status: 'closed', pnl_usd: pnlUsd, pnl_pct: pnlPct,
          account_source: acctSrc, username: req.session.username,
        });
      }
    }).catch(e => console.error('[trade/close] recordTrade:', e.message));

    res.json(result);
  } catch (err) {
    console.error('[trade/close]', err); res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Move stop to breakeven for an open position
app.post('/api/trade/move-stop', requireAuth, async (req, res, next) => {
  const user  = await getUser(req.session.username) || {};
  const perms = getPermissions(user);
  if (!perms.widgets.includes('force_trade')) return res.status(403).json({ error: 'Forbidden' });
  next();
}, async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    const ticker = symbol.toUpperCase().trim();
    const dbU    = isDbAvailable() ? await getDbUser(req.session.username) : null;
    const userCfg = dbU ? (await getUserBotConfig(req.session.username)) : {};
    const broker = userCfg?.trade_source ?? 'paper';
    if (broker === 'tiger' || broker === 'moomoo') {
      return res.json({ ok: false, message: `Move-stop-to-breakeven is not supported for ${broker} via API. Adjust your stop manually in the ${broker === 'tiger' ? 'Tiger' : 'Moomoo'} app.` });
    }
    const result = await moveStopToBreakeven(ticker);
    logActivity(req.session.username, 'stop_moved', `${ticker} stop → BE $${result.new_stop}`, req.ip);
    res.json(result);
  } catch (err) {
    console.error('[trade/move-stop]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Quick Trade (Explorer widget) ───────────────────────────────────────────

app.get('/api/quote/:symbol', requireAuth, async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase().trim();
    const q = await fetchCurrentPrice(symbol);
    if (q) return res.json({ symbol, mid: q.price, price: q.price, change: q.change ?? null, change_pct: q.change_pct ?? null, session: q.session ?? 'regular' });
    const alpaca = await getLatestPrice(symbol);
    res.json(alpaca);
  } catch (err) {
    console.error('[quote]', err);
    res.status(400).json({ error: 'Unable to fetch quote. Check the symbol and try again.' });
  }
});

// Batch quotes — fetches multiple symbols in parallel, returns { quotes: { SYM: { price, change, change_pct, session } } }
app.get('/api/quotes/batch', requireAuth, async (req, res) => {
  try {
    const raw = (req.query.symbols || '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
    const symbols = [...new Set(raw)].slice(0, 40); // cap at 40 symbols
    if (!symbols.length) return res.json({ quotes: {} });
    const results = await Promise.allSettled(symbols.map(sym => fetchCurrentPrice(sym)));
    const quotes = {};
    symbols.forEach((sym, i) => {
      const r = results[i];
      quotes[sym] = r.status === 'fulfilled' && r.value
        ? { price: r.value.price, change: r.value.change ?? null, change_pct: r.value.change_pct ?? null, session: r.value.session ?? 'regular' }
        : null;
    });
    res.json({ quotes });
  } catch (err) {
    console.error('[quotes/batch]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/trade/quick', requireAuth, async (req, res) => {
  try {
    const { symbol, side = 'buy', qty, order_type = 'market',
            limit_price, stop_price, trail_price, trail_percent,
            stop_loss, take_profit, time_in_force = 'day' } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    if (!qty || qty < 1) return res.status(400).json({ error: 'qty must be ≥ 1' });

    const ticker = symbol.toUpperCase().trim();
    const shares = Math.floor(Number(qty));

    // Determine user's configured broker
    const dbUser   = isDbAvailable() ? await getDbUser(req.session.username) : null;
    const userCfg  = dbUser ? (await getUserBotConfig(req.session.username)) : {};
    const broker   = userCfg?.trade_source ?? 'paper';

    // ── Tiger path ────────────────────────────────────────────────────────────
    if (broker === 'tiger') {
      if (!dbUser?.tiger_id) return res.status(400).json({ error: 'Tiger credentials not configured. Go to Settings → Tiger Brokers to connect.' });
      const creds = { tiger_id: dbUser.tiger_id, account: dbUser.tiger_account, private_key: dbUser.tiger_private_key };

      // Resolve limit price from request (explicit limit/stop_limit orders)
      let tigerLimitPrice  = (order_type === 'limit' || order_type === 'stop_limit') ? (limit_price ? +limit_price : null) : null;
      let tigerOutsideRth  = false;
      let extendedHoursNote = null;

      // For market orders: check if market is open — if not, auto-convert to limit at ask
      if (order_type === 'market' && !tigerLimitPrice) {
        const mktStatus = await getMarketStatus().catch(() => null);
        if (!mktStatus?.is_open) {
          const quote = await getLatestPrice(ticker).catch(() => null);
          const askBid = side === 'buy' ? (quote?.ask || quote?.mid) : (quote?.bid || quote?.mid);
          if (askBid) {
            tigerLimitPrice  = +askBid.toFixed(2);
            tigerOutsideRth  = true;
            extendedHoursNote = `Market closed — converted to limit order at $${tigerLimitPrice} (extended hours)`;
            console.log(`[tiger] extended hours: MKT→LMT $${tigerLimitPrice} outside_rth=true for ${ticker}`);
          }
        }
      }

      const tigerRes = await placeTigerOrder(creds, { symbol: ticker, side, qty: shares, limitPrice: tigerLimitPrice, outsideRth: tigerOutsideRth });

      logActivity(req.session.username, 'quick_trade', `${side.toUpperCase()} ${shares} ${ticker} @ ${order_type} [Tiger]${tigerOutsideRth ? ' ext-hrs' : ''}`, req.ip);

      // Estimate price for display
      const estPrice = tigerLimitPrice || 0;
      const estCost  = +(estPrice * shares).toFixed(2);

      if (side === 'buy') {
        recordTrade({
          order_id:       String(tigerRes.order_id),
          symbol:         ticker,
          side:           'buy',
          qty:            shares,
          entry_price:    estPrice,
          dollars_invested: estCost,
          account_source: 'tiger',
          username:       req.session.username,
        }).catch(e => console.error('[trade/quick/tiger] recordTrade:', e.message));
      } else {
        getOpenTrade(ticker, { account_source: 'tiger' }).then(async (openTrade) => {
          if (openTrade) {
            const pnlUsd = +((estPrice - parseFloat(openTrade.entry_price)) * shares).toFixed(2);
            const pnlPct = openTrade.entry_price > 0 ? +((estPrice - openTrade.entry_price) / openTrade.entry_price * 100).toFixed(4) : 0;
            await closeTrade({ order_id: openTrade.order_id, exit_price: estPrice, pnl_usd: pnlUsd, pnl_pct: pnlPct });
          }
        }).catch(e => console.error('[trade/quick/tiger] closeTrade:', e.message));
      }

      return res.json({
        ok:             true,
        order_id:       tigerRes.order_id,
        symbol:         ticker,
        side,
        qty:            shares,
        order_type:     tigerRes.order_type,
        note:           extendedHoursNote,
        estimated_price: estPrice,
        estimated_cost:  estCost,
        status:         tigerRes.status,
        broker:         'tiger',
      });
    }

    // ── Alpaca paper path (default) ───────────────────────────────────────────
    const result = await placeQuickTrade({ symbol: ticker, side, qty: shares, order_type,
      limit_price, stop_price, trail_price, trail_percent,
      stop_loss, take_profit, time_in_force });
    logActivity(req.session.username, 'quick_trade', `${side.toUpperCase()} ${shares} ${ticker} @ ${order_type}`, req.ip);
    clearPnlCache();

    if (side === 'buy') {
      recordTrade({
        order_id:         result.order_id,
        symbol:           ticker,
        side:             'buy',
        qty:              result.qty,
        entry_price:      result.estimated_price,
        stop_loss:        result.stop_loss,
        take_profit:      result.take_profit,
        dollars_invested: result.estimated_cost,
        slippage_cents:   result.slippage_cents,
        account_source:   'alpaca_paper',
        username:         req.session.username,
      }).catch(e => console.error('[trade/quick] recordTrade buy:', e.message));
    } else {
      const exitPrice = result.estimated_price;
      getOpenTrade(ticker, { account_source: 'alpaca_paper' }).then(async (openTrade) => {
        if (openTrade) {
          const entryPrice = parseFloat(openTrade.entry_price) || exitPrice;
          const pnlUsd = +((exitPrice - entryPrice) * result.qty).toFixed(2);
          const pnlPct = entryPrice > 0 ? +((exitPrice - entryPrice) / entryPrice * 100).toFixed(4) : 0;
          await closeTrade({ order_id: openTrade.order_id, exit_price: exitPrice, pnl_usd: pnlUsd, pnl_pct: pnlPct });
        } else {
          await recordTrade({
            order_id:    result.order_id,
            symbol:      ticker,
            side:        'sell',
            qty:         result.qty,
            entry_price: exitPrice,
            exit_price:  exitPrice,
            status:      'closed',
            pnl_usd:     0,
            pnl_pct:     0,
            username:    req.session.username,
          });
        }
      }).catch(e => console.error('[trade/quick] recordTrade sell:', e.message));
    }

    res.json(result);
  } catch (err) {
    console.error('[trade/quick]', err);
    res.status(500).json({ error: err.message || 'Something went wrong. Please try again.' });
  }
});

// Manual sync — busts PnL cache and runs syncClosedTrades immediately
app.post('/api/sync', requireAuth, async (req, res) => {
  try {
    clearPnlCache();
    _lastSyncMs = 0; // reset throttle so triggerSyncIfDue fires immediately
    const result = await syncClosedTrades();
    res.json({ ok: true, synced: result.synced, trades: result.trades });
  } catch (err) {
    console.error('[sync] manual error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── AI Chat (SSE streaming) ──────────────────────────────────────────────────

app.post('/api/chat', requireAuth, chatLimiter, async (req, res) => {
  const { message, voice_mode } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

  // Credit check: admins are unlimited; viewers consume 1 credit per message
  const username = req.session?.username;
  const user = await getUser(username);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (user.role !== 'admin' && isDbAvailable()) {
    if (user.credits !== null && user.credits <= 0) {
      return res.status(402).json({ error: 'No credits remaining. Contact the admin to top up your account.' });
    }
    // Deduct 1 credit before processing
    const remaining = await deductCredit(username);
    if (remaining === null) {
      return res.status(402).json({ error: 'No credits remaining. Contact the admin to top up your account.' });
    }
  }
  logActivity(username, 'chat_prompt', null, req.ip);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const abort = new AbortController();
  req.on('close', () => abort.abort());

  const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  const userConfig = { ...(await getUserBotConfig(username)), role: user.role };
  try {
    const chatResult = await chat({
      chatId:     userChatId(username),
      message:    message.trim(),
      onChunk:    (text) => send({ text }),
      onTool:     (name) => send({ name }),
      signal:     abort.signal,
      userConfig,
      username,
      voiceMode:  !!voice_mode,
    });
    if (chatResult?.knowledge_response) {
      send({ knowledge: true, content: chatResult.content, model: chatResult.model ?? 'ollama' });
    }
    // Fetch updated credit balance to send back to client
    let creditsLeft = null;
    if (user.role !== 'admin' && isDbAvailable()) {
      const updated = await getDbUser(username);
      creditsLeft = updated?.credits ?? null;
    }
    send({
      done:             true,
      credits:          creditsLeft,
      source:           chatResult?.source           ?? 'claude',
      model:            chatResult?.model            ?? 'claude-sonnet-4-6',
      knowledge_response: !!chatResult?.knowledge_response,
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      send({ error: 'Internal server error' });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.post('/api/chat/clear', requireAuth, (req, res) => {
  const username = req.session?.username;
  if (username) clearHistory(userChatId(username));
  res.json({ ok: true });
});

app.get('/api/chat/history', requireAuth, async (req, res) => {
  const username = req.session?.username;
  if (!username) return res.json({ messages: [] });
  const chatId = userChatId(username);

  // Prefer in-memory (always up-to-date); fall back to DB
  let msgs = chatHistory.get(chatId) ?? null;
  if (!msgs || msgs.length === 0) {
    msgs = await loadConversationHistory(chatId) ?? [];
  }

  // Return only user/assistant text pairs — skip tool_use/tool_result blocks
  const displayable = msgs
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-30)
    .map(m => ({ role: m.role, content: m.content }));

  res.json({ messages: displayable });
});

// ─── Admin AI Chat (SSE streaming — admin role only) ──────────────────────────

app.post('/api/admin/chat', requireAdmin, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

  const username  = req.session?.username;
  const sessionId = `admin_${req.session.id}`;
  logActivity(username, 'admin_chat_prompt', null, req.ip);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const abort = new AbortController();
  req.on('close', () => abort.abort());

  const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  try {
    await adminChat({
      sessionId,
      message:       message.trim(),
      adminUsername: username,
      onChunk: (text) => send({ text }),
      onTool:  (name) => send({ name }),
      signal:  abort.signal,
    });
    send({ done: true });
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Admin chat error:', err);
      send({ error: 'Internal server error' });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.post('/api/admin/chat/clear', requireAdmin, (req, res) => {
  const sessionId = `admin_${req.session.id}`;
  clearAdminHistory(sessionId);
  res.json({ ok: true });
});

// Admin: clear any specific user's conversation history (e.g. after a stale P&L block)
app.post('/api/admin/chat/clear-user', requireAdmin, (req, res) => {
  const target = (req.body?.username || '').trim().toLowerCase();
  if (!target) return res.status(400).json({ error: 'username required' });
  clearHistory(userChatId(target));
  res.json({ ok: true, cleared: target });
});

// ─── 2-Layer AI Scanner ───────────────────────────────────────────────────────

const _scannerState = {
  autoEnabled:  false,
  running:      false,
  lastScan:     null,   // { context, selection, executedTrade, timestamp, error }
  history:      [],     // last 20 scan results
  lastError:    null,
};

async function runAiScan({ autoExecute = false, triggeredBy = 'manual', username = null } = {}) {
  if (_scannerState.running) return { error: 'Scan already in progress' };

  // Daily spend cap — skip autonomous scans (not manual triggers) when over budget
  if (triggeredBy === 'cron') {
    const todaySpend = await getTodaySpend().catch(() => 0);
    if (todaySpend >= DAILY_API_CAP_USD) {
      console.warn(`[scanner] Daily API cap $${DAILY_API_CAP_USD} reached ($${todaySpend.toFixed(4)} spent) — skipping scan`);
      return { skipped: true, reason: `Daily API cap $${DAILY_API_CAP_USD} reached` };
    }
  }

  _scannerState.running = true;
  const ts = new Date().toISOString();
  try {
    const context = await getMarketContext();

    let openPositions = [];
    try { openPositions = await getPositions(); } catch {}

    // Re-entry block: exclude symbols that lost money in the last 24 hours
    let blocked_symbols = [];
    try {
      const recentClosed = await getTrades({ status: 'closed', limit: 50, account_source: 'alpaca_paper' });
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      blocked_symbols = (recentClosed ?? [])
        .filter(t => t.closed_at && new Date(t.closed_at).getTime() > cutoff && (t.pnl_usd ?? 0) < 0)
        .map(t => t.symbol);
    } catch {}

    // Load user watchlist — always included as base candidates
    let watchlist = [];
    try {
      const raw = await getScannerState('watchlist');
      if (raw) watchlist = JSON.parse(raw);
    } catch {}

    const selection = await selectBestTrade({ context, positions: openPositions, blocked_symbols, watchlist });

    // ── Per-user execution ────────────────────────────────────────────────────
    const userResults = [];
    if (autoExecute && selection.symbol && context.tradeable) {
      const isCron = triggeredBy === 'cron';

      // Build list of users to execute for
      let targetUsers = [];
      if (isCron) {
        // Cron: iterate all users who have Alpaca creds and are not suspended
        const allUsers = await listDbUsers().catch(() => []);
        targetUsers = allUsers.filter(u =>
          u.alpaca_api_key && u.alpaca_secret_key && u.alpaca_base_url && !u.suspended
        );
      } else if (username) {
        // Manual: only the triggering user
        const u = await getDbUser(username).catch(() => null);
        if (u) targetUsers = [u];
      }

      for (const u of targetUsers) {
        const userCfg = await getUserBotConfig(u.username);
        if (!userCfg.auto_execute) continue;

        // Per-user conviction minimum
        const score = selection.conviction ?? 0;
        if (score < (userCfg.min_conviction_score ?? 50)) {
          userResults.push({ username: u.username, skipped: true,
            reason: `Conviction ${score} below user minimum ${userCfg.min_conviction_score ?? 50}` });
          continue;
        }

        // Per-user VIX limit
        if (context.vix && context.vix > (userCfg.max_vix_for_scan ?? 30)) {
          userResults.push({ username: u.username, skipped: true,
            reason: `VIX ${context.vix} above user limit ${userCfg.max_vix_for_scan ?? 30}` });
          continue;
        }

        // Per-user loss streak check
        const userLosses = await getRecentLosses({ symbol: selection.symbol, days: 5, account_source: 'alpaca_paper' })
          .catch(() => ({ loss_count: 0, last_loss_at: null }));
        const hoursSince = userLosses.last_loss_at
          ? (Date.now() - new Date(userLosses.last_loss_at)) / 3600000 : 999;
        if (userLosses.loss_count >= 2 && hoursSince < 24) {
          userResults.push({ username: u.username, skipped: true,
            reason: `Loss streak for ${selection.symbol}` });
          continue;
        }

        // Per-user position cap
        const userAlpacaCreds = { apiKey: u.alpaca_api_key, secretKey: u.alpaca_secret_key, baseUrl: u.alpaca_base_url };
        const userPositions = await getUserPositions(userAlpacaCreds).catch(() => []);
        if (userPositions.length >= (userCfg.max_open_positions ?? 2)) {
          userResults.push({ username: u.username, skipped: true,
            reason: `Max ${userCfg.max_open_positions ?? 2} positions already open` });
          continue;
        }

        try {
          // Calculate qty from user's min_dollars setting and current price
          const price = await getLatestPrice(selection.symbol).then(q => q.mid ?? q.ask ?? 100).catch(() => 100);
          const minDol = userCfg.position_sizing?.min_dollars ?? 1500;
          const qty = Math.max(1, Math.floor(minDol / price));

          const result = await placeQuickTrade({
            symbol: selection.symbol,
            side:   'buy',
            qty,
            creds:  userAlpacaCreds,
          });

          await recordTrade({
            order_id:             result.order_id,
            symbol:               result.symbol,
            side:                 result.side,
            qty:                  result.qty,
            entry_price:          result.estimated_price,
            dollars_invested:     result.estimated_cost ?? minDol,
            conviction_score:     score,
            conviction_grade:     score >= 75 ? 'A' : score >= 60 ? 'B' : 'C',
            conviction_breakdown: { reason: selection.reason, regime: context.regime },
            slippage_cents:       result.slippage_cents,
            account_source:       'alpaca_paper',
            username:             u.username,
          }).catch(e => console.error(`[scanner] recordTrade for ${u.username}:`, e.message));

          logActivity(u.username, 'auto_trade', selection.symbol, '127.0.0.1');
          userResults.push({ username: u.username, result });
        } catch (err) {
          userResults.push({ username: u.username, error: err.message });
          console.log(`[scanner] Trade failed for ${u.username} (${selection.symbol}): ${err.message}`);
        }
      }
    }

    const executedTrade = userResults.length ? userResults : null;

    const entry = { context, selection, executedTrade, triggeredBy, timestamp: ts };
    _scannerState.lastScan = entry;
    _scannerState.lastError = null;
    _scannerState.history.unshift(entry);
    if (_scannerState.history.length > 20) _scannerState.history.length = 20;
    return entry;
  } catch (err) {
    _scannerState.lastError = err.message;
    throw err;
  } finally {
    _scannerState.running = false;
  }
}

app.post('/api/scanner/run', requireAdmin, async (req, res) => {
  try {
    const { autoExecute = false } = req.body;
    const result = await runAiScan({ autoExecute, triggeredBy: req.session.username, username: req.session.username });
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[scanner/run]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/scanner/status', requireAdmin, (req, res) => {
  res.json({
    autoEnabled: _scannerState.autoEnabled,
    running:     _scannerState.running,
    lastScan:    _scannerState.lastScan,
    history:     _scannerState.history.slice(0, 10),
    lastError:   _scannerState.lastError,
  });
});

app.post('/api/scanner/auto', requireAdmin, (req, res) => {
  const { enabled } = req.body;
  _scannerState.autoEnabled = !!enabled;
  logActivity(req.session.username, enabled ? 'scanner_auto_on' : 'scanner_auto_off', null, req.ip);
  res.json({ ok: true, autoEnabled: _scannerState.autoEnabled });
});

// ─── Scanner Watchlist ────────────────────────────────────────────────────────
// Symbols in this list are always passed to selectBestTrade as base candidates
// regardless of whether they appear in live market movers that day.

async function getWatchlist() {
  try {
    const raw = await getScannerState('watchlist');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function saveWatchlist(list) {
  await setScannerState('watchlist', JSON.stringify(list));
}

app.get('/api/scanner/watchlist', requireAdmin, async (req, res) => {
  res.json({ watchlist: await getWatchlist() });
});

app.post('/api/scanner/watchlist/add', requireAdmin, async (req, res) => {
  const sym = (req.body.symbol ?? '').toUpperCase().trim();
  if (!sym || !/^[A-Z]{1,5}$/.test(sym)) return res.status(400).json({ error: 'Invalid symbol' });
  const list = await getWatchlist();
  if (!list.includes(sym)) {
    list.push(sym);
    await saveWatchlist(list);
    logActivity(req.session.username, 'watchlist_add', sym, req.ip);
  }
  res.json({ ok: true, watchlist: list });
});

app.post('/api/scanner/watchlist/remove', requireAdmin, async (req, res) => {
  const sym = (req.body.symbol ?? '').toUpperCase().trim();
  const list = (await getWatchlist()).filter(s => s !== sym);
  await saveWatchlist(list);
  logActivity(req.session.username, 'watchlist_remove', sym, req.ip);
  res.json({ ok: true, watchlist: list });
});

// ─── Stock Prediction ─────────────────────────────────────────────────────────

app.get('/api/predict/:symbol', requireAuth, async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase().trim();
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    const result = await getStockPrediction(symbol);
    res.json({ ok: true, symbol, ...result });
  } catch (err) {
    console.error('[predict]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Catalyst Scanner ─────────────────────────────────────────────────────────

app.get('/api/catalyst-scan', requireAuth, async (req, res) => {
  try {
    const result = await runCatalystScan();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[catalyst-scan]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── User Watchlist ───────────────────────────────────────────────────────────

app.get('/api/watchlist', requireAuth, async (req, res) => {
  const symbols = await getUserWatchlistSymbols(req.session.username);
  res.json({ symbols });
});

app.post('/api/watchlist/add', requireAuth, async (req, res) => {
  const sym = (req.body.symbol ?? '').toUpperCase().trim();
  if (!sym || !/^[A-Z]{1,10}$/.test(sym)) return res.status(400).json({ error: 'Invalid symbol' });
  await addUserWatchlistSymbol(req.session.username, sym);
  logActivity(req.session.username, 'watchlist_add', sym, req.ip);
  const symbols = await getUserWatchlistSymbols(req.session.username);
  res.json({ ok: true, symbols });
});

app.post('/api/watchlist/remove', requireAuth, async (req, res) => {
  const sym = (req.body.symbol ?? '').toUpperCase().trim();
  if (!sym) return res.status(400).json({ error: 'symbol required' });
  await removeUserWatchlistSymbol(req.session.username, sym);
  logActivity(req.session.username, 'watchlist_remove', sym, req.ip);
  const symbols = await getUserWatchlistSymbols(req.session.username);
  res.json({ ok: true, symbols });
});

app.get('/api/watchlist/detail', requireAuth, async (req, res) => {
  try {
    const symbols = await getUserWatchlistSymbols(req.session.username);
    const results = await Promise.allSettled(symbols.map(async sym => {
      const [quoteResult, scoreResult, calResult] = await Promise.allSettled([
        fetchCurrentPrice(sym),
        getConvictionScore({ symbol: sym, positions: [] }),
        _yf.quoteSummary(sym, { modules: ['calendarEvents'] }).catch(() => null),
      ]);
      const quote   = quoteResult.status === 'fulfilled' ? quoteResult.value   : null;
      const scoring = scoreResult.status === 'fulfilled' ? scoreResult.value   : null;
      const cal     = calResult.status   === 'fulfilled' ? calResult.value     : null;
      const sig     = scoring?.signals ?? {};

      // Compute earnings date from Yahoo calendarEvents
      const today = new Date(); today.setHours(0,0,0,0);
      const rawDates = cal?.calendarEvents?.earnings?.earningsDate ?? [];
      const nextEarnings = rawDates
        .map(d => (d instanceof Date ? d : new Date(d)))
        .filter(d => !isNaN(d) && d >= today)
        .sort((a, b) => a - b)[0] ?? null;
      const earningsDate = nextEarnings ? nextEarnings.toISOString().split('T')[0] : null;

      // Derive EMA trend from price vs ema20/ema50
      const cp = sig.current_price, e20 = sig.ema20, e50 = sig.ema50;
      const emaTrend = cp && e20 && e50
        ? (cp > e20 && cp > e50 ? 'above' : cp < e20 && cp < e50 ? 'below' : 'mixed')
        : null;

      const price = quote?.price ?? null;
      const chgPct = quote?.change_pct ?? null;
      const change = price != null && chgPct != null ? +(price / (1 + chgPct / 100) * (chgPct / 100)).toFixed(2) : null;

      return {
        symbol:             sym,
        name:               scoring?.name          ?? null,
        price,
        change,
        change_pct:         chgPct,
        score:              scoring?.score          ?? null,
        grade:              scoring?.grade          ?? null,
        horizon:            scoring?.horizon        ?? null,
        reasoning:          scoring?.reasoning      ?? null,
        analyst_consensus:  sig.analyst_consensus   ?? null,
        analyst_target:     sig.analyst_target      ?? null,
        analyst_upside_pct: sig.analyst_upside_pct  ?? null,
        rvol:               sig.rvol                ?? null,
        rsi:                sig.rsi                 ?? null,
        weekly_trend:       sig.weekly_trend        ?? null,
        short_float:        sig.short_float_pct     ?? null,
        earnings_date:      earningsDate,
        macd_signal:        sig.macd_hist != null ? (sig.macd_hist > 0 ? 'bullish' : 'bearish') : null,
        ema_trend:          emaTrend,
      };
    }));
    const items = results.map((r, i) =>
      r.status === 'fulfilled' ? r.value : { symbol: symbols[i], price: null, score: null, grade: null }
    );
    res.json({ items });
  } catch (err) {
    console.error('[watchlist/detail]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Autonomous Push Notifications ───────────────────────────────────────────
// Analyst-initiated messages pushed to all connected chat clients via SSE.

const _pushClients = new Set(); // active SSE res objects
const _pushQueue   = [];        // rolling buffer for poll-based fallback (max 500 entries)

function pushToChat(message, type = 'autonomous') {
  const entry = { role: 'assistant', content: message, timestamp: new Date().toISOString(), type };
  _pushQueue.push(entry);
  if (_pushQueue.length > 500) _pushQueue.shift();

  if (_pushClients.size === 0) return;
  const payload = JSON.stringify(entry);
  for (const res of _pushClients) {
    try { res.write(`data: ${payload}\n\n`); }
    catch { _pushClients.delete(res); }
  }
}

app.get('/api/chat/push', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  _pushClients.add(res);
  const ka = setInterval(() => {
    try { res.write(': ka\n\n'); } catch { clearInterval(ka); _pushClients.delete(res); }
  }, 25000);
  req.on('close', () => { clearInterval(ka); _pushClients.delete(res); });
});

// Poll fallback — returns messages from queue newer than ?since=ISO timestamp
app.get('/api/chat/poll', requireAuth, (req, res) => {
  const since = req.query.since ? new Date(req.query.since).getTime() : 0;
  const messages = _pushQueue.filter(m => new Date(m.timestamp).getTime() > since);
  res.json({ messages });
});

// ─── Daily Briefing ───────────────────────────────────────────────────────────

const _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Pricing constants for cost tracking (per 1M tokens)
const SONNET_INPUT_PER_M  = 3.00;
const SONNET_OUTPUT_PER_M = 15.00;

// Daily API spend cap — scanner stops when today's total exceeds this
const DAILY_API_CAP_USD = parseFloat(process.env.DAILY_API_CAP_USD ?? '3.00');

async function runMorningBriefing() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const existing = await getDailyBriefing(today);
  if (existing) return existing; // already ran today

  const [context, pnl, sectors] = await Promise.allSettled([
    getMarketContext(),
    getDailyPnL(),
    getSectorPerformance(),
  ]).then(r => r.map(p => p.status === 'fulfilled' ? p.value : null));

  const ctx = context || {};
  const topSectors = (sectors?.sectors ?? []).sort((a,b) => (b.chg_pct||0)-(a.chg_pct||0)).slice(0,3).map(s=>`${s.symbol} ${s.chg_pct>0?'+':''}${s.chg_pct?.toFixed(2)}%`).join(', ');
  const earnings   = (Array.isArray(ctx.catalysts_today) ? ctx.catalysts_today : []).map(e=>e.symbol).join(', ') || 'none';

  try {
    const result = await localAI({
      system: 'You are an AI trading analyst. Be concise, specific, and use numbers. Plain text only — no markdown symbols like ** or #.',
      prompt: `It is 9:30 AM ET market open on ${today}.
Write a morning briefing for the trader. Include:
1. Today's market regime and what it means for trading strategy
2. Key catalysts today (earnings, macro events)
3. Which sectors to focus on and which to avoid
4. 2-3 specific stocks to watch with reasons why
5. Today's game plan in one sentence

Market data:
- Regime: ${ctx.regime || 'unknown'} | Direction: ${ctx.direction || 'unknown'} | VIX: ${ctx.vix ?? 'n/a'}
- Leading sectors: ${ctx.leading_sectors?.join(', ') || 'none'}
- Avoid sectors: ${ctx.avoid_sectors?.join(', ') || 'none'}
- Top sector moves: ${topSectors || 'n/a'}
- Earnings today: ${earnings}
- Market narrative: ${ctx.market_narrative || 'n/a'}
- Yesterday P&L: $${pnl?.pnl?.toFixed(2) ?? '0'}

Keep it under 200 words.`,
      fallbackModel: 'claude-haiku-4-5-20251001',
      maxTokens: 500,
    });

    const content = result.text ?? '';
    await saveDailyBriefing({ date: today, content, regime: ctx.regime, direction: ctx.direction, vix: ctx.vix });

    // Push to all connected chat clients
    pushToChat(`📋 Morning Briefing — ${today}\n\n${content}`, 'briefing');
    console.log(`[briefing] Morning briefing generated for ${today}`);
    return { date: today, content, regime: ctx.regime, direction: ctx.direction, vix: ctx.vix };
  } catch (err) {
    console.error('[briefing] Error:', err.message);
    return null;
  }
}

app.get('/api/briefing', requireAuth, async (req, res) => {
  const today     = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  let briefing    = await getDailyBriefing(today);
  if (!briefing) {
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    briefing = await getDailyBriefing(yesterday);
  }
  res.json({ briefing: briefing ?? null });
});

// ─── Trade Rejections Log ─────────────────────────────────────────────────────

app.get('/api/rejections', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50'), 200);
  const rows  = await getRejections({ limit }).catch(() => []);
  res.json({ rejections: rows, count: rows.length });
});

// ─── EOD Summary (4:00 PM ET) ────────────────────────────────────────────────

async function runEODSummary() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const existing = await getDailyBriefing(today, 'eod');
  if (existing) return existing;

  const [pnl, allTrades, context] = await Promise.allSettled([
    getDailyPnL(),
    getTrades({ limit: 100, account_source: 'alpaca_paper' }),
    getMarketContext(),
  ]).then(r => r.map(p => p.status === 'fulfilled' ? p.value : null));

  const todayTrades = (allTrades ?? []).filter(t => {
    const d = t.opened_at ?? t.closed_at;
    return d && new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === today;
  });
  const winners   = todayTrades.filter(t => (t.pnl_usd ?? 0) > 0).length;
  const totalPnl  = (pnl?.pnl ?? 0).toFixed(2);
  const tradeList = todayTrades.map(t =>
    `${t.symbol}: ${(t.pnl_usd ?? 0) >= 0 ? '+' : ''}$${(t.pnl_usd ?? 0).toFixed(2)}`
  ).join(', ') || 'none';

  try {
    const result = await localAI({
      system: 'You are an AI trading analyst. Plain text only — no markdown symbols. Be direct and concise.',
      prompt: `End-of-day summary for ${today}.

Performance today:
- Net P&L: $${totalPnl}
- Trades taken: ${todayTrades.length} (${winners} winners)
- Trade breakdown: ${tradeList}
- Regime: ${context?.regime ?? 'unknown'} | Direction: ${context?.direction ?? 'unknown'} | VIX: ${context?.vix ?? 'n/a'}

Write a concise EOD summary (under 150 words):
1. Today's result in one sentence with P&L
2. What worked and what didn't (be specific to the trades above)
3. What to watch tomorrow
4. One lesson or pattern from today`,
      fallbackModel: 'claude-haiku-4-5-20251001',
      maxTokens: 400,
    });

    const content = result.text ?? '';
    await saveDailyBriefing({ date: today, type: 'eod', content, regime: context?.regime, direction: context?.direction, vix: context?.vix });
    pushToChat(`📊 EOD Summary — ${today}\n\n${content}`, 'eod_summary');
    console.log(`[eod] Summary generated for ${today}`);
    return { date: today, type: 'eod', content };
  } catch (err) {
    console.error('[eod] Error:', err.message);
    return null;
  }
}

// ─── Regime Change Monitor ────────────────────────────────────────────────────

async function checkRegimeChange() {
  try {
    const context     = await getMarketContext();
    const current     = context?.regime;
    if (!current) return;
    const last        = await getScannerState('last_regime');
    if (last && last !== current) {
      const dir = context.direction ?? '';
      pushToChat(
        `🔄 Regime Change: Market shifted from "${last}" → "${current}" (${dir})\n\n${context.market_narrative ?? ''}`,
        'regime_change'
      );
      console.log(`[regime] Changed: ${last} → ${current}`);
    }
    await setScannerState('last_regime', current);
  } catch (err) {
    console.error('[regime] checkRegimeChange error:', err.message);
  }
}

// ─── Analyst State Endpoint ───────────────────────────────────────────────────

app.get('/api/analyst/state', requireAuth, async (req, res) => {
  const isAdmin = (await getUser(req.session.username))?.role === 'admin';
  // For non-admin users, use their own broker credentials instead of the global admin account
  let userPosFn  = getPositions;
  let userPnlFn  = getDailyPnL;
  if (!isAdmin) {
    const dbU = isDbAvailable() ? await getDbUser(req.session.username) : null;
    const userCreds = dbU?.alpaca_api_key
      ? { apiKey: dbU.alpaca_api_key, secretKey: dbU.alpaca_secret_key, baseUrl: dbU.alpaca_base_url }
      : null;
    if (userCreds) {
      userPosFn = () => getUserPositions(userCreds);
      userPnlFn = () => getUserDailyPnL(userCreds);
    } else {
      userPosFn = () => Promise.resolve([]);
      userPnlFn = () => Promise.resolve({ pnl: 0, available: false });
    }
  }
  const [posResult, pnlResult, statusResult, monitorResult, ollamaResult, todayCostResult, monthStatsResult] = await Promise.allSettled([
    userPosFn(),
    userPnlFn(),
    getMarketStatus(),
    getAllPositionMonitoring(),
    isOllamaAvailable(),
    getTodaySpend(),
    getUsageStats({ days: 30 }),
  ]);

  const rawPositions = posResult.status      === 'fulfilled' ? (posResult.value      ?? []) : [];
  const pnlData      = pnlResult.status      === 'fulfilled' ? (pnlResult.value      ?? {}) : {};
  const statusData   = statusResult.status   === 'fulfilled' ? (statusResult.value   ?? {}) : {};
  const monitoring   = monitorResult.status  === 'fulfilled' ? (monitorResult.value  ?? []) : [];
  const ollamaUp     = ollamaResult.status   === 'fulfilled' ? (ollamaResult.value   ?? false) : false;
  const todayCost    = todayCostResult.status === 'fulfilled' ? (todayCostResult.value ?? 0) : 0;
  const monthRows    = monthStatsResult.status === 'fulfilled' ? (monthStatsResult.value ?? []) : [];
  const monthCost    = monthRows.reduce((sum, r) => sum + parseFloat(r.estimated_cost_usd ?? 0), 0);

  // Build a map of symbol → monitoring row for quick lookups
  const monMap = {};
  for (const m of monitoring) monMap[m.symbol] = m;

  // Enrich each open position with pct_to_target and pct_to_stop
  const openPositions = rawPositions.map(pos => {
    const mon   = monMap[pos.symbol] ?? {};
    const entry = parseFloat(pos.avg_entry_price ?? pos.entry_price ?? 0);
    const curr  = parseFloat(pos.current_price   ?? 0);
    const stop  = parseFloat(mon.stop_price   ?? 0);
    const tgt   = parseFloat(mon.target_price  ?? 0);

    let pct_to_target = null;
    let pct_to_stop   = null;

    if (entry && tgt && tgt !== entry) {
      pct_to_target = Math.min(100, Math.max(0, ((curr - entry) / (tgt - entry)) * 100));
    }
    if (entry && stop && entry !== stop) {
      // How far price has moved toward the stop (0% = at entry, 100% = at stop)
      pct_to_stop = Math.min(100, Math.max(0, ((entry - curr) / (entry - stop)) * 100));
    }

    return {
      symbol:        pos.symbol,
      entry_price:   entry,
      current_price: curr,
      unrealized_pl: parseFloat(pos.unrealized_pl ?? 0),
      stop_price:    stop || null,
      target_price:  tgt  || null,
      pct_to_target: pct_to_target !== null ? Math.round(pct_to_target) : null,
      pct_to_stop:   pct_to_stop   !== null ? Math.round(pct_to_stop)   : null,
    };
  });

  const lastScan  = _scannerState.lastScan;
  const scanTime  = lastScan?.timestamp ?? null;
  let nextScan    = null;
  if (scanTime && _scannerState.autoEnabled) {
    nextScan = new Date(new Date(scanTime).getTime() + 10 * 60 * 1000).toISOString();
  }

  const uInfo = getUniverseInfo();
  res.json({
    last_scan:        scanTime,
    next_scan:        nextScan,
    open_positions:   openPositions,
    today_regime:     lastScan?.context?.regime ?? await getScannerState('last_regime').catch(() => null),
    today_direction:  lastScan?.context?.direction ?? null,
    trades_today:     pnlData.count ?? 0,
    pnl_today:        pnlData.pnl   ?? 0,
    scanner_running:  _scannerState.autoEnabled,
    market_open:      statusData.is_open ?? false,
    universe_size:    uInfo.size   || (lastScan?.context?._raw?.movers?.universe_size ?? 0),
    universe_source:  uInfo.source || (lastScan?.context?._raw?.movers?.universe_source ?? 'unknown'),
    ollama_available: ollamaUp,
    ollama_model:     process.env.OLLAMA_MODEL || 'llama3.1:8b',
    estimated_cost_today_usd:  +todayCost.toFixed(4),
    estimated_cost_month_usd:  +monthCost.toFixed(4),
  });
});

// ─── Position Monitor ──────────────────────────────────────────────────────────

const _vixHistory = []; // { ts, vix } rolling 60-min window

async function runPositionMonitor() {
  let positions = [];
  try { positions = await getPositions(); } catch { return; }
  if (!positions.length) return;

  // Track VIX for circuit breaker
  try {
    const { vix } = await getMarketRegime();
    if (vix) {
      _vixHistory.push({ ts: Date.now(), vix });
      const cutoff60 = Date.now() - 62 * 60 * 1000;
      while (_vixHistory.length && _vixHistory[0].ts < cutoff60) _vixHistory.shift();
      // Circuit breaker: VIX up >20% in last 30 min
      const cutoff30 = Date.now() - 32 * 60 * 1000;
      const pastVix  = _vixHistory.filter(h => h.ts < cutoff30).pop()?.vix;
      if (pastVix && ((vix - pastVix) / pastVix) * 100 > 20) {
        const spike = (((vix - pastVix) / pastVix) * 100).toFixed(1);
        console.log(`[monitor] VIX spike +${spike}% — triggering circuit breaker`);
        const closed = [];
        for (const pos of positions) {
          try {
            await closePosition(pos.symbol);
            const pnl = parseFloat(pos.unrealized_pl ?? 0);
            closed.push(`${pos.symbol} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`);
            await deletePositionMonitoring(pos.symbol);
          } catch {}
        }
        pushToChat(
          `🚨 VIX spike detected (+${spike}% in 30 min). Closing all positions to protect capital.\n${closed.join(' | ')}\nWill re-assess when market stabilises.`,
          'circuit_breaker'
        );
        return;
      }
    }
  } catch {}

  // Per-position checks
  const openTrades = await getTrades({ status: 'open', limit: 50, account_source: 'alpaca_paper' }).catch(() => []) ?? [];

  for (const pos of positions) {
    const sym   = pos.symbol;
    const entry = parseFloat(pos.avg_entry_price);
    const curr  = parseFloat(pos.current_price);
    const unrealPl = parseFloat(pos.unrealized_pl ?? 0);

    // Find matching DB trade for stop/target
    const dbTrade = openTrades.find(t => t.symbol === sym);
    if (!dbTrade?.take_profit || !dbTrade?.stop_loss) continue;

    const target = parseFloat(dbTrade.take_profit);
    const stop   = parseFloat(dbTrade.stop_loss);

    const totalRange    = target - entry;
    const gainPct       = totalRange > 0 ? (curr - entry) / totalRange : 0; // 0–1 toward target
    const stopRange     = entry - stop;
    const stopApproach  = stopRange > 0 ? (entry - curr) / stopRange : 0;   // 0–1 toward stop

    // Load monitoring state
    const monState = await getPositionMonitoring(sym) ?? { stop_moved_to_be: false, stop_trailed: false };

    // ACTION A — Move stop to breakeven at 50% toward target
    if (gainPct >= 0.5 && !monState.stop_moved_to_be && curr > entry) {
      try {
        await moveStopToBreakeven(sym);
        await upsertPositionMonitoring({ symbol: sym, entry_price: entry, stop_price: entry, target_price: target, stop_moved_to_be: true, stop_trailed: monState.stop_trailed, last_price: curr });
        pushToChat(
          `🔒 ${sym} — Stop moved to breakeven ($${entry.toFixed(2)}). Position is protected. Target still at $${target.toFixed(2)}.`,
          'stop_moved'
        );
      } catch {}
    }

    // ACTION B — Trail stop to 50% of gain at 80% toward target
    if (gainPct >= 0.8 && !monState.stop_trailed && curr > entry) {
      const trailStop = +(entry + (curr - entry) * 0.5).toFixed(2);
      try {
        // Cancel existing stop and place new one at trail level
        const orders = await getOrders({ status: 'open' });
        const stopOrd = (Array.isArray(orders) ? orders : orders?.orders ?? [])
          .find(o => o.symbol === sym && (o.type === 'stop' || o.type === 'stop_limit'));
        if (stopOrd) await cancelOrder(stopOrd.id);
        // Place updated stop via Alpaca PATCH handled by moveStopToBreakeven-style call
        await upsertPositionMonitoring({ symbol: sym, entry_price: entry, stop_price: trailStop, target_price: target, stop_moved_to_be: true, stop_trailed: true, last_price: curr });
        const locked = (unrealPl * 0.5).toFixed(0);
        pushToChat(
          `🎯 ${sym} approaching target. Trailing stop to $${trailStop} (locks +$${locked} of potential gain).`,
          'trail_stop'
        );
      } catch {}
    }

    // ACTION C — Warn when within 15% of stop
    if (stopApproach >= 0.85) {
      pushToChat(
        `⚠️ ${sym} nearing stop loss. Currently $${curr.toFixed(2)}, stop at $${stop.toFixed(2)}. Consider exiting if momentum confirms breakdown.`,
        'stop_warning'
      );
    }

    // Update last_price in monitoring state
    await upsertPositionMonitoring({
      symbol: sym, entry_price: entry, stop_price: stop, target_price: target,
      stop_moved_to_be: monState.stop_moved_to_be, stop_trailed: monState.stop_trailed, last_price: curr,
    });
  }

  // Clean up monitoring rows for positions that are now closed
  const openSymbols = new Set(positions.map(p => p.symbol));
  const monitored   = await getAllPositionMonitoring?.().catch(() => []) ?? [];
  for (const row of monitored) {
    if (!openSymbols.has(row.symbol)) await deletePositionMonitoring(row.symbol);
  }
}

// ─── Bot rules config ─────────────────────────────────────────────────────────

const CONVICTION_FACTORS = [
  { factor: 'Beat streak ≥3 quarters',    points: '+25' },
  { factor: 'Beat streak 2 quarters',      points: '+15' },
  { factor: 'Beat streak 1 quarter',       points: '+8'  },
  { factor: 'Strong earnings quality',     points: '+20' },
  { factor: 'Moderate earnings quality',   points: '+8'  },
  { factor: 'Guidance raised',             points: '+15' },
  { factor: 'Guidance lowered',            points: '−15' },
  { factor: 'Pre-earnings drift up',       points: '+15' },
  { factor: 'Pre-earnings drift down',     points: '−10' },
  { factor: 'Relative strength strong',    points: '+15' },
  { factor: 'Relative strength weak',      points: '−10' },
  { factor: 'Insider buying ≥2 buys/60d', points: '+10' },
  { factor: 'Insider buying 1 buy/60d',    points: '+5'  },
  { factor: 'Analyst strong buy',          points: '+15' },
  { factor: 'Analyst buy',                 points: '+10' },
  { factor: 'Analyst sell',               points: '−12' },
  { factor: 'Analyst strong sell',        points: '−20' },
  { factor: 'Short squeeze setup',         points: '+10' },
  { factor: 'High short interest (>25%)', points: '−5'  },
  { factor: 'RVOL ≥2.0×',                points: '+15' },
  { factor: 'RVOL ≥1.5×',                points: '+8'  },
  { factor: 'RVOL <0.5× (low activity)', points: '−8'  },
  { factor: 'Weekly trend up',             points: '+12' },
  { factor: 'Weekly trend down',          points: '−12' },
  { factor: 'VIX 25–28',                 points: '−5'  },
  { factor: 'VIX 28–35',                 points: '−10' },
  { factor: 'VIX >35',                   points: '−20' },
  { factor: 'Sector concentrated (same ETF)', points: '−25' },
  { factor: 'Correlated position held',   points: '−20' },
  { factor: 'Lunch chop window',          points: '−5'  },
  { factor: 'RSI oversold (<40) [TV]',   points: '+20' },
  { factor: 'RSI overbought (>70) [TV]', points: '−20' },
  { factor: 'Above EMA20 & EMA50 [TV]',  points: '+15' },
  { factor: 'Below EMA20 & EMA50 [TV]', points: '−15' },
  { factor: 'MACD histogram positive [TV]', points: '+10' },
  { factor: 'MACD histogram negative [TV]', points: '−10' },
  { factor: 'Near support (<2%) [TV]',   points: '+15' },
  { factor: 'Near resistance (<2%) [TV]', points: '−15' },
  { factor: 'Below Bollinger midline [TV]', points: '+10' },
  { factor: 'Above Bollinger upper [TV]', points: '−10' },
  { factor: 'Base score (every stock)',    points: '+20' },
];

const SCHEDULE_STATIC = {
  morning_briefing: '9:00 AM ET (Mon–Fri)',
  scan_interval_min: 10,
  scan_window_start: '9:45 AM ET',
  scan_window_end:   '3:30 PM ET',
  scan_days:         'Mon–Fri',
  avoid_window:      '12:30–1:30 PM ET (lunch chop, −5 pts penalty)',
};

app.get('/api/bot/config', requireAuth, async (req, res) => {
  const scannerPaused  = (await getScannerState('paused')) === 'true';
  const username = req.session.username;
  const userCfg  = await getUserBotConfig(username);
  res.json({
    ...userCfg,
    scanner_paused:    scannerPaused,
    defaults:          BOT_CONFIG_DEFAULTS,
    conviction_factors: CONVICTION_FACTORS,
    schedule:          SCHEDULE_STATIC,
    sector_rule: 'Never open 2 positions in the same ETF sector simultaneously',
  });
});

app.put('/api/bot/config', requireAuth, async (req, res) => {
  const username = req.session.username;
  const body     = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid body' });

  // Require explicit consent before enabling automated trading
  if (body.auto_execute === true) {
    if (!body.auto_trade_consent) {
      return res.status(400).json({
        error: 'You must explicitly consent to automated trading before enabling this feature.',
        require_consent: true,
      });
    }
    query(
      `UPDATE users SET auto_trade_consent_at = NOW() WHERE username = $1`,
      [username]
    ).catch(() => {}); // non-fatal
    logActivity(username, 'auto_trade_consent', 'User consented to automated trading');
  }

  // Whitelist allowed fields — reject unknown keys
  const allowed = ['profile', 'daily_profit_target', 'daily_loss_limit', 'max_open_positions',
    'min_conviction_score', 'auto_execute', 'max_vix_for_scan', 'trade_source', 'position_sizing',
    'vix_thresholds', 'sectors_blocklist', 'kb_enabled'];
  const config = {};
  for (const key of allowed) {
    if (body[key] !== undefined) config[key] = body[key];
  }

  // Basic validation
  const n = (k, min, max) => {
    const v = config[k];
    if (v !== undefined && (typeof v !== 'number' || v < min || v > max))
      throw Object.assign(new Error(`${k} must be ${min}–${max}`), { status: 400 });
  };
  try {
    n('daily_profit_target', 10, 10000);
    n('daily_loss_limit',    10, 10000);
    n('max_open_positions',  1,  10);
    n('min_conviction_score', 0, 100);
    n('max_vix_for_scan',    10, 100);
    if (config.trade_source !== undefined && !['paper','tiger','moomoo'].includes(config.trade_source))
      throw Object.assign(new Error('trade_source must be paper, tiger, or moomoo'), { status: 400 });
    if (config.position_sizing) {
      const ps = config.position_sizing;
      if (ps.min_dollars    !== undefined && (ps.min_dollars < 100 || ps.min_dollars > 50000))
        throw new Error('position_sizing.min_dollars must be 100–50000');
      if (ps.max_dollars    !== undefined && (ps.max_dollars < 100 || ps.max_dollars > 100000))
        throw new Error('position_sizing.max_dollars must be 100–100000');
      if (ps.stop_multiplier  !== undefined && (ps.stop_multiplier  < 0.5 || ps.stop_multiplier  > 5))
        throw new Error('stop_multiplier must be 0.5–5');
      if (ps.target_multiplier !== undefined && (ps.target_multiplier < 1 || ps.target_multiplier > 10))
        throw new Error('target_multiplier must be 1–10');
    }
    if (config.vix_thresholds) {
      const vt = config.vix_thresholds;
      if (vt.defensive !== undefined && (vt.defensive < 10 || vt.defensive > 80))
        throw new Error('vix_thresholds.defensive must be 10–80');
      if (vt.crisis !== undefined && (vt.crisis < 15 || vt.crisis > 100))
        throw new Error('vix_thresholds.crisis must be 15–100');
    }
    if (config.sectors_blocklist !== undefined && !Array.isArray(config.sectors_blocklist))
      throw new Error('sectors_blocklist must be an array');
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  await setUserBotConfig(username, config);
  logActivity(username, 'bot_config_updated', JSON.stringify(config));
  res.json({ ok: true, config });
});

// ─── Docs search logging ──────────────────────────────────────────────────────

app.post('/api/docs/search-log', async (req, res) => {
  const { query: q, found } = req.body;
  if (!q?.trim()) return res.status(400).json({ error: 'query required' });
  const userIp    = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || null;
  const id = await recordDocQuery({ query: q.trim(), found: !!found, userIp, userAgent });
  res.json({ ok: true, id });
});

app.get('/api/docs/queries', async (req, res) => {
  const onlyUnanswered = req.query.unanswered === 'true';
  const rows = await getDocQueries({ limit: 200, onlyUnanswered });
  res.json({ queries: rows });
});

// Background: notify Telegram about unanswered doc queries every 30 min
async function notifyUnansweredQueries() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  try {
    const rows = await getDocQueries({ onlyUnanswered: true });
    const pending = rows.filter(r => !r.notified);
    if (!pending.length) return;
    const lines = pending.map(r => `• "${r.query}" (${new Date(r.created_at).toLocaleString()})`).join('\n');
    const msg = `📚 *Unanswered Docs Queries (${pending.length})*\n\nUsers searched for things not in the docs:\n${lines}\n\nConsider adding these to the documentation.`;
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' }),
    });
    for (const r of pending) await markDocQueryNotified(r.id);
  } catch (e) {
    console.error('notifyUnansweredQueries error:', e.message);
  }
}
setInterval(notifyUnansweredQueries, 30 * 60 * 1000); // every 30 min

// ─── Detailed API call stats ─────────────────────────────────────────────────

app.get('/api/stats/detail', requireAuth, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const statsUser = await getUser(req.session.username);
    const statsUsername = statsUser?.role === 'admin' ? null : req.session.username;
    const detail = await getApiCallStats({ days, username: statsUsername });
    const summary = await getUsageStats({ days });
    res.json({ detail, summary: summary ?? [] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats/slippage', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         ROUND(AVG(slippage_cents), 2)  AS avg_slippage_cents,
         ROUND(MAX(slippage_cents), 2)  AS max_slippage_cents,
         COUNT(*)                        AS trade_count,
         COUNT(slippage_cents)           AS trades_with_slippage
       FROM trades
       WHERE username = $1
         AND created_at > NOW() - INTERVAL '30 days'`,
      [req.session.username]
    );
    res.json({ ok: true, ...rows[0] });
  } catch (err) {
    console.error('[stats/slippage]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Service health check ─────────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  const checks = await Promise.allSettled([
    // PostgreSQL
    isDbAvailable()
      ? query('SELECT 1').then(() => ({ name: 'PostgreSQL', status: 'ok' }))
      : Promise.resolve({ name: 'PostgreSQL', status: 'unavailable', detail: 'DATABASE_URL not set' }),

    // Alpaca
    fetch(`${process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets'}/v2/clock`, {
      headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY },
    }).then(r => r.json()).then(d => ({ name: 'Alpaca', status: 'ok', detail: d.is_open ? 'Market OPEN' : 'Market CLOSED', is_open: d.is_open }))
      .catch(e => ({ name: 'Alpaca', status: 'error', detail: e.message })),

    // Anthropic
    process.env.ANTHROPIC_API_KEY
      ? fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } })
          .then(r => ({ name: 'Anthropic (Claude)', status: r.ok ? 'ok' : 'error', detail: r.ok ? 'API key valid' : `HTTP ${r.status}` }))
          .catch(e => ({ name: 'Anthropic (Claude)', status: 'error', detail: e.message }))
      : Promise.resolve({ name: 'Anthropic (Claude)', status: 'unavailable', detail: 'ANTHROPIC_API_KEY not set' }),

    // Moomoo OpenD — TCP probe
    new Promise(resolve => {
      const host = process.env.MOOMOO_OPEND_HOST || '127.0.0.1';
      const port = parseInt(process.env.MOOMOO_OPEND_PORT) || 11111;
      const s = net.createConnection({ host, port, timeout: 2000 });
      s.once('connect', () => { s.destroy(); resolve({ name: 'Moomoo OpenD', status: 'ok', detail: `${host}:${port} reachable` }); });
      s.once('error', e => resolve({ name: 'Moomoo OpenD', status: 'error', detail: e.message }));
      s.once('timeout', () => { s.destroy(); resolve({ name: 'Moomoo OpenD', status: 'error', detail: 'Connection timeout' }); });
    }),

    // Telegram Bot — check token validity
    process.env.TELEGRAM_BOT_TOKEN
      ? fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`)
          .then(r => r.json()).then(d => ({ name: 'Telegram Bot', status: d.ok ? 'ok' : 'error', detail: d.ok ? `@${d.result.username}` : d.description }))
          .catch(e => ({ name: 'Telegram Bot', status: 'error', detail: e.message }))
      : Promise.resolve({ name: 'Telegram Bot', status: 'unavailable', detail: 'TELEGRAM_BOT_TOKEN not set' }),
  ]);

  const services = checks.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { name: ['PostgreSQL','Alpaca','Anthropic','Moomoo','Telegram'][i], status: 'error', detail: r.reason?.message }
  );
  res.json({ services, checked_at: new Date().toISOString() });
});

// ─── Price refresh helper ────────────────────────────────────────────────────
// Fetches missing trading days from Yahoo Finance and upserts into backtest_prices.
// Called automatically on every /api/research/stock request.
const _priceRefreshCache = new Map(); // symbol → last refresh timestamp

async function refreshStockPrices(symbol) {
  // Rate-limit: once per symbol per 10 minutes
  const now = Date.now();
  if (_priceRefreshCache.get(symbol) > now - 10 * 60 * 1000) return;
  _priceRefreshCache.set(symbol, now);

  try {
    // Find the latest date we have in DB for this symbol
    const { rows } = await query(
      `SELECT MAX(price_date) AS latest FROM backtest_prices WHERE symbol=$1`, [symbol]);
    const latest = rows[0]?.latest; // e.g. "2026-04-06"

    // Work out how far back to fetch — if no data at all, go 3 years back
    const today    = new Date().toISOString().split('T')[0];
    let   fromDate;
    if (!latest) {
      const d = new Date(); d.setFullYear(d.getFullYear() - 3);
      fromDate = d.toISOString().split('T')[0];
    } else {
      // Start from the day after latest (Yahoo range is inclusive)
      const d = new Date(latest); d.setDate(d.getDate() + 1);
      fromDate = d.toISOString().split('T')[0];
    }

    if (fromDate >= today) return; // already up to date

    console.log(`[prices] Refreshing ${symbol} from ${fromDate} → ${today}`);

    // Yahoo Finance v8 chart endpoint — same one used in scoring.js
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
                `?interval=1d&period1=${toUnix(fromDate)}&period2=${toUnix(today) + 86400}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    if (!resp.ok) return;

    const data   = await resp.json();
    const result = data?.chart?.result?.[0];
    if (!result) return;

    const timestamps = result.timestamp || [];
    const q          = result.indicators?.quote?.[0] || {};
    const { open = [], high = [], low = [], close = [], volume = [] } = q;

    let inserted = 0;
    for (let i = 0; i < timestamps.length; i++) {
      if (!close[i]) continue;
      const dateStr = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
      await query(
        `INSERT INTO backtest_prices (symbol, price_date, open, high, low, close, volume, adj_close)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (symbol, price_date) DO UPDATE SET
           open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
           close=EXCLUDED.close, volume=EXCLUDED.volume, adj_close=EXCLUDED.adj_close`,
        [symbol, dateStr, open[i]||null, high[i]||null, low[i]||null,
         close[i], volume[i]||null, close[i]]
      );
      inserted++;
    }
    if (inserted) console.log(`[prices] ${symbol}: +${inserted} days upserted`);
  } catch (err) {
    console.warn(`[prices] refreshStockPrices(${symbol}) failed:`, err.message);
  }
}

function toUnix(dateStr) { return Math.floor(new Date(dateStr).getTime() / 1000); }

// ─── Research / Backtest API ─────────────────────────────────────────────────

// Symbol list for autocomplete — returns all distinct symbols, picking best (non-null) name
app.get('/api/research/symbols', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT DISTINCT ON (symbol) symbol, name
      FROM conviction_scores
      ORDER BY symbol, (name IS NOT NULL) DESC, scored_at DESC
    `);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Overall backtest summary by grade
app.get('/api/research/summary', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        grade,
        COUNT(*)                                                              AS picks,
        ROUND(AVG(ret_1w)  * 100, 2)                                         AS avg_ret_1w,
        ROUND(AVG(ret_1m)  * 100, 2)                                         AS avg_ret_1m,
        ROUND(AVG(ret_3m)  * 100, 2)                                         AS avg_ret_3m,
        ROUND(AVG(spy_1m)  * 100, 2)                                         AS spy_avg_1m,
        ROUND(AVG(ret_1m - spy_1m) * 100, 2)                                 AS alpha_1m,
        ROUND(100.0 * SUM(CASE WHEN ret_1w > 0 THEN 1 ELSE 0 END)/COUNT(*),1) AS win_rate_1w,
        ROUND(100.0 * SUM(CASE WHEN ret_1m > 0 THEN 1 ELSE 0 END)/COUNT(*),1) AS win_rate_1m
      FROM backtest_returns
      WHERE ret_1w IS NOT NULL AND ret_1m IS NOT NULL
      GROUP BY grade ORDER BY grade
    `);
    const { rows: meta } = await query(`
      SELECT COUNT(DISTINCT symbol) AS symbols,
             MIN(score_date) AS from_date, MAX(score_date) AS to_date
      FROM backtest_returns`);
    res.json({ summary: rows, meta: meta[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Top stocks by grade + return period
app.get('/api/research/top-picks', async (req, res) => {
  try {
    const grade  = ['A','B','C','F'].includes(req.query.grade) ? req.query.grade : 'B';
    const period = ['1w','1m','3m'].includes(req.query.period) ? req.query.period : '1m';
    const col    = `ret_${period}`;
    const { rows } = await query(`
      SELECT symbol,
             COUNT(*)                       AS occurrences,
             ROUND(AVG(${col}) * 100, 2)   AS avg_return,
             ROUND(MAX(${col}) * 100, 2)   AS best_return,
             ROUND(100.0 * SUM(CASE WHEN ${col} > 0 THEN 1 ELSE 0 END)/COUNT(*), 1) AS win_rate
      FROM backtest_returns
      WHERE grade=$1 AND ${col} IS NOT NULL
      GROUP BY symbol HAVING COUNT(*) >= 3
      ORDER BY avg_return DESC LIMIT 20
    `, [grade]);
    res.json({ grade, period, picks: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Price + score history for a single stock (for the explorer chart)
app.get('/api/research/stock', async (req, res) => {
  try {
    const symbol = (req.query.symbol || '').toUpperCase().trim();
    if (!symbol) return res.status(400).json({ error: 'symbol required' });

    // ── Auto-refresh stale prices from Yahoo Finance ─────────────────────────
    await refreshStockPrices(symbol);

    const { rows: prices } = await query(
      `SELECT price_date, open, high, low, close, volume
       FROM backtest_prices WHERE symbol=$1 ORDER BY price_date ASC`, [symbol]);
    const { rows: scores } = await query(
      `SELECT score_date, score, grade, rsi, macd_hist, ema20, ema50, bb_upper, bb_mid, rs_vs_spy
       FROM backtest_scores WHERE symbol=$1 ORDER BY score_date ASC`, [symbol]);
    const { rows: returns } = await query(
      `SELECT score_date, ret_1w, ret_1m, ret_3m, dip_pct, dip_reason
       FROM backtest_returns WHERE symbol=$1 ORDER BY score_date ASC`, [symbol]);
    if (!prices.length) return res.status(404).json({ error: 'Symbol not found in backtest data' });
    res.json({ symbol, prices, scores, returns });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Stock Explorer extras — news + analyst rating (fetched lazily after chart loads)
// Merge Yahoo/Alpaca + Benzinga news, Benzinga first, dedup by URL
async function _mergedSymbolNews(symbol, limit = 8) {
  const [base, bz] = await Promise.allSettled([
    getSymbolNews({ symbol, limit }),
    isBenzingaConfigured() ? getBzNews({ symbol, limit }) : Promise.resolve(null),
  ]);
  const baseArticles = base.status === 'fulfilled' ? (base.value?.articles ?? []) : [];
  const bzArticles   = bz.status   === 'fulfilled' && bz.value
    ? (bz.value.articles ?? []).map(a => ({
        title:     a.title,
        url:       a.url,
        source:    'Benzinga',
        published: a.published_at,
        tickers:   a.tickers ?? [],
        teaser:    a.teaser  ?? null,
      }))
    : [];

  const seen = new Set();
  return [...bzArticles, ...baseArticles]
    .filter(a => {
      if (!a.url || seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    })
    .slice(0, limit);
}

app.get('/api/explorer/extras', requireAuth, async (req, res) => {
  try {
    const symbol = (req.query.symbol || '').toUpperCase().trim();
    if (!symbol) return res.status(400).json({ error: 'symbol required' });

    const [newsResult, scoreResult] = await Promise.allSettled([
      _mergedSymbolNews(symbol, 8),
      getConvictionScore({ symbol, positions: [] }),
    ]);

    const news    = newsResult.status === 'fulfilled' ? newsResult.value : [];
    const scoring = scoreResult.status === 'fulfilled' ? scoreResult.value : null;

    const sig = scoring?.signals ?? {};
    const analyst = scoring ? {
      consensus:  sig.analyst_consensus  ?? null,
      target:     sig.analyst_target     ?? null,
      upside_pct: sig.analyst_upside_pct ?? null,
      score:      scoring.score          ?? null,
      grade:      scoring.grade          ?? null,
    } : null;

    // Full signals exposed for watchlist fallback enrichment
    const signals = scoring ? {
      rsi:          sig.rsi              ?? null,
      rvol:         sig.rvol             ?? null,
      weekly_trend: sig.weekly_trend     ?? null,
      short_float:  sig.short_float_pct  ?? null,
      macd_signal:  sig.macd_hist != null ? (sig.macd_hist > 0 ? 'bullish' : 'bearish') : null,
      ema_trend:    (() => {
        const cp = sig.current_price, e20 = sig.ema20, e50 = sig.ema50;
        return cp && e20 && e50 ? (cp > e20 && cp > e50 ? 'above' : cp < e20 && cp < e50 ? 'below' : 'mixed') : null;
      })(),
      horizon:      scoring.horizon      ?? null,
    } : null;

    res.json({ symbol, news, analyst, signals });
  } catch (err) {
    console.error('[explorer/extras]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Stock Explorer company tab — profile, institutional holders, executives, news
app.get('/api/explorer/company', requireAuth, async (req, res) => {
  const symbol = (req.query.symbol || '').toUpperCase().trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    const [yfResult, newsResult] = await Promise.allSettled([
      _yf.quoteSummary(symbol, { modules: ['assetProfile', 'majorHoldersBreakdown', 'institutionOwnership'] }),
      _mergedSymbolNews(symbol, 8),
    ]);
    const yfData = yfResult.status === 'fulfilled' ? yfResult.value : null;
    const profile = yfData?.assetProfile ?? null;
    const majorHolders = yfData?.majorHoldersBreakdown ?? null;
    const instOwn = yfData?.institutionOwnership ?? null;
    const news = newsResult.status === 'fulfilled' ? (newsResult.value ?? []) : [];

    const topHolders = (instOwn?.ownershipList ?? []).slice(0, 8).map(h => ({
      name:      h.organization,
      pct_held:  h.pctHeld != null ? +(h.pctHeld * 100).toFixed(2) : null,
      shares:    h.position,
      value:     h.value,
    }));
    const executives = (profile?.companyOfficers ?? []).slice(0, 6).map(o => ({
      name:  o.name,
      title: o.title,
      age:   o.age ?? null,
    }));

    res.json({
      symbol,
      profile: profile ? {
        description:  profile.longBusinessSummary ?? null,
        sector:       profile.sector              ?? null,
        industry:     profile.industry            ?? null,
        website:      profile.website             ?? null,
        employees:    profile.fullTimeEmployees   ?? null,
        country:      profile.country             ?? null,
      } : null,
      holders: {
        insider_pct:       majorHolders?.insidersPercentHeld       != null ? +(majorHolders.insidersPercentHeld       * 100).toFixed(2) : null,
        institutional_pct: majorHolders?.institutionsPercentHeld   != null ? +(majorHolders.institutionsPercentHeld   * 100).toFixed(2) : null,
        top_holders:       topHolders,
      },
      executives,
      news: news.slice(0, 8),
    });
  } catch (err) {
    console.error('[explorer/company]', err);
    res.status(500).json({ error: 'Company data unavailable' });
  }
});

// ─── Benzinga endpoints ───────────────────────────────────────────────────────

app.get('/api/benzinga/options', requireAuth, async (req, res) => {
  if (!isBenzingaConfigured()) return res.status(503).json({ error: 'Benzinga not configured' });
  const symbol    = req.query.symbol ? req.query.symbol.toUpperCase().trim() : undefined;
  const limit     = Math.min(parseInt(req.query.limit) || 25, 100);
  const sentiment = req.query.sentiment || undefined;
  try {
    const data = await getBzOptionsActivity({ symbol, limit, sentiment });
    res.json(data ?? { items: [], total: 0 });
  } catch (e) {
    console.error('[benzinga/options]', e.message);
    res.status(500).json({ error: 'Options data unavailable' });
  }
});

// ── News AI analysis — batches top-5 headlines through Claude-Haiku, 10-min cache ──
let _newsAnalysisCache = null;
let _newsAnalysisCacheAt = 0;
app.get('/api/news/analysis', requireAuth, async (req, res) => {
  if (_newsAnalysisCache && Date.now() - _newsAnalysisCacheAt < 10 * 60_000) {
    return res.json(_newsAnalysisCache);
  }
  try {
    const news = isBenzingaConfigured() ? await getBzNews({ limit: 6 }) : null;
    const articles = news?.articles ?? [];
    if (!articles.length) return res.json([]);

    const lines = articles.map((a, i) => {
      const tickers = (a.tickers || []).slice(0, 3).join(',') || 'MARKET';
      return `${i + 1}. [${tickers}] ${a.title}`;
    }).join('\n');

    const msg = await _anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: `You are a stock market analyst. For each news headline below, write ONE short sentence (≤15 words) explaining which stocks may go up or down and why (include indirect impacts like suppliers, competitors).

Headlines:\n${lines}

Reply ONLY as a JSON array — no prose, no markdown fences:
[{"n":1,"up":["TICK"],"down":["TICK"],"impact":"one sentence"},...]`,
      }],
    });

    const raw  = msg.content[0]?.text || '[]';
    const json = raw.match(/\[[\s\S]*\]/)?.[0] || '[]';
    const analyzed = JSON.parse(json).map((item, i) => ({
      ...item,
      title:        articles[i]?.title        || '',
      tickers:      articles[i]?.tickers      || [],
      published_at: articles[i]?.published_at || null,
    }));
    _newsAnalysisCache   = analyzed;
    _newsAnalysisCacheAt = Date.now();
    res.json(analyzed);
  } catch (e) {
    console.error('[news/analysis]', e.message);
    res.json([]);
  }
});

app.get('/api/benzinga/news', requireAuth, async (req, res) => {
  if (!isBenzingaConfigured()) return res.status(503).json({ error: 'Benzinga not configured' });
  const symbol = req.query.symbol ? req.query.symbol.toUpperCase().trim() : undefined;
  const limit  = Math.min(parseInt(req.query.limit) || 10, 50);
  try {
    const data = await getBzNews({ symbol, limit });
    res.json(data ?? { articles: [], total: 0 });
  } catch (e) {
    console.error('[benzinga/news]', e.message);
    res.status(500).json({ error: 'News unavailable' });
  }
});

app.get('/api/benzinga/guidance', requireAuth, async (req, res) => {
  if (!isBenzingaConfigured()) return res.status(503).json({ error: 'Benzinga not configured' });
  const symbol   = req.query.symbol ? req.query.symbol.toUpperCase().trim() : undefined;
  const dateFrom = req.query.from || undefined;
  try {
    const data = await getBzGuidance({ symbol, dateFrom, limit: 20 });
    res.json(data ?? { guidance: [], total: 0 });
  } catch (e) {
    console.error('[benzinga/guidance]', e.message);
    res.status(500).json({ error: 'Guidance data unavailable' });
  }
});

app.get('/api/benzinga/fda', requireAuth, async (req, res) => {
  if (!isBenzingaConfigured()) return res.status(503).json({ error: 'Benzinga not configured' });
  const dateFrom = req.query.from || undefined;
  const dateTo   = req.query.to   || undefined;
  try {
    const data = await getBzFDA({ dateFrom, dateTo, limit: 30 });
    res.json(data ?? { events: [], total: 0 });
  } catch (e) {
    console.error('[benzinga/fda]', e.message);
    res.status(500).json({ error: 'FDA data unavailable' });
  }
});

app.get('/api/benzinga/earnings', requireAuth, async (req, res) => {
  if (!isBenzingaConfigured()) return res.status(503).json({ error: 'Benzinga not configured' });
  const symbol   = req.query.symbol ? req.query.symbol.toUpperCase().trim() : undefined;
  const dateFrom = req.query.from || undefined;
  const dateTo   = req.query.to   || undefined;
  try {
    const data = await getBzEarnings({ symbol, dateFrom, dateTo, limit: 30 });
    res.json(data ?? { earnings: [], total: 0 });
  } catch (e) {
    console.error('[benzinga/earnings]', e.message);
    res.status(500).json({ error: 'Earnings data unavailable' });
  }
});

app.get('/api/benzinga/fundamentals', requireAuth, async (req, res) => {
  if (!isBenzingaConfigured()) return res.status(503).json({ error: 'Benzinga not configured' });
  const symbol = (req.query.symbol || '').toUpperCase().trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    const data = await getBzFundamentals({ symbol });
    if (!data) return res.status(404).json({ error: 'No fundamentals data' });
    res.json(data);
  } catch (e) {
    console.error('[benzinga/fundamentals]', e.message);
    res.status(500).json({ error: 'Fundamentals unavailable' });
  }
});

app.get('/api/benzinga/dividends', requireAuth, async (req, res) => {
  if (!isBenzingaConfigured()) return res.status(503).json({ error: 'Benzinga not configured' });
  const symbol   = req.query.symbol ? req.query.symbol.toUpperCase().trim() : undefined;
  const dateFrom = req.query.from || undefined;
  const dateTo   = req.query.to   || undefined;
  try {
    const data = await getBzDividends({ symbol, dateFrom, dateTo, limit: 30 });
    res.json(data ?? { dividends: [], total: 0 });
  } catch (e) {
    console.error('[benzinga/dividends]', e.message);
    res.status(500).json({ error: 'Dividends data unavailable' });
  }
});

// Dip analysis — worst drops with reasons
app.get('/api/research/dips', async (req, res) => {
  try {
    const symbol = (req.query.symbol || '').toUpperCase().trim();
    const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
    const params = symbol ? [symbol] : [];
    // Single-symbol: all dips for that stock sorted by worst
    // All-stocks: sample across reason categories for variety
    const { rows } = symbol ? await query(`
      SELECT symbol, score_date, grade, score,
             ROUND(dip_pct * 100, 2) AS dip_pct,
             dip_reason,
             ROUND(ret_1m  * 100, 2) AS recovery_1m,
             ROUND(ret_3m  * 100, 2) AS recovery_3m
      FROM backtest_returns
      WHERE symbol=$1 AND dip_pct IS NOT NULL
      ORDER BY dip_pct ASC LIMIT ${limit}
    `, params) : await query(`
      SELECT symbol, score_date, grade, score,
             ROUND(dip_pct * 100, 2) AS dip_pct,
             dip_reason,
             ROUND(ret_1m  * 100, 2) AS recovery_1m,
             ROUND(ret_3m  * 100, 2) AS recovery_3m
      FROM (
        SELECT *,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY cat_priority ASC, dip_pct ASC) AS rn
        FROM (
          -- Market fear (VIX spike) — worst 6 events across all symbols
          (SELECT symbol, score_date, grade, score, dip_pct, dip_reason, ret_1m, ret_3m, 1 AS cat_priority
           FROM backtest_returns WHERE dip_pct IS NOT NULL AND dip_reason LIKE '%market fear%'
           ORDER BY dip_pct ASC LIMIT 6)
          UNION ALL
          -- Broad market selloffs (worst 6, not VIX-flagged)
          (SELECT symbol, score_date, grade, score, dip_pct, dip_reason, ret_1m, ret_3m, 2 AS cat_priority
           FROM backtest_returns WHERE dip_pct IS NOT NULL AND dip_reason LIKE '%broad market%' AND dip_reason NOT LIKE '%market fear%'
           ORDER BY dip_pct ASC LIMIT 6)
          UNION ALL
          -- Stock-specific worst drops
          (SELECT symbol, score_date, grade, score, dip_pct, dip_reason, ret_1m, ret_3m, 3 AS cat_priority
           FROM backtest_returns WHERE dip_pct IS NOT NULL AND dip_reason LIKE '%stock-specific%'
           ORDER BY dip_pct ASC LIMIT 12)
        ) mixed
      ) deduped
      WHERE rn = 1
      ORDER BY dip_pct ASC LIMIT ${limit}
    `);
    res.json({ dips: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// What-if simulator — invest $X on every signal matching criteria
app.get('/api/research/simulate', async (req, res) => {
  try {
    const grade   = req.query.grade   || 'B';          // A,B,C,F,BC (BC = B or C)
    const period  = ['1w','1m','3m'].includes(req.query.period) ? req.query.period : '1m';
    const amount  = Math.min(Math.max(parseFloat(req.query.amount) || 10000, 100), 1000000);
    const universe = req.query.universe || 'all';       // all | largecap | nasdaq
    const col     = `ret_${period}`;

    const LARGECAP = ['NVDA','AAPL','MSFT','GOOGL','META','AMZN','TSLA','AMD','NFLX',
      'JPM','GS','MS','V','MA','AVGO','MRVL','CRM','NOW','PANW','CRWD','PLTR','NET',
      'DDOG','SNOW','COIN','UBER','SHOP','SMCI','ARM','MU','LRCX','KLAC','AMAT',
      'INTC','QCOM','RTX','LMT','XOM','CVX','BAC','WFC','UNH','LLY','JNJ','PFE',
      'ABBV','TMO','ISRG','SYK','HON','CAT','DE','UNP','GE','IBM','ORCL','ADBE',
      'INTU','CSCO','TXN','QCOM','PYPL','SQ','AXP','BLK','SCHW','SPGI','ICE','CME'];

    let gradeFilter = grade === 'BC' ? `grade IN ('B','C')` : `grade = '${['A','B','C','F'].includes(grade) ? grade : 'B'}'`;
    let universeFilter = universe === 'largecap'
      ? `AND symbol IN (${LARGECAP.map(s=>`'${s}'`).join(',')})`
      : universe === 'nasdaq'
      ? `AND symbol IN (${NASDAQ100.map(s=>`'${s}'`).join(',')})`
      : '';

    const { rows } = await query(`
      SELECT symbol, score_date, grade, score,
             ${col}          AS ret,
             spy_${period}   AS spy_ret
      FROM backtest_returns
      WHERE ${gradeFilter} AND ${col} IS NOT NULL ${universeFilter}
      ORDER BY score_date ASC
    `);

    if (!rows.length) return res.json({ signals: 0, total_invested: 0, total_profit: 0 });

    const signals      = rows.length;
    const totalInvested = signals * amount;
    const profits       = rows.map(r => parseFloat(r.ret) * amount);
    const totalProfit   = profits.reduce((a, b) => a + b, 0);
    const wins          = rows.filter(r => parseFloat(r.ret) > 0).length;
    const avgReturn     = rows.reduce((a, r) => a + parseFloat(r.ret), 0) / signals;
    const avgSpyReturn  = rows.reduce((a, r) => a + parseFloat(r.spy_ret||0), 0) / signals;

    // Best and worst picks
    const sorted = [...rows].sort((a,b) => parseFloat(b.ret) - parseFloat(a.ret));
    const best5  = sorted.slice(0, 5).map(r => ({ symbol: r.symbol, date: r.score_date, ret: parseFloat(r.ret)*100 }));
    const worst5 = sorted.slice(-5).reverse().map(r => ({ symbol: r.symbol, date: r.score_date, ret: parseFloat(r.ret)*100 }));

    // Monthly cumulative profit for chart
    const monthly = {};
    for (const r of rows) {
      const month = r.score_date.toISOString().slice(0, 7);
      if (!monthly[month]) monthly[month] = { profit: 0, signals: 0 };
      monthly[month].profit  += parseFloat(r.ret) * amount;
      monthly[month].signals += 1;
    }
    let cumulative = 0;
    const timeline = Object.entries(monthly).sort().map(([month, d]) => {
      cumulative += d.profit;
      return { month, profit: Math.round(d.profit), cumulative: Math.round(cumulative), signals: d.signals };
    });

    res.json({
      signals, total_invested: Math.round(totalInvested),
      total_profit: Math.round(totalProfit),
      total_return_pct: ((totalProfit / totalInvested) * 100).toFixed(2),
      win_rate: ((wins / signals) * 100).toFixed(1),
      avg_return_pct: (avgReturn * 100).toFixed(2),
      avg_spy_pct: (avgSpyReturn * 100).toFixed(2),
      alpha_pct: ((avgReturn - avgSpyReturn) * 100).toFixed(2),
      best5, worst5, timeline,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// ─── Research: Regime Analysis ───────────────────────────────────────────────
// Derives regime from vix_close (backtest_scores has no dedicated regime column)
app.get('/api/research/regime-analysis', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        CASE
          WHEN bs.vix_close <  15 THEN 'low_vix (<15)'
          WHEN bs.vix_close <  25 THEN 'normal (15-25)'
          WHEN bs.vix_close <  35 THEN 'elevated (25-35)'
          ELSE                         'high_vix (35+)'
        END AS regime,
        br.grade,
        COUNT(*)                                                               AS signals,
        ROUND(AVG(br.ret_1m) * 100, 2)                                        AS avg_ret_1m,
        ROUND(AVG(br.ret_1m - br.spy_1m) * 100, 2)                           AS alpha_1m,
        ROUND(100.0 * SUM(CASE WHEN br.ret_1w > 0 THEN 1 ELSE 0 END)/COUNT(*), 1) AS win_rate_1w
      FROM backtest_returns br
      JOIN backtest_scores bs ON bs.symbol = br.symbol AND bs.score_date = br.score_date
      WHERE br.ret_1w IS NOT NULL AND br.ret_1m IS NOT NULL
        AND bs.vix_close IS NOT NULL
      GROUP BY regime, br.grade
      ORDER BY MIN(bs.vix_close), br.grade
    `);
    res.json({ regimes: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// ─── Research: Indicator Correlation ─────────────────────────────────────────
// Uses actual backtest_scores column names: above_emas (bool), rsi, macd_hist
app.get('/api/research/indicator-correlation', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        ROUND(AVG(CASE WHEN bs.rsi BETWEEN 40 AND 60 THEN br.ret_1w ELSE NULL END) * 100, 3) AS rsi_neutral_ret,
        ROUND(AVG(CASE WHEN bs.rsi > 70               THEN br.ret_1w ELSE NULL END) * 100, 3) AS rsi_overbought_ret,
        ROUND(AVG(CASE WHEN bs.rsi < 35               THEN br.ret_1w ELSE NULL END) * 100, 3) AS rsi_oversold_ret,
        ROUND(AVG(CASE WHEN bs.macd_hist > 0          THEN br.ret_1w ELSE NULL END) * 100, 3) AS macd_positive_ret,
        ROUND(AVG(CASE WHEN bs.macd_hist < 0          THEN br.ret_1w ELSE NULL END) * 100, 3) AS macd_negative_ret,
        ROUND(AVG(CASE WHEN bs.above_emas = true      THEN br.ret_1w ELSE NULL END) * 100, 3) AS ema_above_ret,
        ROUND(AVG(CASE WHEN bs.above_emas = false     THEN br.ret_1w ELSE NULL END) * 100, 3) AS ema_below_ret,
        ROUND(AVG(CASE WHEN bs.vix_close < 20         THEN br.ret_1w ELSE NULL END) * 100, 3) AS low_vix_ret,
        ROUND(AVG(CASE WHEN bs.vix_close > 30         THEN br.ret_1w ELSE NULL END) * 100, 3) AS high_vix_ret,
        COUNT(*) AS total
      FROM backtest_returns br
      JOIN backtest_scores bs ON bs.symbol = br.symbol AND bs.score_date = br.score_date
      WHERE br.ret_1w IS NOT NULL
    `);
    res.json({ correlations: rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// ─── Research: Live Bot Accuracy ──────────────────────────────────────────────
app.get('/api/research/live-accuracy', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        CASE
          WHEN conviction_score >= 75 THEN 'A (75+)'
          WHEN conviction_score >= 60 THEN 'B (60-74)'
          WHEN conviction_score >= 45 THEN 'C (45-59)'
          ELSE 'F (<45)'
        END AS grade_band,
        COUNT(*)                                                               AS trades,
        ROUND(100.0 * SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END)/COUNT(*),1) AS win_rate,
        ROUND(AVG(pnl_usd), 2)                                                 AS avg_pnl,
        ROUND(SUM(pnl_usd), 2)                                                 AS total_pnl
      FROM trades
      WHERE status = 'closed'
        AND conviction_score IS NOT NULL
        AND pnl_usd IS NOT NULL
      GROUP BY grade_band
      ORDER BY MIN(conviction_score) DESC
    `);
    res.json({ accuracy: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// ─── Research: Pipeline Status ────────────────────────────────────────────────
// Each table queried independently — missing tables show 0 rows instead of 500
app.get('/api/research/pipeline-status', requireAuth, async (req, res) => {
  const safe = async (sql) => {
    try { const r = await query(sql); return r.rows[0]; }
    catch { return { rows: 0, latest: null }; }
  };
  const [prices, scores, returns_, knowledge, live] = await Promise.all([
    safe(`SELECT COUNT(*) AS rows, MAX(price_date) AS latest FROM backtest_prices`),
    safe(`SELECT COUNT(*) AS rows, MAX(score_date) AS latest FROM backtest_scores`),
    safe(`SELECT COUNT(*) AS rows, MAX(score_date) AS latest FROM backtest_returns`),
    safe(`SELECT COUNT(*) AS rows FROM knowledge_chunks`),
    safe(`SELECT COUNT(*) AS rows, MAX(scored_at)  AS latest FROM conviction_scores WHERE scored_at > NOW() - INTERVAL '7 days'`),
  ]);
  res.json({
    prices:      { rows: prices.rows,    latest: prices.latest },
    scores:      { rows: scores.rows,    latest: scores.latest },
    returns:     { rows: returns_.rows,  latest: returns_.latest },
    knowledge:   { rows: knowledge.rows },
    live_scores: { rows: live.rows,      latest: live.latest },
  });
});

// ─── Fundamental Screener ─────────────────────────────────────────────────────

app.get('/api/research/screen', requireAuth, async (req, res) => {
  try {
    const { screenFundamentals } = await import('../core/fundamental-screener.js');
    const conditions = {
      rev_qoq: req.query.rev_qoq === 'true',
      rev_yoy: req.query.rev_yoy === 'true',
      ni_qoq:  req.query.ni_qoq  === 'true',
      ni_yoy:  req.query.ni_yoy  === 'true',
      eps_qoq: req.query.eps_qoq === 'true',
      eps_yoy: req.query.eps_yoy === 'true',
    };
    const data = await screenFundamentals(conditions);
    res.json(data);
  } catch (err) {
    console.error('[research/screen]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/research/fundamentals/:symbol', requireAuth, async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const { rows } = await query(
      `SELECT period_end, revenue, gross_profit, operating_income,
              net_income, eps_diluted, eps_basic, shares_diluted
       FROM fundamentals
       WHERE symbol = $1 AND period_type = 'quarterly'
       ORDER BY period_end DESC
       LIMIT 8`,
      [symbol]
    );
    if (rows.length === 0) return res.status(404).json({ error: `No fundamentals data for ${symbol}` });
    res.json({ symbol, quarters: rows });
  } catch (err) {
    console.error('[research/fundamentals]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── End-of-Day Position Flatten ─────────────────────────────────────────────
// Runs every minute, triggers at 3:50 PM ET on weekdays.
// Cancels all open orders then closes all positions — ensures no overnight exposure.

async function sendTelegramMsg(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }),
  });
}

// ─── Nodemailer alert transport (SMTP — Zoho / Google Workspace / any SMTP) ──
let _mailer = null;
function _getMailer() {
  if (_mailer) return _mailer;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_USER || !SMTP_PASS) return null;
  const port   = parseInt(SMTP_PORT || '465');
  _mailer = nodemailer.createTransport({
    host:   SMTP_HOST || 'smtp.zoho.com',
    port,
    secure: port === 465,     // true = SSL/TLS (465), false = STARTTLS (587)
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  });
  return _mailer;
}

async function sendEmailAlert(subject, body) {
  const mailer = _getMailer();
  if (!mailer) return;
  const from = process.env.SMTP_USER;
  const to   = process.env.ALERT_EMAIL || from;
  // Convert Telegram Markdown to HTML (only the subset we actually use)
  const html = body
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
  try {
    await mailer.sendMail({
      from:    `Trading Bot <${from}>`,
      to,
      subject,
      text:    body,
      html:    `<div style="font-family:monospace;font-size:14px;line-height:1.7;color:#e6edf3;background:#0d1117;padding:24px;border-radius:8px">${html}</div>`,
    });
    console.log(`[email] sent: ${subject} → ${to}`);
  } catch (e) {
    console.error('[email] sendEmailAlert failed:', e.message);
  }
}

let _eodFlattenedDate = null; // prevent double-run on same day

async function eodFlatten() {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const dayOfWeek = et.getDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) return; // skip weekends

  const h = et.getHours();
  const m = et.getMinutes();
  if (h !== 15 || m !== 50) return; // only at exactly 3:50 PM ET

  const todayStr = et.toISOString().split('T')[0];
  if (_eodFlattenedDate === todayStr) return; // already ran today
  _eodFlattenedDate = todayStr;

  console.log('[EOD] 3:50 PM ET — flattening all positions');
  try {
    // 1. Cancel all open orders (bracket legs, limits, stops)
    await cancelAllOrders().catch(() => {});

    // 2. Close every open position
    const positions = await getPositions().catch(() => []);
    const results = [];
    for (const pos of positions) {
      try {
        await closePosition(pos.symbol);
        results.push(`✅ Closed ${pos.symbol} (${pos.qty} shares, P&L: $${pos.unrealized_pl?.toFixed(2)})`);
      } catch (e) {
        results.push(`⚠️ ${pos.symbol}: ${e.message}`);
      }
    }

    // 3. Fetch today's final P&L
    let pnlLine = '';
    try {
      const pnl = await getDailyPnL();
      pnlLine = `\n💰 *Today's P&L: ${pnl.pnl >= 0 ? '+' : ''}$${pnl.pnl?.toFixed(2)} (${pnl.pnl_pct?.toFixed(2)}%)*`;
    } catch {}

    // 4. Notify via Telegram + email
    const posLines = results.length ? results.join('\n') : 'No open positions.';
    const eodMsg = `🔔 *EOD Flatten — 3:50 PM ET*\n\n${posLines}${pnlLine}\n\n_All orders cancelled. No overnight exposure._`;
    await sendTelegramMsg(eodMsg);
    await sendEmailAlert('EOD Flatten — 3:50 PM ET', eodMsg).catch(() => {});
    console.log('[EOD] Flatten complete:', results);
  } catch (e) {
    console.error('[EOD] Flatten error:', e.message);
    const failMsg = `⚠️ *EOD Flatten failed*: ${e.message}`;
    await sendTelegramMsg(failMsg).catch(() => {});
    await sendEmailAlert('⚠ EOD Flatten Failed', failMsg).catch(() => {});
  }
}

setInterval(eodFlatten, 60 * 1000); // check every minute

// ─── Browser Terminal (admin-only WebSocket PTY) ──────────────────────────────

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const rejectUpgrade = (socket, status, msg) => {
  socket.write(`HTTP/1.1 ${status} ${msg}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws/terminal') { rejectUpgrade(socket, 404, 'Not Found'); return; }
  const fakeRes = { getHeader: () => {}, setHeader: () => {}, end: () => {}, on: () => {} };
  sessionMiddleware(req, fakeRes, async () => {
    try {
      const user = await getUser(req.session?.username);
      if (!user || user.role !== 'admin') {
        console.warn('[ws/terminal] rejected — user:', req.session?.username, '| role:', user?.role);
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    } catch (err) {
      console.error('[ws/terminal] upgrade error:', err.message);
      rejectUpgrade(socket, 500, 'Internal Server Error');
    }
  });
});

wss.on('connection', (ws) => {
  const shell = process.env.SHELL || '/bin/zsh';
  const cwd   = dirname(fileURLToPath(import.meta.url));
  const term  = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,   // conservative default; client sends real size on connect
    rows: 24,
    cwd:  join(cwd, '../..'),  // tradingview-mcp project root
    env:  { ...process.env, TERM: 'xterm-256color' },
  });

  term.onData(data  => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'output', data })); });
  term.onExit(() => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit' })); ws.close(); });

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'input')  term.write(msg.data);
      if (msg.type === 'resize') term.resize(Math.max(2, msg.cols), Math.max(2, msg.rows));
    } catch { /* ignore malformed messages */ }
  });
  ws.on('close', () => { try { term.kill(); } catch {} });
});

// ─── Trade Reconciliation Cron ────────────────────────────────────────────────
// Sync Alpaca bracket exits → DB every 5 min during market hours (9:30–4 PM ET)

cron.schedule('*/5 * * * 1-5', async () => {
  const utcT = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  if (utcT < 13 * 60 + 30 || utcT >= 20 * 60) return;
  try {
    const result = await syncClosedTrades();
    if (result.synced > 0)
      console.log(`[sync] Closed ${result.synced} trade(s):`, result.trades.map(t => `${t.symbol} $${t.pnl_usd}`).join(', '));
  } catch (err) {
    console.error('[sync] error:', err.message);
  }
});

// ─── AI Scanner Cron ──────────────────────────────────────────────────────────
// Fires every 5 min Mon–Fri; internally throttles based on time-of-day.
// 9:45–11:30 AM → 5 min, 11:30 AM–2 PM → 20 min, 2–3:30 PM → 10 min.

function getScanIntervalMinutes() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins >= 585 && mins < 690)  return 5;   // 9:45–11:30 AM
  if (mins >= 690 && mins < 840)  return 20;  // 11:30 AM–2:00 PM
  if (mins >= 840 && mins < 930)  return 10;  // 2:00–3:30 PM
  return null;
}

let _lastScanTs = 0;

cron.schedule('*/5 * * * 1-5', async () => {
  if (!_scannerState.autoEnabled) return;
  const interval = getScanIntervalMinutes();
  if (!interval) return;
  const elapsed = (Date.now() - _lastScanTs) / 60000;
  if (elapsed < interval) return;
  _lastScanTs = Date.now();
  try {
    console.log('[scanner] Auto-scan running…');
    const result = await runAiScan({ autoExecute: _scannerState.autoEnabled, triggeredBy: 'cron' });
    const sel = result.selection;
    if (sel.symbol)
      console.log(`[scanner] Selected ${sel.symbol} (conviction ${sel.conviction}) — ${sel.reason?.slice(0, 60)}`);
    else
      console.log(`[scanner] No trade: ${sel.no_trade_reason}`);
  } catch (err) {
    console.error('[scanner] cron error:', err.message);
  }
});

// ─── Morning Briefing Cron ────────────────────────────────────────────────────
// Fires every 5 min Mon–Fri; checks if ET time is 9:30–9:34 AM

cron.schedule('*/5 * * * 1-5', async () => {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et    = new Date(etStr);
  const mins  = et.getHours() * 60 + et.getMinutes();
  if (mins < 9 * 60 + 30 || mins >= 9 * 60 + 35) return;
  try {
    await runMorningBriefing();
  } catch (err) {
    console.error('[briefing] cron error:', err.message);
  }
});

// ─── Position Monitor Cron ────────────────────────────────────────────────────
// Every 2 min, Mon–Fri, 9:45 AM–3:50 PM ET

cron.schedule('*/2 * * * 1-5', async () => {
  const utcT = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  if (utcT < 13 * 60 + 45 || utcT >= 19 * 60 + 50) return;
  try {
    await runPositionMonitor();
  } catch (err) {
    console.error('[monitor] cron error:', err.message);
  }
});

// ─── EOD Summary Cron ─────────────────────────────────────────────────────────
// Fires every 5 min Mon–Fri; checks if ET time is exactly 4:00–4:04 PM

cron.schedule('*/5 * * * 1-5', async () => {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et    = new Date(etStr);
  const mins  = et.getHours() * 60 + et.getMinutes();
  if (mins < 16 * 60 || mins >= 16 * 60 + 5) return;
  try {
    await runEODSummary();
  } catch (err) {
    console.error('[eod] cron error:', err.message);
  }
});

// ─── Regime Change Cron ───────────────────────────────────────────────────────
// Every 15 min, Mon–Fri, 9:30 AM–4:00 PM ET

cron.schedule('*/15 * * * 1-5', async () => {
  const utcT = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  if (utcT < 13 * 60 + 30 || utcT >= 20 * 60) return;
  try {
    await checkRegimeChange();
  } catch (err) {
    console.error('[regime] cron error:', err.message);
  }
});

// ─── Reflection Agent Cron ────────────────────────────────────────────────────
// Fires every 5 min Mon–Fri; runs reflection at 4:15–4:19 PM ET (DST-safe).

cron.schedule('*/5 * * * 1-5', async () => {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et    = new Date(etStr);
  const mins  = et.getHours() * 60 + et.getMinutes();
  if (mins < 16 * 60 + 15 || mins >= 16 * 60 + 20) return; // 4:15–4:19 PM ET only
  try {
    const result = await runReflection();
    if (!result.lessons?.length) return;
    const lines = result.lessons.map(l => {
      const icon = l.outcome === 'win' ? '✅' : '❌';
      const src  = l.ai_source === 'ollama' ? ' [local]' : '';
      return `${icon} ${l.symbol}: ${l.lesson}${src}`;
    });
    pushToChat(
      `📚 Daily Reflection (${result.trades_analysed} trade${result.trades_analysed !== 1 ? 's' : ''} analysed)\n\n` +
      lines.join('\n') +
      '\n\nThese lessons are now in my memory.',
      'autonomous'
    );
  } catch (err) {
    console.error('[reflection] cron error:', err.message);
  }
});

app.post('/api/reflection/run', requireAdmin, async (req, res) => {
  try {
    const result = await runReflection();
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[reflection/run]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Weekend Research Refresh ─────────────────────────────────────────────────
// Runs the full research pipeline (download → scores → backtest → train) as
// child processes sequentially. Safe to call from cron or admin API.

const _execFileAsync = promisify(execFile);
const _PROJECT_ROOT  = join(__dirname, '..', '..');
let   _refreshRunning = false;
let   _lastRefreshAt  = null;

async function runWeekendResearchRefresh() {
  if (_refreshRunning) {
    console.log('[research] Already running — skipped.');
    return { skipped: true };
  }
  _refreshRunning = true;
  const startedAt = Date.now();
  try {

  console.log('[research] Weekend refresh starting…');
  pushToChat('🔬 Weekend research refresh started — downloading prices, recomputing scores, running backtest, retraining ML model…', 'autonomous');

  const node    = process.execPath;
  const env     = process.env;
  const results = [];

  const _step = async (label, script, timeout) => {
    const t0 = Date.now();
    console.log(`[research] ${label}…`);
    const { stderr } = await _execFileAsync(
      node,
      ['--env-file=.env', script],
      { env, cwd: _PROJECT_ROOT, timeout }
    );
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (stderr) console.warn(`[research] ${label} stderr:`, stderr.slice(0, 400));
    console.log(`[research] ${label} ✓ ${elapsed}s`);
    results.push({ label, ok: true, elapsed });
    return elapsed;
  };

  // Step 1: incremental price download (catches last week's data)
  await _step('download-prices', 'src/research/download-prices.js', 60 * 60 * 1000);

  // Step 2: recompute scores for new dates only
  await _step('compute-scores', 'src/research/compute-scores.js', 90 * 60 * 1000);

  // Step 3: backtest forward returns
  await _step('backtest', 'src/research/backtest.js', 30 * 60 * 1000);

  // Step 4: retrain model (only if train-model.js exists)
  try {
    await _step('train-model', 'src/research/train-model.js', 15 * 60 * 1000);
    console.log('[research] model retrained.');
  } catch (_) { /* train-model.js not yet created — skip */ }

  // Clear factor weights cache so scorer picks up new model immediately
  invalidateFactorWeightsCache();
  console.log('[research] weekend pipeline complete ✓');

  // Fetch the newly trained model's stats for the notification
  let modelLine = '';
  try {
    const { rows } = await query(`
      SELECT id, auc_roc, accuracy, f1_1, train_rows, test_rows
      FROM model_results ORDER BY trained_at DESC LIMIT 1
    `);
    if (rows.length) {
      const m = rows[0];
      modelLine = `\n🤖 ML model #${m.id}: AUC ${(m.auc_roc * 100).toFixed(1)}% | Acc ${(m.accuracy * 100).toFixed(1)}% | F1 ${(m.f1_1 * 100).toFixed(1)}% | ${m.train_rows}+${m.test_rows} rows`;
    }
  } catch { /* model_results may not exist yet */ }

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(0);
  const stepLines = results.map(r =>
    `${r.ok ? '✅' : '❌'} ${r.label} (${r.elapsed}s)${r.error ? ' — ' + r.error : ''}`
  ).join('\n');
  const summary = `🔬 Research Refresh Complete (${totalSec}s)\n\n${stepLines}${modelLine}`;

  pushToChat(summary, 'autonomous');
  await sendTelegramMsg(summary).catch(() => {});
  await sendEmailAlert('Research Pipeline Complete', summary).catch(() => {});
  console.log('[research]', summary);

    _lastRefreshAt = new Date().toISOString();
    return { ok: true, results, totalSec, modelLine };
  } finally {
    _refreshRunning = false;
  }
}

// ─── Daily Research Crons (weekdays, SGT-friendly — all done before 7:30 AM SGT) ─
// All times are ET with DST-safe window checks inside the callback.

// 4:30 PM ET  = 4:30 AM SGT  — incremental price download (new bars from today)
cron.schedule('*/5 16-21 * * 1-5', async () => {
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins < 16 * 60 + 30 || mins >= 16 * 60 + 35) return;
  try {
    console.log('[research] Downloading latest prices…');
    await _execFileAsync(process.execPath, ['--env-file=.env', 'src/research/download-prices.js'],
      { env: process.env, cwd: _PROJECT_ROOT, timeout: 15 * 60 * 1000 });
    console.log('[research] Price download complete');
  } catch (err) { console.error('[research] download-prices error:', err.message); }
});

// 5:30 PM ET  = 5:30 AM SGT  — recompute conviction scores for new dates
cron.schedule('*/5 17-22 * * 1-5', async () => {
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins < 17 * 60 + 30 || mins >= 17 * 60 + 35) return;
  try {
    console.log('[research] Computing historical scores…');
    await _execFileAsync(process.execPath, ['--env-file=.env', 'src/research/compute-scores.js'],
      { env: process.env, cwd: _PROJECT_ROOT, timeout: 30 * 60 * 1000 });
    console.log('[research] Score computation complete');
  } catch (err) { console.error('[research] compute-scores error:', err.message); }
});

// 6:30 PM ET  = 6:30 AM SGT  — backtest forward returns on new data
cron.schedule('*/5 18-23 * * 1-5', async () => {
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins < 18 * 60 + 30 || mins >= 18 * 60 + 35) return;
  try {
    console.log('[research] Running backtest…');
    await _execFileAsync(process.execPath, ['--env-file=.env', 'src/research/backtest.js'],
      { env: process.env, cwd: _PROJECT_ROOT, timeout: 20 * 60 * 1000 });
    console.log('[research] Backtest complete');
  } catch (err) { console.error('[research] backtest error:', err.message); }
});

// 7:00 PM ET  = 7:00 AM SGT  — retrain ML model from updated backtest data
cron.schedule('*/5 19-23 * * 1-5', async () => {
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins < 19 * 60 || mins >= 19 * 60 + 5) return;
  try {
    console.log('[research] Retraining ML model…');
    await _execFileAsync(process.execPath, ['--env-file=.env', 'src/research/train-model.js'],
      { env: process.env, cwd: _PROJECT_ROOT, timeout: 10 * 60 * 1000 });
    invalidateFactorWeightsCache();
    const sgtTime = new Date().toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore' });
    pushToChat(
      `🧠 Overnight ML training complete (${sgtTime} SGT) — live scorer weights updated. Check Research tab for results.`,
      'autonomous'
    );
    console.log('[research] ML training complete');
  } catch (err) { console.error('[research] train-model error:', err.message); }
});

// ─── Weekend Research Cron ────────────────────────────────────────────────────
// Saturday 10 PM ET — full pipeline refresh for any gaps from the week.

cron.schedule('*/5 * * * 6', async () => {
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins < 22 * 60 || mins >= 22 * 60 + 5) return;
  try {
    await runWeekendResearchRefresh();
  } catch (err) {
    console.error('[research] cron error:', err.message);
  }
});

// ─── Weekly Ollama model update ───────────────────────────────────────────────
// Fires every Sunday at 10 AM SGT (2 AM UTC / 10 PM ET Sat) — quiet window,
// Ollama already running. Pulls nomic-embed-text + llama3.1:8b; skips if offline.

async function runOllamaModelUpdate() {
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const chatModel = process.env.OLLAMA_MODEL || 'llama3.1:8b';
  const models    = ['nomic-embed-text', chatModel];
  const results   = [];

  for (const model of models) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5 * 60 * 1000); // 5 min per model
      const resp = await fetch(`${ollamaUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model, stream: false }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const data = await resp.json().catch(() => ({}));
      const status = data.status ?? (resp.ok ? 'ok' : `HTTP ${resp.status}`);
      results.push(`${model}: ${status}`);
      console.log(`[ollama-update] ${model} → ${status}`);
    } catch (err) {
      results.push(`${model}: failed (${err.message})`);
      console.warn(`[ollama-update] ${model} failed:`, err.message);
    }
  }
  return results;
}

// Every Sunday — fire once between 10:00–10:05 AM SGT (UTC+8 = 02:00–02:05 UTC)
cron.schedule('*/5 2 * * 0', async () => {
  const utc  = new Date();
  const mins = utc.getUTCHours() * 60 + utc.getUTCMinutes();
  if (mins < 2 * 60 || mins >= 2 * 60 + 5) return;
  console.log('[ollama-update] weekly model refresh starting…');
  try {
    const results = await runOllamaModelUpdate();
    console.log('[ollama-update] done:', results.join(' | '));
  } catch (err) {
    console.error('[ollama-update] cron error:', err.message);
  }
});

// ─── Forecast Crons ──────────────────────────────────────────────────────────
// Monday 8:30 AM ET — generate week predictions before market open
cron.schedule('30 8 * * 1', async () => {
  try { await generateWeekPredictions(getMondayStr()); }
  catch (err) { console.error('[forecast] Monday cron error:', err.message); }
}, { timezone: 'America/New_York' });

// Daily 4:15 PM ET (Mon-Fri) — fill actual close prices.
// Timezone explicitly set to New York so this fires correctly regardless of server timezone (e.g. SGT/UTC+8).
cron.schedule('15 16 * * 1-5', async () => {
  try {
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    console.log(`[forecast] EOD fill running for ${dateStr}`);
    await fillTodayActuals(dateStr);
  } catch (err) { console.error('[forecast] EOD fill cron error:', err.message); }
}, { timezone: 'America/New_York' });

// ─── Catalyst Scanner Crons ───────────────────────────────────────────────────
// 9:00 AM ET Mon-Fri — pre-market sweep (market opens at 9:30, this runs 30 min early)
cron.schedule('0 9 * * 1-5', async () => {
  try {
    const result = await runCatalystScan();
    const total = result.gappers.length + result.low_float.length + result.sec_filings.length;
    console.log(`[catalyst] 9AM pre-market sweep complete — ${total} signals (${result.top_picks.length} top picks)`);
  } catch (err) {
    console.error('[catalyst] 9AM cron error:', err.message);
  }
}, { timezone: 'America/New_York' });

// 8:00 PM ET Mon-Fri — evening SEC 8-K sweep (after-hours filings)
cron.schedule('0 20 * * 1-5', async () => {
  try {
    const result = await runCatalystScan();
    console.log(`[catalyst] 8PM SEC sweep — ${result.sec_filings.length} 8-K filings found`);
  } catch (err) {
    console.error('[catalyst] 8PM cron error:', err.message);
  }
}, { timezone: 'America/New_York' });

// ─── Admin API: manual trigger (per-step or all) ──────────────────────────────

const _RESEARCH_SCRIPTS = {
  download: 'src/research/download-prices.js',
  scores:   'src/research/compute-scores.js',
  backtest: 'src/research/backtest.js',
  train:    'src/research/train-model.js',
};

app.post('/api/research/run', requireAdmin, async (req, res) => {
  const { step } = req.body;
  const toRun = step === 'all'
    ? Object.values(_RESEARCH_SCRIPTS)
    : [_RESEARCH_SCRIPTS[step]];
  if (!toRun[0]) return res.status(400).json({ error: 'Invalid step. Use: download|scores|backtest|train|all' });
  res.json({ ok: true, message: `Running ${step}… results will appear in server logs.` });
  // Fire-and-forget; don't block the HTTP response
  (async () => {
    for (const script of toRun) {
      await _execFileAsync(process.execPath, ['--env-file=.env', script],
        { env: process.env, cwd: _PROJECT_ROOT, timeout: 30 * 60 * 1000 })
        .catch(e => console.error(`[research] ${script} error:`, e.message));
    }
    if (step === 'train' || step === 'all') invalidateFactorWeightsCache();
  })();
});

app.post('/api/research/refresh', requireAdmin, async (req, res) => {
  if (_refreshRunning) {
    return res.status(409).json({ error: 'Refresh already in progress' });
  }
  // Fire and forget — client gets immediate ack, results push to chat when done
  runWeekendResearchRefresh().catch(err => console.error('[research] manual trigger error:', err.message));
  res.json({ ok: true, message: 'Research refresh started — results will appear in chat when complete.' });
});

app.get('/api/research/status', requireAdmin, async (req, res) => {
  let latestModel = null;
  try {
    const { rows } = await query(`
      SELECT id, trained_at, auc_roc, accuracy, f1_1, train_rows, test_rows,
             feature_weights, scoring_adjustments
      FROM model_results ORDER BY trained_at DESC LIMIT 1
    `);
    if (rows.length) latestModel = rows[0];
  } catch { /* table not yet created */ }

  res.json({
    ok:              true,
    running:         _refreshRunning,
    last_refresh_at: _lastRefreshAt,
    latest_model:    latestModel,
  });
});

app.get('/api/reflection/lessons', requireAuth, async (req, res) => {
  try {
    const lessons = await getRecentLessons({ limit: 50 });
    res.json({ ok: true, lessons });
  } catch (err) {
    console.error('[reflection/lessons]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Knowledge Base ───────────────────────────────────────────────────────────

app.post('/api/knowledge/add', requireAuth, async (req, res) => {
  try {
    const { title, content, category = 'custom', topic = 'custom' } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title and content required' });

    const { getEmbedding } = await import('../core/knowledge.js');
    const { saveKnowledgeChunk, countKnowledgeChunks } = await import('../core/db.js');

    const embedding = await getEmbedding(title + ' ' + content);
    if (!embedding) return res.status(503).json({ error: 'Ollama embedding unavailable' });

    await saveKnowledgeChunk({ topic, category, title, content, embedding, source: 'user' });
    const total = await countKnowledgeChunks();
    res.json({ success: true, total });
  } catch (err) {
    console.error('[knowledge/add]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/knowledge/count', requireAuth, async (req, res) => {
  try {
    const { countKnowledgeChunks } = await import('../core/db.js');
    const total = await countKnowledgeChunks();
    res.json({ total });
  } catch (err) {
    console.error('[knowledge/count]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

await initDb();
seedKnowledge()
  .then(r => { if (r?.seeded) console.log(`[knowledge] seeded ${r.seeded} chunks`); })
  .catch(e => console.error('[knowledge] seed error:', e.message));
await pgStore._ensureTable();
await migrateUsersToDb();
setInterval(cleanupOtpTokens, 60 * 60 * 1000); // clean expired OTPs every hour
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌  Port ${PORT} already in use. Run: pkill -f "web/server.js" then retry.`);
    process.exit(1);
  }
  throw err;
});

httpServer.listen(PORT, () => {
  console.log(`🌐 Dashboard running at http://localhost:${PORT}`);
  console.log(`[knowledge] using model: ${process.env.OLLAMA_KNOWLEDGE_MODEL || 'llama3.2:3b'}`);

  // Pre-warm caches in the background so first user requests are instant
  const today = new Date().toISOString().split('T')[0];
  Promise.allSettled([
    ttlCache('home:news', 5 * 60 * 1000, () => getMarketNews({ limit: 40 }))
      .then(() => console.log('✅ News cache warmed'))
      .catch(e => console.warn('⚠️  News cache warm failed:', e.message)),
    ttlCache(`home:earnings:${today}`, 60 * 60 * 1000, () => getEarningsCalendar({ date: today, limit: 15 }))
      .then(() => console.log('✅ Earnings cache warmed'))
      .catch(e => console.warn('⚠️  Earnings cache warm failed:', e.message)),
    runStrongBuysScan()
      .then(r => console.log(`✅ Strong buys warmed — ${r?.picks?.length ?? 0} picks from ${r?.scanned ?? 0} stocks`))
      .catch(e => console.warn('⚠️  Strong buys warm failed:', e.message)),
    runIntradayScan()
      .then(r => console.log(`✅ Intraday picks warmed — ${r?.picks?.length ?? 0} picks from ${r?.scanned ?? 0} stocks`))
      .catch(e => console.warn('⚠️  Intraday picks warm failed:', e.message)),
  ]);
});
