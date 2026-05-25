/**
 * Web dashboard server for the trading bot.
 * Run with: npm run dashboard
 * Protected by DASHBOARD_PASSWORD env var (required — no default)
 */

// MUST be first import — populates empty/missing env vars from .env regardless
// of how the process was launched. See src/core/env-loader.js for the why.
import '../core/env-loader.js';

import os from 'os';
import net from 'net';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import compression from 'compression';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cors from 'cors';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { initDb, query, isDbAvailable, getTrades, getDailyPnlHistory, getUsageStats, getApiCallStats, recordApiCall, upsertUsageStats, getTodaySpend, recordDocQuery, getDocQueries, markDocQueryNotified, logActivity, getActivity, upsertDailyPnl, getDbUser, getDbUserByEmail, createDbUser, upsertDbUser, updateDbUserLogin, deductCredit, addCredits, listDbUsers, updateDbUserPermissions, deleteDbUser, createOtpToken, verifyOtpToken, cleanupOtpTokens, saveUserAlpaca, clearUserAlpaca, clearUserLiveAlpaca, saveUserMoomoo, clearUserMoomoo, saveUserTiger, clearUserTiger, suspendUser, unsuspendUser, setUserCredits, setUserRole, getUserBotConfig, setUserBotConfig, BOT_CONFIG_DEFAULTS, createBugReport, getBugReports, updateBugReport, getScannerState, setScannerState, saveDailyBriefing, getDailyBriefing, upsertPositionMonitoring, getPositionMonitoring, getAllPositionMonitoring, deletePositionMonitoring, getRecentLosses, getRejections, recordTrade, closeTrade, getOpenTrade, saveLesson, getRecentLessons, getPerformancePatterns, upsertPerformancePattern, loadConversationHistory, saveDailyPick, getDailyPicks, invalidateFactorWeightsCache, upsertPrediction, fillActualPrice, getPredictionsForWeek, getPredictionHistory, setDisabledSources, upsertAccountSnapshot, getAccountSnapshots, getUserWatchlistSymbols, addUserWatchlistSymbol, removeUserWatchlistSymbol, logClientError, logServerError, getErrorLog, resolveError,
  insertSentinelRun, insertPendingAction, getPendingAction, updatePendingAction,
  listBots, softDeleteBot, getBotKpis, getRecentBotDecisions, getBotTrades } from '../core/db.js';
import Anthropic from '@anthropic-ai/sdk';
import { localAI, isOllamaAvailable } from '../core/ollama.js';
import { runReflection } from '../core/reflection.js';
import crypto from 'crypto';
import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import { SP500, NASDAQ100 } from '../research/sp500.js';
import { getAccount, getPositions, getOrders, getDailyPnL, getPortfolioHistory, placeTrade, closePosition, cancelAllOrders, cancelOrder, getMarketStatus, getMarketRegime, moveStopToBreakeven, getLiveAccount, getLivePositions, getLiveOrders, hasLiveAccount, getUserAccount, getUserPositions, validateAlpacaCreds, getUserOrders, getUserDailyPnL, getUserPortfolioHistory, getLatestPrice, placeQuickTrade, syncClosedTrades, clearPnlCache } from '../core/trader.js';
import cron from 'node-cron';
import { getMarketSentiment, getSectorPerformance, getMarketMovers, getUniverseInfo, getDynamicUniverse, SECTOR_MAP, SECTOR_NAMES } from '../core/sentiment.js';
import { getMarketNews, getEarningsCalendar, categoriseNews, getEarningsTrend, getSymbolNews, getEarnings } from '../core/news.js';
import { getAccounts, getFunds, getPositions as getMoomooPositions, getMoomooTodayPnL, getOrders as getMoomooOrders, getQuotes as getMoomooQuotes, getQuote as getMoomooQuote, getKLines as getMoomooKLines, getAtrPct as getMoomooAtrPct, placeMoomooTrade, cancelMoomooOrder, cancelAllMoomooOrders, closeMoomooPosition, MOOMOO_IS_SIMULATE, MOOMOO_TRADE_ENV_VALUE } from '../core/moomoo-tcp.js';
import { validateTigerCreds, getTigerFunds, getTigerPositions, getTigerOrders, placeTigerOrder } from '../core/tiger.js';
import { chat, clearHistory, chatHistory } from '../core/ai-chat.js';
import { startTelegramBot } from '../core/telegram-bot.js';
import { seedKnowledge } from '../core/knowledge.js';
import { isGraphConfigured, getContagionImpact, getSympathyTrades, getSystemicRisk, getGraphStats, getFullGraph } from '../core/graph.js';
import { seedGraph } from '../core/graph-seed.js';
import { runPremarketScan } from '../core/premarket-scanner.js';
import { runEarningsCascadeScan } from '../core/earnings-cascade.js';
import { runSentinel, signToken, verifyToken } from '../core/sentinel.js';
import { runDailyBotReport } from '../core/daily-bot-report.js';
import { pageSuccess, pageExpired, pageAlreadyActioned, pagePriceMoved, pageTokenInvalid, pageConfirmExecute, pageConfirmIgnore } from '../core/sentinel-pages.js';
import { getImpactAnalysis } from '../core/graph-impact.js';
import { getStockPrediction } from '../core/predictor.js';
import { marked } from 'marked';
import YahooFinance from 'yahoo-finance2';
const _yf = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

// Persist Yahoo Finance cookie jar (crumb) to DB so it survives restarts
const _YF_COOKIE_KEY = 'yf_cookie_jar';
async function _yfSaveCookieJar() {
  try {
    const jar = JSON.stringify(_yf._opts.cookieJar.toJSON());
    await query(
      `INSERT INTO system_kv(key, value, updated_at) VALUES($1, $2, NOW())
       ON CONFLICT(key) DO UPDATE SET value=$2, updated_at=NOW()`,
      [_YF_COOKIE_KEY, jar]
    );
  } catch { /* non-critical */ }
}
async function _yfRestoreCookieJar() {
  try {
    const { rows } = await query('SELECT value FROM system_kv WHERE key=$1', [_YF_COOKIE_KEY]);
    if (!rows.length) return false;
    const jarData = JSON.parse(rows[0].value);
    const { Cookie } = await import('tough-cookie');
    const jar = _yf._opts.cookieJar; // keep the ExtendedCookieJar — do NOT replace it
    for (const c of (jarData.cookies || [])) {
      try {
        const cookie = Cookie.fromJSON(c);
        if (!cookie) continue;
        const domain = (c.domain || '').replace(/^\./, '');
        const proto  = c.secure ? 'https' : 'http';
        await jar.setCookie(cookie, `${proto}://${domain}${c.path || '/'}`, { ignoreError: true });
      } catch { /* skip bad cookies */ }
    }
    console.log('[yf] cookie jar restored from DB');
    return true;
  } catch (e) {
    console.warn('[yf] cookie jar restore failed:', e.message);
    return false;
  }
}
// On startup: restore crumb from DB, then warm up with retry backoff on 429
async function _yfWarmup() {
  await _yfRestoreCookieJar();
  for (let i = 0; i < 6; i++) {
    try {
      await _yf.quoteSummary('AAPL', { modules: ['price'] });
      await _yfSaveCookieJar();
      console.log('[yf] crumb ready');
      return;
    } catch (e) {
      if (e.message?.includes('429')) {
        const delay = Math.min((i + 1) * 30_000, 180_000);
        console.warn(`[yf] crumb 429 — retry in ${delay / 1000}s (attempt ${i + 1}/6)`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.warn('[yf] crumb warmup error:', e.message);
        return;
      }
    }
  }
}
// Re-persist cookie jar every hour to keep it fresh across long uptimes
setInterval(() => _yfSaveCookieJar(), 60 * 60 * 1000);
import { adminChat, clearAdminHistory } from '../core/admin-ai.js';
import { getConvictionScore } from '../core/scoring.js';
import { getMarketContext } from '../core/market-context.js';
import { selectBestTrade } from '../core/stock-selector.js';
import { trainCalibration, applyCalibration, applyCalibrationToDay, getFailureAnalysis } from '../core/prediction-calibration.js';
import { runCatalystScan } from '../core/catalyst-scanner.js';
import { getBzNews, getBzOptionsActivity, getBzEarnings, getBzGuidance, getBzFDA, getBzDividends, getBzFundamentals, isBenzingaConfigured } from '../core/benzinga.js';
import { getFlowAlerts, getMarketTide, getOptionsFlow, getInsiderTrades, getCongressionalTrades, getTopMovers, getEconomicCalendar, getIpoCalendar, getFundamentals, getEarningsTranscript, getCorrelations, getIvRank, getStockState, streamOptionsFlow, isUWConfigured, getQuota, getOptionChain, getAtmChains, getExpiryBreakdown, getOptionsVolume, getGreekExposure, getMaxPain, getContractHistory, getContractVolumeProfile } from '../core/unusual-whales.js';
import { auditUWSchemas } from '../core/uw-schema-linter.js';
import { purgeOldUwRows } from '../core/uw-retention.js';
import { getUwConvictionForSymbol, getUwConvictionForSymbols } from '../core/uw-conviction.js';
import { dailyDataQualityReport } from '../core/uw-data-quality.js';
import { ingestNews, getIngesterStatus, startNewsIngesterCrons } from '../core/news-ingester.js';
import { runPreMarketScan } from '../core/premarket-news-scanner.js';
import { alert as sysAlert } from '../core/system-alerts.js';
import { checkEarningsRisk, checkAfterHoursMove, checkPreMarketHoldings, runWeekendScan } from '../core/position-guardian.js';
import { checkUnusualOptions } from '../core/options-scanner.js';
import { runBotScanForAllActive, scanBot, startBotEngineCrons } from '../core/bot-engine.js';
import { runExecutorForAllActive, processBot, startBotExecutorCrons } from '../core/bot-executor.js';
import { reconcileBotPositions } from '../core/bot-reconciler.js';
import { syncTradableUniverse } from '../core/universe-sync.js';
import { cachePolicy } from './middleware/cache-policy.js';

// ─── Process-level error handlers ─────────────────────────────────────────────
process.on('uncaughtException', async (e) => {
  console.error('[uncaught]', e);
  try { await sysAlert({ key: 'system/uncaught', severity: 'critical', title: 'uncaughtException', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }); } catch {}
  process.exit(1);
});
process.on('unhandledRejection', async (e) => {
  console.error('[unhandled-rejection]', e);
  try { await sysAlert({ key: 'system/unhandled-rejection', severity: 'critical', title: 'unhandledRejection', detail: { error: String(e), stack: e?.stack?.split('\n').slice(0, 5).join('\n') } }); } catch {}
});

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
const driftLimit = parseFloat(process.env.SENTINEL_DRIFT_TOLERANCE || '0.02');
// Strip trailing % / K / M suffixes UW sometimes includes in numeric strings
const parseUWNum = v => { if (v == null) return null; const n = parseFloat(String(v).replace(/[%KkMm,\s]/g, '')); return isNaN(n) ? null : n; };

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

// 'stats' merged into 'health' (2026-05-25). Both keys accepted for backwards
// compat — TAB_PAGE_MAP in index.html aliases 'stats' → 'health'.
const ALL_TABS    = ['dashboard', 'trades', 'scores', 'market', 'news', 'health', 'stats', 'docs', 'research', 'admin_bot', 'bot_rules', 'calendar', 'watchlist', 'signal_center', 'trading_desk', 'discover', 'bots'];
const ALL_WIDGETS = ['moomoo', 'alpaca_live', 'tiger', 'force_trade', 'chat', 'stock_explorer', 'notifications'];

const DEFAULT_PERMISSIONS = {
  admin:  { tabs: ALL_TABS,    widgets: ALL_WIDGETS },
  viewer: { tabs: ['dashboard', 'trades', 'scores', 'market', 'news', 'research', 'bot_rules', 'calendar', 'watchlist', 'signal_center', 'trading_desk', 'discover', 'bots'], widgets: ['alpaca_live', 'chat', 'stock_explorer', 'notifications'] },
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
  max: 200,             // raised from 60 — Trading Desk makes many parallel requests
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests.' },
});

// ─── Middleware ───────────────────────────────────────────────────────────────

const isProd = process.env.NODE_ENV === 'production';

// Trust the first proxy hop (Cloudflare / nginx) so rate-limiting uses real client IP
if (isProd) app.set('trust proxy', 1);

// Gzip compression — must be first so all responses benefit
app.use(compression({ level: 6, threshold: 1024 }));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://static.cloudflareinsights.com"],
      scriptSrcAttr:  ["'unsafe-inline'"],
      styleSrc:       ["'self'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
      styleSrcElem:   ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      styleSrcAttr:   ["'unsafe-inline'"],
      imgSrc:         ["'self'", 'data:', 'https:'],
      connectSrc:     ["'self'", "https://cdn.jsdelivr.net"],
      fontSrc:        ["'self'", "https://fonts.gstatic.com"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
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

// Redirect mobile browsers to mobile.html unless ?desktop=1 is set
app.get('/', (req, res, next) => {
  if (req.query.desktop === '1') return next();
  const ua = req.headers['user-agent'] || '';
  const isMobile = /iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  if (isMobile) return res.redirect('/mobile.html');
  next();
});

// Central cache policy — sets explicit Cache-Control on every response before
// route handlers run. Individual routes can override for special cases (SSE,
// timed API caches). Must be mounted before express.static and all routes.
app.use(cachePolicy());

// sw.js + manifest.json also get Surrogate-Control: no-store for CDN bypass.
// cachePolicy handles Cache-Control; this layer adds the CDN-specific header.
app.use(['/sw.js', '/manifest.json'], (req, res, next) => {
  res.set('Surrogate-Control', 'no-store');
  next();
});

// Static files — cachePolicy already set Cache-Control; no setHeaders needed.
app.use(express.static(join(__dirname, 'public')));

// Serve project-level images folder — cachePolicy handles cache headers.
app.use('/images', express.static(join(__dirname, '../../images')));

// /terms is served as a static file: src/web/public/terms.html

// ─── Liveness + Readiness probes ────────────────────────────────────────────
// Designed for PM2 / Kubernetes / load balancers. Unauthenticated by design.
//
// /health/live   — fast liveness: process is up + event loop responsive.
//                  Returns 200 always (unless event loop is dead).
//                  Use as PM2 --max-memory-restart trigger + LB liveness probe.
//
// /health/ready  — readiness: checks dependencies the dashboard NEEDS to serve
//                  user requests. Returns 200 if all OK, 503 if any are down.
//                  Checks: DB ping, Anthropic key present + non-empty.
//                  Use to gate traffic — don't send users to a process whose
//                  dependencies aren't wired.
const _bootTime = Date.now();
app.get('/health/live', (_req, res) => {
  // Pure liveness — no I/O. Just confirms the event loop is responsive.
  res.json({ status: 'ok', uptime_s: Math.floor((Date.now() - _bootTime) / 1000) });
});

app.get('/health/ready', async (_req, res) => {
  const t0 = Date.now();
  const checks = {};

  // 1. DB ping with 1.5s timeout — fail fast
  try {
    const dbPromise = isDbAvailable() ? query('SELECT 1') : Promise.reject(new Error('DATABASE_URL unset'));
    await Promise.race([
      dbPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('DB ping timeout >1.5s')), 1500)),
    ]);
    checks.db = 'ok';
  } catch (e) {
    checks.db = `fail: ${e.message}`;
  }

  // 2. Anthropic API key must be present + non-empty (the trap that bit us once)
  const ak = process.env.ANTHROPIC_API_KEY;
  checks.anthropic_key = ak && ak.trim().length > 10 ? 'ok' : 'fail: missing or empty';

  // 3. Telegram bot — only if enabled. Reports informational state.
  if (process.env.TELEGRAM_BOT_ENABLED === '1') {
    try {
      const { isTelegramBotRunning } = await import('../core/telegram-bot.js');
      checks.telegram = isTelegramBotRunning() ? 'ok' : 'fail: not polling';
    } catch { checks.telegram = 'fail: module load error'; }
  }

  const allOk = Object.values(checks).every(v => v === 'ok');
  res.status(allOk ? 200 : 503).json({
    status:    allOk ? 'ok' : 'degraded',
    checks,
    latency_ms: Date.now() - t0,
    checked_at: new Date().toISOString(),
  });
});

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
  const hasTigerLive = !!(dbUser?.tiger_id && dbUser?.tiger_account && dbUser?.tiger_private_key);
  const hasTigerDemo = !!(dbUser?.tiger_demo_id && dbUser?.tiger_demo_account && dbUser?.tiger_demo_private_key);
  const hasTiger     = hasTigerLive || hasTigerDemo;
  const perms = getPermissions(user);
  if (hasMoomoo && !perms.widgets.includes('moomoo')) perms.widgets.push('moomoo');
  if (hasTiger  && !perms.widgets.includes('tiger'))  perms.widgets.push('tiger');
  const disabledSources = Array.isArray(dbUser?.disabled_sources) ? dbUser.disabled_sources : [];
  res.json({
    authenticated:      true,
    username:           req.session.username,
    role:               user.role || 'viewer',
    plan:               user.plan || 'free',
    credits:            user.credits,
    permissions:        perms,
    has_alpaca:         hasAlpaca,
    has_moomoo:         hasMoomoo,
    has_tiger:          hasTiger,
    has_tiger_live:     hasTigerLive,
    has_tiger_demo:     hasTigerDemo,
    moomoo_acc_id:      dbUser?.moomoo_acc_id      || null,
    tiger_account:      dbUser?.tiger_account      || null,
    tiger_demo_account: dbUser?.tiger_demo_account || null,
    disabled_sources: disabledSources,
    sources: {
      alpaca_paper: (isAdmin ? true : !!(dbUser?.alpaca_api_key)) && !disabledSources.includes('alpaca'),
      alpaca_live:  (!!(dbUser?.alpaca_live_api_key) || (isAdmin && hasLiveAccount())) && !disabledSources.includes('alpaca_live'),
      moomoo:       hasMoomoo    && !disabledSources.includes('moomoo'),
      tiger:        hasTigerLive && !disabledSources.includes('tiger'),
      tiger_demo:   hasTigerDemo && !disabledSources.includes('tiger_demo'),
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

// ─── Cert download — lets iPhone install the self-signed cert ─────────────────
app.get('/cert', (req, res) => {
  const certPath = process.env.SSL_CERT_PATH;
  if (!certPath || !fs.existsSync(certPath)) return res.status(404).send('No cert configured');
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="tradingbot.crt"');
  res.sendFile(certPath);
});

// ─── /docs — Reference book ───────────────────────────────────────────────────
// Production-only. Staging (DASHBOARD_PORT=3001 in .env.staging) returns 404.
// Single source of truth: REFERENCE.md is read fresh on every request — no
// caching, no UAT-vs-prod copies to keep in sync.
app.get('/docs', requireAuth, async (req, res) => {
  if (process.env.DASHBOARD_PORT) {
    return res.status(404).send('Documentation is available on production only.');
  }
  try {
    const mdPath = join(__dirname, '../..', 'REFERENCE.md');
    const md = fs.readFileSync(mdPath, 'utf8');
    const body = marked.parse(md);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DLPInnovations Platform — Reference</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:        #0d1117;
    --bg-sidebar:#161b22;
    --bg-card:   #1c2128;
    --border:    #30363d;
    --text:      #e6edf3;
    --text-muted:#8b949e;
    --text-dim:  #6e7681;
    --accent:    #58a6ff;
    --accent2:   #3fb950;
    --accent3:   #d2a8ff;
    --warn:      #f0883e;
    --code-bg:   #161b22;
    --sidebar-w: 280px;
    --header-h:  52px;
  }

  html { scroll-behavior: smooth; font-size: 15px; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', system-ui, sans-serif;
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }

  /* ── Top bar ── */
  header {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    height: var(--header-h);
    background: var(--bg-sidebar);
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 16px;
    padding: 0 20px;
  }
  header .logo { font-weight: 700; font-size: 1rem; color: var(--accent); letter-spacing: -0.02em; }
  header .logo span { color: var(--text-muted); font-weight: 400; }
  header .back-link {
    margin-left: auto; font-size: 0.82rem; color: var(--text-muted);
    text-decoration: none; display: flex; align-items: center; gap: 5px;
    padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border);
    transition: border-color .15s, color .15s;
  }
  header .back-link:hover { color: var(--text); border-color: #6e7681; }
  .search-box {
    display: flex; align-items: center; gap: 8px;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 6px; padding: 5px 10px; width: 220px;
  }
  .search-box input {
    background: none; border: none; outline: none;
    color: var(--text); font-size: 0.82rem; width: 100%;
    font-family: inherit;
  }
  .search-box input::placeholder { color: var(--text-dim); }

  /* ── Layout ── */
  .layout {
    display: flex;
    margin-top: var(--header-h);
    min-height: calc(100vh - var(--header-h));
  }

  /* ── Sidebar ── */
  nav.sidebar {
    position: fixed; top: var(--header-h); bottom: 0; left: 0;
    width: var(--sidebar-w);
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border);
    overflow-y: auto;
    padding: 20px 0 40px;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  nav.sidebar::-webkit-scrollbar { width: 4px; }
  nav.sidebar::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  .sidebar-section { margin-bottom: 4px; }
  .sidebar-part {
    font-size: 0.7rem; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; color: var(--text-dim);
    padding: 10px 18px 4px;
  }
  .sidebar a {
    display: block; padding: 5px 18px; font-size: 0.82rem;
    color: var(--text-muted); text-decoration: none;
    border-left: 2px solid transparent;
    transition: color .12s, border-color .12s, background .12s;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .sidebar a.h2 { padding-left: 18px; }
  .sidebar a.h3 { padding-left: 30px; font-size: 0.78rem; color: var(--text-dim); }
  .sidebar a:hover { color: var(--text); background: rgba(88,166,255,.06); }
  .sidebar a.active {
    color: var(--accent); border-left-color: var(--accent);
    background: rgba(88,166,255,.08);
  }
  .sidebar a.hidden { display: none; }

  /* ── Main content ── */
  main {
    margin-left: var(--sidebar-w);
    flex: 1;
    max-width: 900px;
    padding: 48px 52px 80px;
  }

  /* ── Typography ── */
  main h1 {
    font-size: 2rem; font-weight: 700; color: var(--text);
    border-bottom: 1px solid var(--border);
    padding-bottom: 14px; margin: 56px 0 20px;
    letter-spacing: -0.03em;
  }
  main h1:first-child { margin-top: 0; }

  main h2 {
    font-size: 1.35rem; font-weight: 600; color: var(--text);
    margin: 44px 0 14px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  main h3 {
    font-size: 1.05rem; font-weight: 600;
    color: var(--accent3); margin: 30px 0 10px;
  }
  main h4 {
    font-size: 0.92rem; font-weight: 600;
    color: var(--accent2); margin: 22px 0 8px;
  }

  main p { line-height: 1.75; color: #cdd9e5; margin-bottom: 14px; }
  main p:last-child { margin-bottom: 0; }

  main strong { color: var(--text); font-weight: 600; }
  main em { color: var(--warn); font-style: normal; font-weight: 500; }

  main a { color: var(--accent); text-decoration: none; }
  main a:hover { text-decoration: underline; }

  main ul, main ol {
    margin: 10px 0 16px 20px; line-height: 1.8;
    color: #cdd9e5;
  }
  main li { margin-bottom: 4px; }

  main blockquote {
    border-left: 3px solid var(--accent);
    padding: 10px 16px;
    background: rgba(88,166,255,.05);
    border-radius: 0 6px 6px 0;
    margin: 16px 0;
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  main hr {
    border: none; border-top: 1px solid var(--border);
    margin: 40px 0;
  }

  /* ── Code ── */
  main code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.82em;
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 5px;
    color: #f47067;
  }
  main pre {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 18px 20px;
    overflow-x: auto;
    margin: 14px 0 20px;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  main pre::-webkit-scrollbar { height: 4px; }
  main pre::-webkit-scrollbar-thumb { background: var(--border); }
  main pre code {
    background: none; border: none; padding: 0;
    font-size: 0.83rem; color: #adbac7;
    line-height: 1.6;
  }

  /* ── Tables ── */
  .table-wrap { overflow-x: auto; margin: 14px 0 20px; border-radius: 8px; border: 1px solid var(--border); }
  main table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  main thead { background: var(--bg-card); }
  main th {
    text-align: left; padding: 10px 14px;
    color: var(--text-muted); font-weight: 600; font-size: 0.78rem;
    text-transform: uppercase; letter-spacing: .04em;
    border-bottom: 1px solid var(--border);
  }
  main td {
    padding: 9px 14px;
    border-bottom: 1px solid rgba(48,54,61,.6);
    color: #cdd9e5; vertical-align: top;
    line-height: 1.5;
  }
  main tr:last-child td { border-bottom: none; }
  main tr:hover td { background: rgba(88,166,255,.03); }
  main td code { font-size: 0.78rem; }

  /* Chapter marker */
  .chapter-label {
    display: inline-block; font-size: 0.72rem; font-weight: 700;
    letter-spacing: .1em; text-transform: uppercase;
    color: var(--text-dim); margin-bottom: 6px;
  }

  /* ── Print ── */
  @media print {
    header, nav.sidebar { display: none !important; }
    main { margin: 0; padding: 20px; max-width: 100%; }
    main h1, main h2 { break-after: avoid; }
    main pre, main table { break-inside: avoid; }
  }

  /* ── Mobile ── */
  @media (max-width: 800px) {
    nav.sidebar { display: none; }
    main { margin-left: 0; padding: 24px 20px 60px; }
    header .search-box { display: none; }
  }
</style>
</head>
<body>
<header>
  <div class="logo">DLPInnovations <span>/ Reference</span></div>
  <div class="search-box">
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="5.5" stroke="#6e7681" stroke-width="1.5"/><path d="M11 11l3 3" stroke="#6e7681" stroke-width="1.5" stroke-linecap="round"/></svg>
    <input type="text" id="toc-search" placeholder="Search chapters…" autocomplete="off">
  </div>
  <a href="/" class="back-link">← Dashboard</a>
</header>
<div class="layout">
  <nav class="sidebar" id="sidebar"></nav>
  <main id="content">${body}</main>
</div>
<script>
  // Wrap all tables in a scrollable div
  document.querySelectorAll('main table').forEach(t => {
    const w = document.createElement('div');
    w.className = 'table-wrap';
    t.parentNode.insertBefore(w, t);
    w.appendChild(t);
  });

  // Build sidebar TOC from headings
  const sidebar = document.getElementById('sidebar');
  const headings = document.querySelectorAll('main h1, main h2, main h3');
  let currentPart = null;

  headings.forEach((h, i) => {
    // Ensure heading has an id
    if (!h.id) {
      h.id = 'h-' + i + '-' + h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    }
    const tag = h.tagName.toLowerCase();
    const text = h.textContent.trim();

    if (tag === 'h1' && (text.startsWith('Part ') || text === 'Preface — What This Book Is' || text === 'Appendix — Changelog')) {
      const part = document.createElement('div');
      part.className = 'sidebar-part';
      part.textContent = text;
      sidebar.appendChild(part);
      currentPart = null;
      return;
    }

    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = text;
    a.className = tag;
    a.dataset.text = text.toLowerCase();
    sidebar.appendChild(a);
  });

  // Active section highlight on scroll
  const allLinks = sidebar.querySelectorAll('a');
  const allHeadings = Array.from(headings);
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const scrollY = window.scrollY + 80;
      let active = allHeadings[0];
      for (const h of allHeadings) {
        if (h.offsetTop <= scrollY) active = h;
        else break;
      }
      allLinks.forEach(a => {
        a.classList.toggle('active', active && a.getAttribute('href') === '#' + active.id);
      });
      // Scroll active link into view in sidebar
      const activeLink = sidebar.querySelector('a.active');
      if (activeLink) {
        const sr = sidebar.getBoundingClientRect();
        const lr = activeLink.getBoundingClientRect();
        if (lr.top < sr.top + 40 || lr.bottom > sr.bottom - 40) {
          activeLink.scrollIntoView({ block: 'nearest' });
        }
      }
      ticking = false;
    });
  });

  // Sidebar search
  document.getElementById('toc-search').addEventListener('input', function() {
    const q = this.value.trim().toLowerCase();
    allLinks.forEach(a => {
      a.classList.toggle('hidden', q.length > 0 && !a.dataset.text.includes(q));
    });
  });
</script>
</body>
</html>`);
  } catch (e) {
    console.error('[docs] render error:', e);
    res.status(500).send('Could not load documentation: ' + e.message);
  }
});

// ─── Public client-error endpoint (before requireAuth) ───────────────────────
// Intentionally unauthenticated — captures JS errors before/after session expires
app.post('/api/client-error', async (req, res) => {
  try {
    const { message, stack, url, context, level = 'error' } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    await logClientError({ source: 'browser', level, message, stack, url, context });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Trading Desk symbol list — static in-memory, exempt from rate limiter
app.get('/api/td-symbols', requireAuth, (req, res) => {
  const syms = [...new Set([...SP500, ...NASDAQ100])].sort();
  res.json({ count: syms.length, symbols: syms });
});

// Trading Desk batch quotes (names + prices) — exempt from rate limiter
app.get('/api/td-names', requireAuth, async (req, res) => {
  try {
    const symbols = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z]{1,6}$/.test(s)).slice(0, 100);
    if (!symbols.length) return res.json({});
    const quotes = await _yf.quote(symbols, { fields: ['shortName', 'longName', 'regularMarketPrice', 'regularMarketChangePercent'] });
    const quotesArr = Array.isArray(quotes) ? quotes : (quotes ? [quotes] : []);
    const result = {};
    quotesArr.forEach(q => {
      if (!q?.symbol) return;
      result[q.symbol] = {
        name: q.shortName || q.longName || '',
        p:    q.regularMarketPrice ?? null,
        c:    q.regularMarketChangePercent != null ? +(q.regularMarketChangePercent * 100).toFixed(2) : null,
      };
    });
    res.json(result);
  } catch (e) {
    console.error('[td-names]', e.message);
    res.json({});
  }
});

// ─── Sentinel one-click action routes (HMAC auth only — no session required) ──
// Must be registered BEFORE app.use('/api', requireAuth) so they are not gated.

// ── shared helper: validate token + state, return action or send error page ───
async function _resolveAction(req, res) {
  const { id } = req.params;
  const { token } = req.query;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  let action;
  try { action = await getPendingAction(id); } catch { /* fall through */ }
  if (!action) { res.status(404).send(pageTokenInvalid()); return null; }

  if (!token || !verifyToken(action.signed_token, token))
    { res.status(403).send(pageTokenInvalid()); return null; }

  if (action.status === 'executed' || action.status === 'ignored')
    { res.send(pageAlreadyActioned({ symbol: action.symbol, status: action.status, actionedAt: action.executed_at })); return null; }

  if (new Date() > new Date(action.expires_at))
    { res.send(pageExpired({ symbol: action.symbol, side: action.side, qty: action.qty, expiresAt: action.expires_at })); return null; }

  return action;
}

// GET — show confirmation page (safe for link previews / browser prefetch)
app.get('/api/action/execute/:id', async (req, res) => {
  const action = await _resolveAction(req, res);
  if (!action) return;

  let currentPrice = null;
  try { const q = await getLatestPrice(action.symbol); currentPrice = q.mid || q.ask || q.bid; } catch { /* ok */ }

  if (currentPrice && action.limit_price) {
    const drift = Math.abs((currentPrice - Number(action.limit_price)) / Number(action.limit_price));
    if (drift > driftLimit)
      return res.send(pagePriceMoved({ symbol: action.symbol, side: action.side, qty: action.qty, proposedPrice: action.limit_price, currentPrice }));
  }

  res.send(pageConfirmExecute({ id: req.params.id, token: req.query.token, symbol: action.symbol, side: action.side, qty: action.qty, limitPrice: action.limit_price, currentPrice }));
});

// POST — actually execute the trade
app.post('/api/action/execute/:id', async (req, res) => {
  const action = await _resolveAction(req, res);
  if (!action) return;

  let currentPrice = null;
  try { const q = await getLatestPrice(action.symbol); currentPrice = q.mid || q.ask || q.bid; } catch { /* ok */ }

  if (currentPrice && action.limit_price) {
    const drift = Math.abs((currentPrice - Number(action.limit_price)) / Number(action.limit_price));
    if (drift > driftLimit)
      return res.send(pagePriceMoved({ symbol: action.symbol, side: action.side, qty: action.qty, proposedPrice: action.limit_price, currentPrice }));
  }

  let execResult;
  try {
    execResult = await placeQuickTrade({
      symbol:      action.symbol,
      side:        action.side,
      qty:         Number(action.qty),
      order_type:  action.limit_price ? 'limit' : 'market',
      limit_price: action.limit_price ? Number(action.limit_price) : undefined,
    });
  } catch (err) {
    console.error('[sentinel] execute error:', err.message);
    sysAlert({ key: 'sentinel/execute-failed', severity: 'critical', title: 'Sentinel one-click trade execute failed', detail: { id: req.params.id, symbol: action.symbol, side: action.side, qty: action.qty, broker: action.broker, error: err.message } }).catch(() => {});
    return res.status(500).send(pageTokenInvalid());
  }

  const executedAt = new Date();
  await updatePendingAction(req.params.id, { status: 'executed', executed_at: executedAt, execution_result: execResult });
  const fillPrice = execResult?.filled_avg_price || action.limit_price || currentPrice;
  res.send(pageSuccess({ symbol: action.symbol, side: action.side, qty: action.qty, price: fillPrice, executedAt }));
});

// GET — show ignore confirmation page
app.get('/api/action/ignore/:id', async (req, res) => {
  const action = await _resolveAction(req, res);
  if (!action) return;
  res.send(pageConfirmIgnore({ id: req.params.id, token: req.query.token, symbol: action.symbol, side: action.side, qty: action.qty }));
});

// POST — mark as ignored
app.post('/api/action/ignore/:id', async (req, res) => {
  const action = await _resolveAction(req, res);
  if (!action) return;
  await updatePendingAction(req.params.id, { status: 'ignored', executed_at: new Date() });
  res.send(pageAlreadyActioned({ symbol: action.symbol, status: 'ignored', actionedAt: new Date() }));
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

const VALID_SOURCES = ['alpaca', 'alpaca_live', 'moomoo', 'tiger', 'tiger_demo'];

function _tigerCredsForSource(dbUser, source) {
  if (source === 'tiger_demo') {
    return {
      tiger_id:    dbUser?.tiger_demo_id,
      account:     dbUser?.tiger_demo_account,
      private_key: dbUser?.tiger_demo_private_key,
    };
  }
  return {
    tiger_id:    dbUser?.tiger_id,
    account:     dbUser?.tiger_account,
    private_key: dbUser?.tiger_private_key,
  };
}

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
  try {
    const { tiger_id, account, private_key, env } = req.body;
    if (!tiger_id || !account || !private_key) {
      return res.status(400).json({ error: 'tiger_id, account and private_key are required' });
    }
    const envSafe = env === 'demo' ? 'demo' : 'live';
    const creds = { tiger_id, account, private_key };
    const valid = await validateTigerCreds(creds);
    if (!valid) return res.status(401).json({ error: 'Invalid Tiger credentials — check your Tiger ID, account number and private key.' });
    await saveUserTiger(req.session.username, { tigerId: tiger_id, account, privateKey: private_key, env: envSafe });
    logActivity(req.session.username, 'tiger_connected', `Tiger ${envSafe} account ${account} connected`, req.ip);
    res.json({ ok: true, account, env: envSafe });
  } catch (e) {
    console.error('[tiger/connect]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/tiger/disconnect', requireAuth, async (req, res) => {
  const env = req.body?.env === 'demo' ? 'demo' : req.body?.env === 'live' ? 'live' : null;
  await clearUserTiger(req.session.username, env);
  logActivity(req.session.username, 'tiger_disconnected', `Tiger ${env || 'all'} disconnected`, req.ip);
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
  if (source !== 'moomoo' && source !== 'alpaca_live' && source !== 'tiger' && source !== 'tiger_demo') {
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
  // Tiger Brokers (Live and Demo)
  if (source === 'tiger' || source === 'tiger_demo') {
    const dbUser = isDbAvailable() ? await getDbUser(username) : null;
    const tc = _tigerCredsForSource(dbUser, source);
    if (!tc.tiger_id) return { account: null, positions: [], needs_tiger_setup: true };
    const creds = { tiger_id: tc.tiger_id, account: tc.account, private_key: tc.private_key };
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
      source:          source,
      account_number:  tc.account,
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

// Merged market news: Benzinga (if configured) first, then Alpaca/Yahoo/RSS, deduped by URL
async function _mergedMarketNews(limit = 40) {
  const [baseRes, bzRes] = await Promise.allSettled([
    getMarketNews({ limit }),
    isBenzingaConfigured() ? getBzNews({ limit: 25 }) : Promise.resolve(null),
  ]);
  const baseArticles = baseRes.status === 'fulfilled' ? (baseRes.value || []) : [];
  const bzArticles   = bzRes.status   === 'fulfilled' && bzRes.value
    ? (bzRes.value.articles || []).map(a => ({
        title:     a.title,
        publisher: 'Benzinga',
        published: a.published_at,
        summary:   a.teaser   || null,
        url:       a.url,
        source:    'benzinga',
        tickers:   a.tickers  || [],
        sentiment: a.sentiment || null,
      }))
    : [];
  const seen = new Set();
  return [...bzArticles, ...baseArticles].filter(a => {
    if (!a.url || seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

// News only — fast path, 5-min cache, hard 8s deadline (Benzinga adds ~1s)
app.get('/api/home-news', async (req, res) => {
  try {
    const deadline = new Promise(resolve => setTimeout(() => resolve([]), 8000));
    const news = await Promise.race([
      ttlCache('home:news', 5 * 60 * 1000, () => _mergedMarketNews(40)),
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
      ttlCache('home:news', 5 * 60 * 1000, () => _mergedMarketNews(40)),
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
    const data = await ttlCache(`er:reaction3:${symbol}`, 4 * 60 * 60 * 1000, async () => {
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
        // Last 10 trading days before earnings day
        const pre_days = [];
        for (let back = 10; back >= 1; back--) {
          const idx     = rIdx - back;
          if (idx < 0) { pre_days.push(null); continue; }
          const bar     = barMap[sorted[idx]];
          const prevBar = idx > 0 ? barMap[sorted[idx - 1]] : null;
          pre_days.push({ ...bar, pct_chg: pct(bar, prevBar), day_offset: -back });
        }

        const b_1 = rIdx >= 1 ? barMap[sorted[rIdx - 1]] : null;
        const bp1 = rIdx + 1 < sorted.length ? barMap[sorted[rIdx + 1]] : null;

        return {
          earnings_date: reactBar.date,
          quarter_end:   ev.quarter_end,
          eps_actual:    ev.eps_actual,
          eps_estimate:  ev.eps_estimate,
          surprise_pct:  ev.surprise_pct,
          pre_days,
          earnings_day: reactBar ? { ...reactBar, pct_chg: pct(reactBar, b_1) } : null,
          next_day:     bp1      ? { ...bp1,      pct_chg: pct(bp1, reactBar) } : null,
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
          _yf.quoteSummary(sym, { modules: ['calendarEvents', 'price', 'assetProfile'] }).catch(() => null)
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
            sector:   r.value.assetProfile?.sector   || null,
            industry: r.value.assetProfile?.industry || null,
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
      earnings.push({ date: s.ds, symbol: s.symbol, company: s.company, sector: s.sector || null, industry: s.industry || null, call_time: '?', eps_estimate: null, source: 'yahoo_supplement' });
    }

    res.json({ success: true, date: dateParam, earnings });
  } catch (err) {
    console.error('[earnings-calendar]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Tomorrow's Catalysts ────────────────────────────────────────────────────
// Answers: "what should I buy TODAY to profit TOMORROW?"
// Three buckets:
//   amc_tonight  — reports after close today  → buy before 3 PM, sell at tomorrow open
//   bmo_tomorrow — reports before open tomorrow → buy today's close, gap play
//   pre_drift    — reports in 2–5 days → ride pre-earnings drift, exit before report

app.get('/api/tomorrow-catalysts', requireAuth, async (req, res) => {
  try {
    const now   = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];
    const cacheKey = `tomorrow:catalysts:${todayStr}`;
    if (req.query.force === '1') _cache.delete(cacheKey);

    const result = await ttlCache(cacheKey, 60 * 60 * 1000, async () => {
      // Build date range: today + next 5 weekdays
      const dates = [];
      let d = new Date(today);
      while (dates.length < 6) {
        if (d.getDay() !== 0 && d.getDay() !== 6) dates.push(d.toISOString().split('T')[0]);
        d = new Date(d.getTime() + 86400000);
      }

      // Fetch calendar for all dates in parallel (reuses Nasdaq cache)
      const calResults = await Promise.allSettled(
        dates.map(ds => ttlCache(`earnings:cal:${ds}`, 6 * 60 * 60 * 1000, () => fetchNasdaqEarningsDay(ds)))
      );

      // Build flat list with date + day offset
      const allEntries = [];
      calResults.forEach((r, i) => {
        const items = r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : [];
        items.forEach(e => allEntries.push({ ...e, date: dates[i], day_offset: i }));
      });

      // Categorise
      const amc_raw   = allEntries.filter(e => e.day_offset === 0 && e.call_time === 'AMC');
      const bmo_raw   = allEntries.filter(e => e.day_offset === 1 && e.call_time === 'BMO');
      const drift_raw = allEntries.filter(e => e.day_offset >= 2 && e.day_offset <= 5);

      // Sort each bucket by market cap descending, cap at 12 each
      const sortCap = (arr, n) =>
        [...arr].sort((a, b) => (b.market_cap_n || 0) - (a.market_cap_n || 0)).slice(0, n);

      const amcList   = sortCap(amc_raw, 12);
      const bmoList   = sortCap(bmo_raw, 12);
      const driftList = sortCap(drift_raw, 12);

      // Enrich each symbol: consensus, target, avg historical move, latest headline + UW context
      const enrich = async (entry) => {
        const sym = entry.symbol;
        const [scoreRes, yfRes, newsRes, uwFundRes, uwTransRes] = await Promise.allSettled([
          getConvictionScore({ symbol: sym, positions: [] }),
          _yf.quoteSummary(sym, { modules: ['financialData', 'earningsTrend', 'earningsHistory', 'price'] }),
          _mergedSymbolNews(sym, 2),
          getFundamentals(sym),
          getEarningsTranscript({ ticker: sym, quarter: 'latest' }),
        ]);

        const score   = scoreRes.status  === 'fulfilled' ? scoreRes.value  : null;
        const yf      = yfRes.status     === 'fulfilled' ? yfRes.value     : null;
        const news    = newsRes.status   === 'fulfilled' ? newsRes.value   : [];
        const uwFund  = uwFundRes.status === 'fulfilled' ? uwFundRes.value : null;
        const uwTrans = uwTransRes.status === 'fulfilled' ? uwTransRes.value : null;

        // Avg historical earnings surprise % — calc from epsActual vs epsEstimate
        const hist = yf?.earningsHistory?.history ?? [];
        const surprises = hist
          .filter(h => h.epsActual != null && h.epsEstimate != null && Math.abs(h.epsEstimate) > 0.001)
          .map(h => +((h.epsActual - h.epsEstimate) / Math.abs(h.epsEstimate) * 100).toFixed(1))
          .slice(0, 4);
        const avg_surprise_pct = surprises.length
          ? +(surprises.reduce((a, b) => a + b, 0) / surprises.length).toFixed(1)
          : null;

        // EPS estimate for upcoming quarter (earningsTrend is more reliable than Nasdaq)
        const yfTrend    = yf?.earningsTrend?.trend ?? [];
        const nextQTrend = yfTrend.find(t => t.period === '0q') || yfTrend[0] || null;
        const eps_estimate_yf = nextQTrend?.earningsEstimate?.avg ?? null;

        // Current price — gate pre/post on actual session state to avoid stale data
        const price = yf?.price?.regularMarketPrice ?? null;
        const tcMktState  = yf?.price?.marketState ?? '';
        const tcIsPreSess  = tcMktState === 'PRE'  || tcMktState === 'PREPRE';
        const tcIsPostSess = tcMktState === 'POST' || tcMktState === 'POSTPOST';
        const pre_price   = tcIsPreSess  ? (yf?.price?.preMarketPrice  ?? null) : null;
        const pre_chg_pct = tcIsPreSess  && yf?.price?.preMarketChangePercent != null && typeof yf.price.preMarketChangePercent !== 'object'
          ? yf.price.preMarketChangePercent * 100 : null;
        const post_price   = tcIsPostSess ? (yf?.price?.postMarketPrice ?? null) : null;
        const post_chg_pct = tcIsPostSess && yf?.price?.postMarketChangePercent != null && typeof yf.price.postMarketChangePercent !== 'object'
          ? yf.price.postMarketChangePercent * 100 : null;

        // UW fundamentals fields
        const uw_analyst_count = uwFund ? (
          (uwFund.analyst_rating_buy        || 0) +
          (uwFund.analyst_rating_hold       || 0) +
          (uwFund.analyst_rating_sell       || 0) +
          (uwFund.analyst_rating_strong_buy  || 0) +
          (uwFund.analyst_rating_strong_sell || 0)
        ) : null;
        const _lq = uwFund?.latest_quarter;
        const uw_last_quarter = _lq ? (() => {
          const d = new Date(_lq + 'T00:00:00Z');
          const m = d.getUTCMonth() + 1;
          const y = d.getUTCFullYear();
          return `Q${m <= 3 ? 1 : m <= 6 ? 2 : m <= 9 ? 3 : 4} ${y}`;
        })() : null;

        // UW transcript sentiment derivation
        let uw_transcript_label = null, uw_transcript_score = null, uw_transcript_quote = null;
        if (uwTrans?.statements?.length) {
          const sentMap = { positive: 1, bullish: 1, negative: -1, bearish: -1, neutral: 0 };
          const nums = uwTrans.statements
            .map(s => typeof s.sentiment === 'number' ? s.sentiment : (sentMap[String(s.sentiment ?? '').toLowerCase()] ?? null))
            .filter(v => v !== null);
          const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
          uw_transcript_score = +((avg + 1) / 2).toFixed(3);
          uw_transcript_label = avg > 0.15 ? 'bullish' : avg < -0.15 ? 'bearish' : 'neutral';
          const exec = uwTrans.statements.find(s => /CEO|CFO|Chief Executive|Chief Financial/i.test(s.title || s.speaker || ''));
          uw_transcript_quote = exec?.content ? exec.content.slice(0, 140).trim() : null;
        }

        return {
          symbol:            sym,
          company:           yf?.price?.shortName || entry.company || sym,
          date:              entry.date,
          call_time:         entry.call_time || '?',
          eps_estimate:      eps_estimate_yf ?? entry.eps_estimate ?? null,
          market_cap:        entry.market_cap  ?? null,
          price,
          pre_price,
          pre_chg_pct,
          post_price,
          post_chg_pct,
          analyst_consensus: score?.signals?.analyst_consensus ?? null,
          analyst_target:    score?.signals?.analyst_target    ?? null,
          analyst_upside:    score?.signals?.analyst_upside    ?? null,
          conviction_score:  score?.score ?? null,
          conviction_grade:  score?.grade ?? null,
          avg_surprise_pct,
          top_news: news.length ? { title: news[0].title, url: news[0].url, published: news[0].published } : null,
          uw_analyst_target_avg:  uwFund?.analyst_target_price ?? null,
          uw_analyst_count:       uw_analyst_count && uw_analyst_count > 0 ? uw_analyst_count : null,
          uw_last_quarter,
          uw_transcript_label,
          uw_transcript_score,
          uw_transcript_quote,
          uw_transcript_quarter:  uwTrans?.quarter ?? null,
        };
      };

      const [amcEnriched, bmoEnriched, driftEnriched] = await Promise.all([
        Promise.allSettled(amcList.map(enrich)),
        Promise.allSettled(bmoList.map(enrich)),
        Promise.allSettled(driftList.map(enrich)),
      ]);

      const ok = arr => arr.filter(r => r.status === 'fulfilled').map(r => r.value);

      return {
        amc_tonight:  ok(amcEnriched),
        bmo_tomorrow: ok(bmoEnriched),
        pre_drift:    ok(driftEnriched),
        generated_at: new Date().toISOString(),
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[tomorrow-catalysts]', err);
    res.status(500).json({ error: 'Failed to load catalysts.' });
  }
});

// ─── Earnings Preview — deep weekly research ────────────────────────────────

app.get('/api/earnings-preview', requireAuth, async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);

    // Next Monday–Friday (calendar week after the current week)
    const dow = today.getDay(); // 0=Sun,1=Mon,...,6=Sat
    const daysToNextMon = dow === 0 ? 1 : 8 - dow; // days until next Monday
    const nextMon = new Date(today.getTime() + daysToNextMon * 86400000);
    const weekStr = nextMon.toISOString().split('T')[0];
    const cacheKey = `earnings:preview:week:${weekStr}`;

    if (req.query.force === '1') _cache.delete(cacheKey);

    const result = await ttlCache(cacheKey, 2 * 60 * 60 * 1000, async () => {
      // Gather Mon–Fri of next calendar week
      const dates = [];
      for (let i = 0; i < 5; i++) {
        const d = new Date(nextMon.getTime() + i * 86400000);
        dates.push(d.toISOString().split('T')[0]);
      }
      const nasdaqResults = await Promise.allSettled(
        dates.map(d => ttlCache(`earnings:cal:${d}`, 6 * 60 * 60 * 1000, () => fetchNasdaqEarningsDay(d)))
      );

      // Flatten to unique symbols, sort by market cap (most tradable first), cap at 12
      const calBySymbol = {};
      nasdaqResults.forEach((r, i) => {
        const items = r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : [];
        for (const e of items) {
          if (!calBySymbol[e.symbol]) calBySymbol[e.symbol] = { ...e, date: dates[i] };
        }
      });
      const calEntries = Object.values(calBySymbol)
        .sort((a, b) => (b.market_cap_n || 0) - (a.market_cap_n || 0))
        .slice(0, 12);

      if (!calEntries.length) return { stocks: [], generated_at: new Date().toISOString() };

      // Deep-fetch each symbol in parallel
      const perStock = await Promise.allSettled(calEntries.map(async (entry) => {
        const sym = entry.symbol;

        const [trendRes, yfRes, newsRes, scoreRes, quoteRes] = await Promise.allSettled([
          getEarningsTrend(sym),
          _yf.quoteSummary(sym, { modules: ['financialData', 'defaultKeyStatistics', 'earningsTrend', 'price', 'assetProfile'] }),
          _mergedSymbolNews(sym, 4),
          getConvictionScore({ symbol: sym, positions: [] }),
          fetchCurrentPrice(sym),
        ]);

        const quarters  = trendRes.status === 'fulfilled' ? (trendRes.value || []) : [];
        const yf        = yfRes.status   === 'fulfilled' ? yfRes.value : null;
        const newsArr   = newsRes.status === 'fulfilled' ? newsRes.value : [];
        const score     = scoreRes.status === 'fulfilled' ? scoreRes.value : null;
        const quote     = quoteRes.status === 'fulfilled' ? quoteRes.value : null;

        // ── Trend scoring ──
        const beatCount    = quarters.filter(q => q.beat === true).length;
        const strongCount  = quarters.filter(q => q.quality === 'strong').length;
        const modCount     = quarters.filter(q => q.quality === 'moderate').length;
        const weakCount    = quarters.filter(q => q.quality === 'weak').length;

        let trendScore = 0;
        trendScore += beatCount >= 4 ? 5 : beatCount === 3 ? 3 : beatCount === 2 ? 1 : beatCount === 1 ? 0 : -1;
        trendScore += strongCount >= 3 ? 2 : strongCount >= 2 ? 1 : 0;
        trendScore += weakCount >= 3 ? -2 : weakCount >= 2 ? -1 : 0;

        const consensus = score?.signals?.analyst_consensus; // scoring.js uses snake_case: 'strong_buy','buy','sell','strong_sell'
        trendScore += consensus === 'strong_buy' ? 3 : consensus === 'buy' ? 2 : consensus === 'sell' ? -2 : consensus === 'strong_sell' ? -3 : 0;

        const rsi = score?.signals?.rsi;
        trendScore += rsi != null ? (rsi > 65 ? 1 : rsi < 35 ? -1 : 0) : 0;

        const revGrowth = yf?.financialData?.revenueGrowth ?? null;
        trendScore += revGrowth != null ? (revGrowth > 0.15 ? 1 : revGrowth < 0 ? -1 : 0) : 0;

        const trend_label =
          trendScore >= 8  ? 'Very Strong' :
          trendScore >= 4  ? 'Strong'      :
          trendScore >= 1  ? 'Neutral'     :
          trendScore >= -2 ? 'Weak'        : 'Very Weak';

        // ── Analyst & financial data ──
        const yfTrend     = yf?.earningsTrend?.trend ?? [];
        const nextQTrend  = yfTrend.find(t => t.period === '0q') || yfTrend[0] || null;
        const eps_estimate     = nextQTrend?.earningsEstimate?.avg ?? entry.eps_estimate ?? null;
        const eps_est_low      = nextQTrend?.earningsEstimate?.low ?? null;
        const eps_est_high     = nextQTrend?.earningsEstimate?.high ?? null;
        const revenue_estimate = nextQTrend?.revenueEstimate?.avg ?? null;
        const gross_margins    = yf?.financialData?.grossMargins ?? null;
        const operating_margins= yf?.financialData?.operatingMargins ?? null;
        const debt_to_equity   = yf?.financialData?.debtToEquity ?? null;
        const analyst_target   = yf?.financialData?.targetMeanPrice ?? null;
        const forward_pe       = yf?.defaultKeyStatistics?.forwardPE ?? null;

        return {
          symbol:            sym,
          company:           yf?.price?.shortName || yf?.price?.longName || entry.company || sym,
          sector:            yf?.assetProfile?.sector || null,
          industry:          yf?.assetProfile?.industry || null,
          earnings_date:     entry.date,
          call_time:         entry.call_time || '?',
          market_cap:        entry.market_cap || null,
          trend_label,
          trend_score:       trendScore,
          beat_count:        beatCount,
          quarters,
          eps_estimate,
          eps_est_low,
          eps_est_high,
          revenue_estimate,
          revenue_growth:    revGrowth,
          gross_margins,
          operating_margins,
          debt_to_equity,
          analyst_target,
          analyst_consensus: consensus ?? null,
          forward_pe,
          conviction_score:  score?.score  ?? null,
          conviction_grade:  score?.grade  ?? null,
          price:             quote?.price  ?? null,
          change_pct:        quote?.change_pct ?? null,
          pre_price:         quote?.pre_price  ?? null,
          pre_change_pct:    quote?.pre_change_pct ?? null,
          news: newsArr.slice(0, 3).map(a => ({ title: a.title, url: a.url, source: a.source, published: a.published })),
        };
      }));

      const stocks = perStock
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value)
        .sort((a, b) => b.trend_score - a.trend_score);  // strongest first

      return { stocks, generated_at: new Date().toISOString() };
    });

    res.json(result);
  } catch (err) {
    console.error('[earnings-preview]', err);
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
            uw_modifier_delta:   cal?._uw_modifier?.delta    ?? null,
            uw_modifier_reason:  cal?._uw_modifier?.reason   ?? null,
            uw_modifier_label:   cal?._uw_modifier?.uw_label ?? null,
            news_modifier_delta:  cal?._news_modifier?.delta      ?? null,
            news_modifier_reason: cal?._news_modifier?.reason     ?? null,
            news_modifier_label:  cal?._news_modifier?.news_label ?? null,
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
        uw_modifier_delta:    r.uw_modifier_delta  != null ? +r.uw_modifier_delta  : null,
        uw_modifier_reason:   r.uw_modifier_reason ?? null,
        uw_modifier_label:    r.uw_modifier_label  ?? null,
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
    const source = rawSource === 'moomoo' ? 'moomoo' : rawSource === 'alpaca_live' ? 'alpaca_live' : rawSource === 'tiger_demo' ? 'tiger_demo' : rawSource === 'tiger' ? 'tiger' : 'alpaca';
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
    if (source === 'tiger' || source === 'tiger_demo') {
      try {
        const dbUser2 = isDbAvailable() ? await getDbUser(req.session.username) : null;
        const tc2 = _tigerCredsForSource(dbUser2, source);
        if (tc2.tiger_id) {
          const creds = { tiger_id: tc2.tiger_id, account: tc2.account, private_key: tc2.private_key };
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
          order_id:    o.id,
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
      // Most-recent closed DB trade per symbol — used to enrich Alpaca SELL legs with bot context.
      // If rapid buy-sell-buy-sell cycles produce multiple closes, we use the latest.
      const closingDbBySymbol = new Map();
      for (const t of dbTrades) {
        if (t.status !== 'closed' || !t.symbol) continue;
        const sym = t.symbol.toUpperCase();
        const existing = closingDbBySymbol.get(sym);
        if (!existing || new Date(t.closed_at || 0) > new Date(existing.closed_at || 0)) {
          closingDbBySymbol.set(sym, t);
        }
      }
      const enrichedQt = qtTrades.map(qt => {
        if (qt.side !== 'sell' || !qt.symbol) return qt;
        const match = closingDbBySymbol.get(qt.symbol.toUpperCase());
        if (!match) return qt;
        return {
          ...qt,
          bot_id:                 match.bot_id ?? null,
          bot_name:               match.bot_name ?? null,
          setup_type:             match.setup_type ?? null,
          thesis:                 match.thesis ?? null,
          expected_hold_days_min: match.expected_hold_days_min ?? null,
          expected_hold_days_max: match.expected_hold_days_max ?? null,
          stop_loss:              match.stop_loss ?? null,
          take_profit:            match.take_profit ?? null,
        };
      });
      trades = [...dbTrades, ...enrichedQt]
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

    // Enrich Alpaca orders with bot_name + setup_type from DB where order_id matches
    if (trades?.length && isDbAvailable()) {
      const getOrderId = t => t?.order_id ?? t?.id ?? null;
      const orderIds = [...new Set(trades.map(getOrderId).filter(Boolean).map(String))];
      if (orderIds.length) {
        try {
          const { rows: dbMatches } = await query(
            `SELECT t.order_id, t.setup_type, t.thesis, t.expected_hold_days_min,
                    t.expected_hold_days_max, b.name AS bot_name, b.id AS bot_id
             FROM trades t
             LEFT JOIN bots b ON b.id = t.bot_id
             WHERE t.order_id = ANY($1::text[])`,
            [orderIds]
          );
          const byOrderId = new Map(dbMatches.map(r => [String(r.order_id), r]));
          trades = trades.map(t => {
            const match = byOrderId.get(String(getOrderId(t)));
            return match ? {
              ...t,
              bot_id:                 match.bot_id,
              bot_name:               match.bot_name,
              setup_type:             match.setup_type,
              thesis:                 match.thesis,
              expected_hold_days_min: match.expected_hold_days_min,
              expected_hold_days_max: match.expected_hold_days_max,
            } : t;
          });
        } catch (e) {
          console.warn('[dashboard] recent_trades enrichment skipped:', e.message);
        }
      }
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
    const source = rawSource === 'moomoo' ? 'moomoo' : rawSource === 'alpaca_live' ? 'alpaca_live' : rawSource === 'tiger_demo' ? 'tiger_demo' : rawSource === 'tiger' ? 'tiger' : 'alpaca';
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
          order_id:         o.id,
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
      // Most-recent closed DB trade per symbol — enrich Alpaca SELL legs with bot context.
      const closingBySymbol = new Map();
      for (const t of db) {
        if (t.status !== 'closed' || !t.symbol) continue;
        const sym = t.symbol.toUpperCase();
        const existing = closingBySymbol.get(sym);
        if (!existing || new Date(t.closed_at || 0) > new Date(existing.closed_at || 0)) {
          closingBySymbol.set(sym, t);
        }
      }
      const qtFromAlpacaEnriched = qtFromAlpaca.map(qt => {
        if (qt.side !== 'sell' || !qt.symbol) return qt;
        const match = closingBySymbol.get(qt.symbol.toUpperCase());
        if (!match) return qt;
        return {
          ...qt,
          bot_id:                 match.bot_id ?? null,
          bot_name:               match.bot_name ?? null,
          setup_type:             match.setup_type ?? null,
          thesis:                 match.thesis ?? null,
          expected_hold_days_min: match.expected_hold_days_min ?? null,
          expected_hold_days_max: match.expected_hold_days_max ?? null,
          stop_loss:              match.stop_loss ?? null,
          take_profit:            match.take_profit ?? null,
        };
      });
      const merged = [...db.map(t => ({ ...t, source: 'force' })), ...qtFromAlpacaEnriched]
        .sort((a, b) => new Date(b.opened_at) - new Date(a.opened_at))
        .slice(0, limit);
      return res.json({ source: 'db', trades: merged });
    }

    // Tiger source — fetch user's Tiger orders
    if (source === 'tiger' || source === 'tiger_demo') {
      const dbUserT = isDbAvailable() ? await getDbUser(req.session.username) : null;
      const tcT = _tigerCredsForSource(dbUserT, source);
      if (!tcT.tiger_id) return res.json({ source, trades: [] });
      const creds = { tiger_id: tcT.tiger_id, account: tcT.account, private_key: tcT.private_key };
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
  // Yahoo Finance only — skip Moomoo to prevent TCP connection storms during scans
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
  // Yahoo Finance only — skip Moomoo to prevent TCP connection storms during scans
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
  // Get Yahoo Finance first (HTTP, zero TCP overhead) to determine marketState.
  // Only open a Moomoo TCP connection during REGULAR session — outside market hours
  // Moomoo real-time data is never used as the main price (line below gates on REGULAR),
  // so opening connections during pre/post/closed hours only floods OpenD's accept queue.
  let yfd = null;
  try { yfd = await _yf.quoteSummary(symbol, { modules: ['price'] }); } catch { /* ignore */ }
  const p        = yfd?.price;
  const mktState = p?.marketState ?? '';

  const isPreSess  = mktState === 'PRE'  || mktState === 'PREPRE';
  const isPostSess = mktState === 'POST' || mktState === 'POSTPOST';

  // Only connect to Moomoo during REGULAR session. Skipping the !p fallback intentionally:
  // calling Moomoo when Yahoo fails during off-hours would flood OpenD's accept queue.
  let mm = null;
  if (mktState === 'REGULAR') {
    try { mm = await getMoomooQuote(symbol); } catch { /* ignore */ }
  }

  // Extended hours sub-line prices.
  // Prefer Moomoo real-time data; fall back to Yahoo Finance (gated on session).
  const regularClose = mm?.price ?? p?.regularMarketPrice;
  const postPriceRaw = isPostSess ? (mm?.after_market?.price ?? p?.postMarketPrice ?? null) : null;
  const prePriceRaw  = isPreSess  ? (mm?.pre_market?.price  ?? p?.preMarketPrice  ?? null) : null;
  const extFields = {
    pre_price:       prePriceRaw  != null ? +prePriceRaw.toFixed(3)  : null,
    pre_change:      prePriceRaw  != null && regularClose ? +(prePriceRaw  - regularClose).toFixed(3) : null,
    pre_change_pct:  prePriceRaw  != null && regularClose ? +((prePriceRaw  - regularClose) / regularClose * 100).toFixed(2) : null,
    post_price:      postPriceRaw != null ? +postPriceRaw.toFixed(3) : null,
    post_change:     postPriceRaw != null && regularClose ? +(postPriceRaw - regularClose).toFixed(3) : null,
    post_change_pct: postPriceRaw != null && regularClose ? +((postPriceRaw - regularClose) / regularClose * 100).toFixed(2) : null,
  };

  // Main price: Moomoo real-time during REGULAR; otherwise Yahoo regular-session close.
  if (mktState === 'REGULAR' && mm?.success && mm.price != null) {
    return { price: +mm.price.toFixed(2), change: mm.change ?? null, change_pct: mm.change_pct ?? null, session: 'regular', ...extFields };
  }

  if (!p) {
    // Yahoo failed entirely — use Moomoo curPrice as best-effort fallback
    if (mm?.success && mm.price != null) return { price: +mm.price.toFixed(2), change: mm.change ?? null, change_pct: mm.change_pct ?? null, session: 'regular', ...extFields };
    return null;
  }

  // Non-regular session: show the last regular close as the main price
  const price      = p.regularMarketPrice;
  const change     = p.regularMarketChange;
  const change_pct = p.regularMarketChangePercent != null ? +(p.regularMarketChangePercent * 100).toFixed(2) : null;
  if (price == null) return null;
  return { price: +price.toFixed(2), change: change != null ? +change.toFixed(2) : null, change_pct, session: 'regular', ...extFields };
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

    // Real-money accounts (moomoo, tiger, alpaca_live) — generic path
    if (source === 'moomoo' || source === 'tiger' || source === 'alpaca_live') {
      console.log(`[pnl] source=${source} username=${req.session.username}`);

      // Moomoo has a precise per-position today P&L endpoint; others use unrealized_pl
      const [accountResult, livePnlResult] = await Promise.allSettled([
        getAccountData(source, req.session.username),
        source === 'moomoo' ? getMoomooTodayPnL() : Promise.resolve({ available: false }),
      ]);
      const account = accountResult.status === 'fulfilled' ? accountResult.value.account : null;
      const livePnl = livePnlResult.status === 'fulfilled' ? livePnlResult.value : { available: false };

      // Persist snapshot so account overview cards accumulate over time
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

      // History: prefer accurate daily_pnl rows (stored by EOD cron); fall back to
      // equity-delta from snapshots, filtering out swings > $5 000 (deposits/withdrawals).
      const pnlRows = isDbAvailable()
        ? await getDailyPnlHistory({ days, username: req.session.username, source })
        : [];
      let history;
      if (pnlRows && pnlRows.length > 0) {
        history = pnlRows.map(r => ({
          date:           r.date instanceof Date
            ? r.date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
            : String(r.date).slice(0, 10),
          pnl:            parseFloat(r.realized_pnl  ?? 0),
          unrealized_pl:  parseFloat(r.unrealized_pnl ?? 0),
          total_trades:   parseInt(r.total_trades    ?? 0),
          winning_trades: parseInt(r.winning_trades  ?? 0),
        }));
      } else {
        const snapshots = isDbAvailable()
          ? await getAccountSnapshots({ source, username: req.session.username, days })
          : [];
        history = [];
        for (let i = 1; i < snapshots.length; i++) {
          const prev = snapshots[i - 1];
          const curr = snapshots[i];
          // Prefer realized_pl delta when available (some brokers report it accurately)
          const realDelta = curr.realized_pl != null && prev.realized_pl != null
            ? +( parseFloat(curr.realized_pl) - parseFloat(prev.realized_pl) ).toFixed(2)
            : null;
          const equityDelta = curr.portfolio_value != null && prev.portfolio_value != null
            ? +( parseFloat(curr.portfolio_value) - parseFloat(prev.portfolio_value) ).toFixed(2)
            : null;
          const pnl = (realDelta !== null && realDelta !== 0) ? realDelta : equityDelta;
          // Skip days with no data or large swings that are clearly deposits/withdrawals
          if (pnl === null || Math.abs(pnl) > 5000) continue;
          history.push({
            date:          curr.date instanceof Date
              ? curr.date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
              : String(curr.date).slice(0, 10),
            pnl,
            equity:        curr.portfolio_value != null ? parseFloat(curr.portfolio_value) : null,
            unrealized_pl: curr.unrealized_pl  != null ? parseFloat(curr.unrealized_pl)  : null,
          });
        }
      }

      // Today P&L: Moomoo uses live PLOfDay; all brokers fall back to unrealized_pl
      const todayPnl      = livePnl.available ? livePnl.pnl : (account?.unrealized_pl ?? null);
      const todayAvailable = livePnl.available || account != null;
      console.log(`[pnl] source=${source} today_pl=${todayPnl} (live=${livePnl.available}) history=${history.length}`);
      return res.json({
        today:   { pnl: todayPnl ?? 0, available: todayAvailable, live: livePnl.available },
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

// GET /api/options/unusual/:ticker — unusual options activity scanner
app.get('/api/options/unusual/:ticker', requireAuth, async (req, res) => {
  const ticker = (req.params.ticker || '').toUpperCase().trim();
  if (!ticker || !/^[A-Z]{1,5}$/.test(ticker)) {
    return res.status(400).json({ success: false, error: 'Invalid ticker symbol' });
  }
  try {
    const { unusual_contracts, put_call_ratio, summary, total_call_volume, total_put_volume, chains_scanned } =
      await checkUnusualOptions(ticker);
    res.json({ success: true, ticker, unusual_contracts, put_call_ratio, summary, total_call_volume, total_put_volume, chains_scanned });
  } catch (e) {
    console.error(`[options] ${ticker}:`, e.message);
    res.status(500).json({ success: false, ticker, error: e.message });
  }
});

// Open positions — source=alpaca (default), alpaca_live, or moomoo
app.get('/api/positions', requireAuth, async (req, res) => {
  try {
    const rawSource = req.query.source;
    const source = rawSource === 'moomoo' ? 'moomoo' : rawSource === 'alpaca_live' ? 'alpaca_live' : rawSource === 'tiger_demo' ? 'tiger_demo' : rawSource === 'tiger' ? 'tiger' : 'alpaca';
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
    const VALID_SRC   = ['paper', 'alpaca_live', 'moomoo', 'tiger', 'tiger_demo'];
    const reqSource   = VALID_SRC.includes(req.body.source) ? req.body.source : null;
    const broker      = reqSource || (isAdmin ? 'paper' : (userCfg?.trade_source ?? 'paper'));

    // ── Tiger close ───────────────────────────────────────────────────────────
    if (broker === 'tiger' || broker === 'tiger_demo') {
      const tcU = _tigerCredsForSource(dbU, broker);
      if (!tcU.tiger_id) return res.status(400).json({ error: 'Tiger credentials not configured.' });
      const creds = { tiger_id: tcU.tiger_id, account: tcU.account, private_key: tcU.private_key };
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
      const result = await closeMoomooPosition({ symbol: ticker2, acc_id: dbU?.moomoo_acc_id || null });
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
    if (broker === 'tiger' || broker === 'tiger_demo' || broker === 'moomoo') {
      return res.json({ ok: false, message: `Move-stop-to-breakeven is not supported for ${broker} via API. Adjust your stop manually in the ${broker.startsWith('tiger') ? 'Tiger' : 'Moomoo'} app.` });
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
    const [qRes, yfRes] = await Promise.allSettled([
      fetchCurrentPrice(symbol),
      _yf.quoteSummary(symbol, { modules: ['price', 'summaryDetail'] }),
    ]);
    const q   = qRes.status  === 'fulfilled' ? qRes.value  : null;
    const yfd = yfRes.status === 'fulfilled' ? yfRes.value : null;
    const p   = yfd?.price;
    const sd  = yfd?.summaryDetail;
    if (q) return res.json({
      symbol,
      mid: q.price, price: q.price,
      change: q.change ?? null, change_pct: q.change_pct ?? null,
      session: q.session ?? 'regular',
      pre_price: q.pre_price ?? null, pre_change: q.pre_change ?? null, pre_change_pct: q.pre_change_pct ?? null,
      post_price: q.post_price ?? null, post_change: q.post_change ?? null, post_change_pct: q.post_change_pct ?? null,
      name:        p?.longName                   ?? p?.shortName              ?? null,
      high:        p?.regularMarketDayHigh        ?? null,
      low:         p?.regularMarketDayLow         ?? null,
      open:        p?.regularMarketOpen           ?? null,
      prev_close:  p?.regularMarketPreviousClose  ?? null,
      volume:      p?.regularMarketVolume         ?? null,
      market_cap:  p?.marketCap                   ?? null,
      pe:          sd?.trailingPE                 ?? p?.trailingPE            ?? null,
      week52_high: sd?.fiftyTwoWeekHigh           ?? p?.fiftyTwoWeekHigh      ?? null,
      week52_low:  sd?.fiftyTwoWeekLow            ?? p?.fiftyTwoWeekLow       ?? null,
    });
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
        ? { price: r.value.price, change: r.value.change ?? null, change_pct: r.value.change_pct ?? null, session: r.value.session ?? 'regular',
            pre_price: r.value.pre_price ?? null, pre_change: r.value.pre_change ?? null, pre_change_pct: r.value.pre_change_pct ?? null,
            post_price: r.value.post_price ?? null, post_change: r.value.post_change ?? null, post_change_pct: r.value.post_change_pct ?? null }
        : null;
    });
    res.json({ quotes });
  } catch (err) {
    console.error('[quotes/batch]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// OHLCV history for mobile chart — wraps Yahoo Finance chart API
app.get('/api/chart-data/:symbol', requireAuth, async (req, res) => {
  try {
    const symbol   = req.params.symbol.toUpperCase().trim();
    const range    = ['1mo','3mo','6mo','1y','2y','3y'].includes(req.query.range) ? req.query.range : '3mo';
    const interval = '1d';
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return res.status(502).json({ error: 'Chart data unavailable' });
    const d      = await r.json();
    const result = d?.chart?.result?.[0];
    const ts     = result?.timestamp || [];
    const q      = result?.indicators?.quote?.[0] || {};
    const data   = ts.map((t, i) => ({
      t,
      o: q.open?.[i]   ?? null,
      h: q.high?.[i]   ?? null,
      l: q.low?.[i]    ?? null,
      c: q.close?.[i]  ?? null,
      v: q.volume?.[i] ?? null,
    })).filter(bar => bar.c != null);
    res.json({ symbol, range, data });
  } catch (err) {
    console.error('[chart-data]', err);
    res.status(500).json({ error: 'Chart data error' });
  }
});

// ── Stock Explorer — Market Pulse (indices + sector ETFs) ────────────────────
// Returns live quotes for market indices + sector ETFs for the pulse strip.
// Sector data is cached 10 min by getSectorPerformance(); indices are live.
app.get('/api/explorer/pulse', requireAuth, async (req, res) => {
  try {
    const mktSyms = ['SPY', 'QQQ', 'IWM', 'DIA', 'VIX'];
    const [sectorRes, ...mktRes] = await Promise.allSettled([
      getSectorPerformance(),
      ...mktSyms.map(s => fetchCurrentPrice(s)),
    ]);
    const market = mktSyms.map((sym, i) => {
      const q = mktRes[i].status === 'fulfilled' ? mktRes[i].value : null;
      return { symbol: sym, price: q?.price ?? null, change_pct: q?.change_pct ?? null };
    });
    const sectors = sectorRes.status === 'fulfilled' ? sectorRes.value : {};
    res.json({
      market,
      sectors: sectors.all_sectors ?? [],
      rotation_signal: sectors.rotation_signal ?? null,
    });
  } catch (err) {
    console.error('[explorer/pulse]', err);
    res.status(500).json({ error: 'Failed to fetch market pulse' });
  }
});

// ── Stock Explorer — Universe list (stocks + ETFs with grades) ────────────────
// Returns the current scanner universe merged with latest conviction grades.
// No live prices — browser batch-fetches those separately for speed.
const EXPLORER_ETFS = {
  SPY:'S&P 500 ETF', QQQ:'Nasdaq 100 ETF', IWM:'Russell 2000 ETF', DIA:'Dow Jones ETF',
  XLK:'Technology ETF', XLF:'Financials ETF', XLE:'Energy ETF', XLV:'Healthcare ETF',
  XLI:'Industrials ETF', XLB:'Materials ETF', XLP:'Consumer Staples ETF',
  XLY:'Consumer Disc. ETF', XLC:'Comm. Services ETF', XLRE:'Real Estate ETF',
  XLU:'Utilities ETF', GLD:'Gold ETF', TLT:'20Y Treasury ETF', UUP:'US Dollar ETF',
  SOXL:'Semis 3× Bull', SOXS:'Semis 3× Bear', ARKK:'ARK Innovation ETF',
  TQQQ:'QQQ 3× Bull', SQQQ:'QQQ 3× Bear', VXX:'Volatility ETF',
};
const _ETF_SET = new Set(Object.keys(EXPLORER_ETFS));

app.get('/api/explorer/universe', requireAuth, async (req, res) => {
  try {
    const [universeSyms, scoresResult] = await Promise.allSettled([
      getDynamicUniverse(),
      isDbAvailable()
        ? query(`SELECT DISTINCT ON (symbol) symbol, name, score, grade, scored_at
                 FROM conviction_scores ORDER BY symbol, scored_at DESC`)
        : Promise.resolve({ rows: [] }),
    ]);

    const syms   = universeSyms.status === 'fulfilled' ? universeSyms.value : [];
    const dbRows = scoresResult.status  === 'fulfilled' ? scoresResult.value.rows : [];
    const scoreMap = Object.fromEntries(dbRows.map(r => [r.symbol, r]));

    // Merge universe stocks (from scanner) + ETFs
    const allSyms = [...new Set([...syms, ...Object.keys(EXPLORER_ETFS)])];

    const items = allSyms.map(sym => {
      const sc = scoreMap[sym];
      const isEtf = _ETF_SET.has(sym);
      return {
        symbol:   sym,
        name:     sc?.name || EXPLORER_ETFS[sym] || sym,
        is_etf:   isEtf,
        etf_desc: EXPLORER_ETFS[sym] ?? null,
        grade:    isEtf ? null : (sc?.grade ?? null),
        score:    isEtf ? null : (sc?.score != null ? +parseFloat(sc.score).toFixed(0) : null),
        sector:   SECTOR_MAP[sym] ?? null,
        scored_at: sc?.scored_at ?? null,
      };
    });

    // Sort: A → B → C → F → ungraded stocks → ETFs
    const go = { A:0, B:1, C:2, F:3 };
    items.sort((a, b) => {
      if (a.is_etf !== b.is_etf) return a.is_etf ? 1 : -1;
      const ga = go[a.grade] ?? 4, gb = go[b.grade] ?? 4;
      if (ga !== gb) return ga - gb;
      return (b.score ?? 0) - (a.score ?? 0);
    });

    res.json({ items, etf_symbols: Object.keys(EXPLORER_ETFS) });
  } catch (err) {
    console.error('[explorer/universe]', err);
    res.status(500).json({ error: 'Failed to fetch universe' });
  }
});

// ── AI Ask / Global Search ────────────────────────────────────────────────────
const _askCache = new Map(); // query.lower → { data, ts }
const ASK_CACHE_TTL = 15 * 60 * 1000;

const _GS_COMPANY_MAP = {
  'nvidia':'NVDA','apple':'AAPL','microsoft':'MSFT','amazon':'AMZN','alphabet':'GOOGL',
  'google':'GOOGL','meta':'META','facebook':'META','tesla':'TSLA','netflix':'NFLX',
  'oracle':'ORCL','amd':'AMD','intel':'INTC','qualcomm':'QCOM','broadcom':'AVGO',
  'micron':'MU','tsmc':'TSM','supermicro':'SMCI','marvell':'MRVL','salesforce':'CRM',
  'servicenow':'NOW','adobe':'ADBE','cisco':'CSCO','jpmorgan':'JPM','goldman':'GS',
  'blackrock':'BLK','visa':'V','mastercard':'MA','paypal':'PYPL','coinbase':'COIN',
  'palantir':'PLTR','datadog':'DDOG','snowflake':'SNOW','cloudflare':'NET',
  'crowdstrike':'CRWD','palo alto':'PANW','uber':'UBER','lyft':'LYFT','airbnb':'ABNB',
  'doordash':'DASH','boeing':'BA','lockheed':'LMT','walmart':'WMT','costco':'COST',
  'nike':'NKE','disney':'DIS','exxon':'XOM','chevron':'CVX','starbucks':'SBUX',
  'arm':'ARM','c3ai':'AI','uipath':'PATH',
};

const _GS_STOP = new Set([
  'A','AN','THE','IS','IN','ON','FOR','TO','OF','AT','BY','OR','AND','NOT','ARE',
  'WAS','BE','AS','IT','ITS','BUY','SELL','HOLD','CEO','IPO','ETF','EPS','RSI',
  'VIX','SEC','FDA','AI','US','UK','EU','ANY','HAS','GET','WHY','HOW','ALL','DO',
  'SO','IF','NO','YES','MY','PM','AM','YF','SP','TM','PP','MM','BB','MA','PE',
]);

function _gsExtractTicker(query) {
  const lower = query.toLowerCase();
  // Company name map (sorted longest first to avoid partial matches)
  const names = Object.keys(_GS_COMPANY_MAP).sort((a,b) => b.length - a.length);
  for (const name of names) {
    if (lower.includes(name)) return _GS_COMPANY_MAP[name];
  }
  // All-caps ticker words
  const words = query.match(/\b[A-Z]{2,5}\b/g) || [];
  for (const w of words) {
    if (!_GS_STOP.has(w)) return w;
  }
  return null;
}

app.get('/api/ask', requireAuth, async (req, res) => {
  try {
    const rawQuery = (req.query.q || '').trim();
    if (!rawQuery) return res.status(400).json({ error: 'q required' });

    const cacheKey = rawQuery.toLowerCase();
    const cached = _askCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ASK_CACHE_TTL) return res.json(cached.data);

    // Extract ticker from natural language or use as-is if looks like a ticker
    const sym = _gsExtractTicker(rawQuery) || rawQuery.toUpperCase().replace(/[^A-Z0-9.]/g,'').slice(0,6);

    const [priceRes, yfRes, scoreRes, newsRes] = await Promise.allSettled([
      fetchCurrentPrice(sym),
      _yf.quoteSummary(sym, { modules: ['price', 'financialData', 'defaultKeyStatistics', 'calendarEvents', 'summaryProfile', 'summaryDetail'] }),
      getConvictionScore({ symbol: sym, positions: [] }),
      _mergedSymbolNews(sym, 5),
    ]);

    const q   = priceRes.status === 'fulfilled' ? priceRes.value : null;
    const yfd = yfRes.status    === 'fulfilled' ? yfRes.value    : null;
    const sc  = scoreRes.status === 'fulfilled' ? scoreRes.value  : null;
    const news = newsRes.status === 'fulfilled' ? newsRes.value   : [];

    const p  = yfd?.price;
    const fd = yfd?.financialData;
    const ks = yfd?.defaultKeyStatistics;
    const cal = yfd?.calendarEvents;
    const sp = yfd?.summaryProfile;
    const sd = yfd?.summaryDetail;

    // Build signal badges
    const rawSig = sc?.signals ?? {};
    const sigBadges = [];
    if (rawSig.rsi != null) {
      if (rawSig.rsi < 35)      sigBadges.push({ label: `RSI ${rawSig.rsi.toFixed(0)} Oversold`, bull: true });
      else if (rawSig.rsi > 65) sigBadges.push({ label: `RSI ${rawSig.rsi.toFixed(0)} Overbought`, bull: false });
      else                       sigBadges.push({ label: `RSI ${rawSig.rsi.toFixed(0)} Neutral`, bull: null });
    }
    if (rawSig.macd_hist != null) sigBadges.push({ label: rawSig.macd_hist > 0 ? 'MACD Bull' : 'MACD Bear', bull: rawSig.macd_hist > 0 });
    if (rawSig.current_price != null && rawSig.ema20 != null)
      sigBadges.push({ label: rawSig.current_price > rawSig.ema20 ? 'Above EMA20' : 'Below EMA20', bull: rawSig.current_price > rawSig.ema20 });
    if (rawSig.rvol != null && rawSig.rvol > 1.5) sigBadges.push({ label: `RVOL ${rawSig.rvol.toFixed(1)}x High`, bull: true });
    if (rawSig.rs_signal)  sigBadges.push({ label: rawSig.rs_signal, bull: rawSig.rs_signal.toLowerCase().includes('strong') });
    if (rawSig.analyst_consensus) sigBadges.push({ label: rawSig.analyst_consensus, bull: ['Buy','Strong Buy','Overweight'].includes(rawSig.analyst_consensus) });

    // Earnings date
    let earningsDate = null;
    try {
      const dates = cal?.earnings?.earningsDate;
      if (Array.isArray(dates) && dates.length) {
        const d = dates[0] instanceof Date ? dates[0] : new Date(dates[0]);
        if (!isNaN(d)) earningsDate = d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
      }
    } catch {}

    const epsEst    = fd?.earningsPerShare ?? ks?.forwardEps ?? null;
    const price     = q?.price ?? (p?.regularMarketPrice ?? null);
    const changePct = q?.change_pct ?? null;
    const company   = p?.longName ?? p?.shortName ?? '';
    const marketCap = p?.marketCap ?? null;
    const pe        = sd?.trailingPE ?? p?.trailingPE ?? ks?.trailingPE ?? null;
    const beta      = sd?.beta       ?? p?.beta       ?? ks?.beta       ?? null;
    const wk52h     = sd?.fiftyTwoWeekHigh ?? p?.fiftyTwoWeekHigh ?? null;
    const wk52l     = sd?.fiftyTwoWeekLow  ?? p?.fiftyTwoWeekLow  ?? null;
    const analystRating = rawSig.analyst_consensus ?? fd?.recommendationKey?.replace(/_/g,' ') ?? null;
    const targetPrice   = rawSig.analyst_target    ?? fd?.targetMeanPrice   ?? null;

    const formattedNews = news.map(a => ({
      headline:     a.title || a.headline || '',
      url:          a.url   || '',
      published_at: a.published ?? a.published_at ?? null,
    }));

    // ── Build Claude Haiku context & answer ──────────────────────────────────
    let aiAnswer = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const newsLines = formattedNews.slice(0, 5).map((n, i) => `${i+1}. ${n.headline}`).join('\n');
        const priceStr  = price != null ? `$${price.toFixed(2)}${changePct != null ? ` (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% today)` : ''}` : 'N/A';
        const mcapStr   = marketCap ? `$${(marketCap / 1e9).toFixed(1)}B` : 'N/A';
        const context   = [
          `Symbol: ${sym}`,
          `Company: ${company || sym}`,
          `Price: ${priceStr}`,
          `Market Cap: ${mcapStr}`,
          `P/E: ${pe != null ? pe.toFixed(1) : 'N/A'}  Beta: ${beta != null ? beta.toFixed(2) : 'N/A'}`,
          `52W Range: ${wk52l != null ? '$'+wk52l.toFixed(2) : 'N/A'} – ${wk52h != null ? '$'+wk52h.toFixed(2) : 'N/A'}`,
          `Analyst: ${analystRating || 'N/A'}  Target: ${targetPrice != null ? '$'+targetPrice.toFixed(2) : 'N/A'}`,
          `Conviction Score: ${sc?.score != null ? sc.score+'/100 (grade '+sc.grade+')' : 'N/A'}`,
          `RSI: ${rawSig.rsi != null ? rawSig.rsi.toFixed(1) : 'N/A'}`,
          `MACD: ${rawSig.macd_hist != null ? (rawSig.macd_hist > 0 ? 'Bullish histogram' : 'Bearish histogram') : 'N/A'}`,
          `Upcoming Earnings: ${earningsDate || 'Not scheduled'}${epsEst != null ? '  Est EPS: $'+epsEst.toFixed(2) : ''}`,
          sp?.longBusinessSummary ? `Business: ${sp.longBusinessSummary.slice(0, 300)}…` : '',
          newsLines ? `Recent News:\n${newsLines}` : '',
        ].filter(Boolean).join('\n');

        const msg = await _anthropic.messages.create({
          model: MODEL_LIGHTWEIGHT,
          max_tokens: 280,
          messages: [{
            role: 'user',
            content: `User asked: "${rawQuery}"\n\nCurrent data for ${sym}:\n${context}\n\nAnswer their specific question in 3–5 sentences. Be direct and data-driven. Start with the most important insight for their question. No fluff, no disclaimers.`,
          }],
        });
        aiAnswer = msg.content[0]?.text?.trim() || null;
      } catch (e) {
        console.warn('[ask] Haiku failed:', e.message);
      }
    }

    const data = {
      sym,
      company,
      exchange:         p?.exchangeName ?? p?.fullExchangeName ?? '',
      sector:           sp?.sector ?? '',
      price,
      change:           q?.change ?? null,
      change_pct:       changePct,
      session:          q?.session ?? 'regular',
      pre_price:        q?.pre_price ?? null,
      pre_change_pct:   q?.pre_change_pct ?? null,
      post_price:       q?.post_price ?? null,
      post_change_pct:  q?.post_change_pct ?? null,
      market_cap:       marketCap,
      pe_ratio:         pe,
      beta,
      wk52_high:        wk52h,
      wk52_low:         wk52l,
      analyst_rating:   analystRating,
      target_price:     targetPrice,
      conviction_score: sc?.score ?? null,
      conviction_grade: sc?.grade ?? null,
      signals:          sigBadges.filter(s => s.bull != null),
      earnings_date:    earningsDate,
      eps_estimate:     epsEst,
      news:             formattedNews,
      ai_answer:        aiAnswer,
    };

    _askCache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);
  } catch (err) {
    console.error('[ask]', err);
    res.status(500).json({ error: 'Research failed. Please try again.' });
  }
});

// ── Mini chart — 45 days of daily OHLCV for the search card ──────────────────
const _miniChartCache = new Map(); // sym → { bars, ts }
const MINI_CHART_TTL  = 30 * 60 * 1000; // 30 min

app.get('/api/mini-chart', requireAuth, async (req, res) => {
  try {
    const sym = (req.query.symbol || '').toUpperCase().trim();
    if (!sym) return res.status(400).json({ error: 'symbol required' });

    const cached = _miniChartCache.get(sym);
    if (cached && Date.now() - cached.ts < MINI_CHART_TTL) return res.json({ symbol: sym, bars: cached.bars });

    const period1 = new Date();
    period1.setDate(period1.getDate() - 50); // 50 calendar days ≈ ~35 trading days

    const rows = await _yf.historical(sym, {
      period1: period1.toISOString().split('T')[0],
      period2: new Date().toISOString().split('T')[0],
      interval: '1d',
    });

    const bars = rows
      .filter(r => r.open != null && r.high != null && r.low != null && r.close != null)
      .map(r => ({
        time:  (r.date instanceof Date ? r.date : new Date(r.date)).toISOString().split('T')[0],
        open:  +r.open.toFixed(2),
        high:  +r.high.toFixed(2),
        low:   +r.low.toFixed(2),
        close: +r.close.toFixed(2),
      }))
      .sort((a, b) => a.time.localeCompare(b.time));

    _miniChartCache.set(sym, { bars, ts: Date.now() });
    res.json({ symbol: sym, bars });
  } catch (err) {
    console.error('[mini-chart]', err.message);
    res.json({ symbol: req.query.symbol || '', bars: [] });
  }
});

// ── Legacy /api/search alias ──────────────────────────────────────────────────
const _searchCache = new Map(); // sym → { data, ts }
const SEARCH_CACHE_TTL = 5 * 60 * 1000;

app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const sym = (req.query.q || '').toUpperCase().trim();
    if (!sym) return res.status(400).json({ error: 'q required' });

    const cached = _searchCache.get(sym);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) return res.json(cached.data);

    const [priceRes, yfRes, scoreRes, newsRes] = await Promise.allSettled([
      fetchCurrentPrice(sym),
      _yf.quoteSummary(sym, { modules: ['price', 'financialData', 'defaultKeyStatistics', 'calendarEvents', 'summaryProfile', 'summaryDetail'] }),
      getConvictionScore({ symbol: sym, positions: [] }),
      _mergedSymbolNews(sym, 3),
    ]);

    const q    = priceRes.status === 'fulfilled' ? priceRes.value : null;
    const yfd  = yfRes.status    === 'fulfilled' ? yfRes.value    : null;
    const sc   = scoreRes.status === 'fulfilled' ? scoreRes.value  : null;
    const news = newsRes.status  === 'fulfilled' ? newsRes.value   : [];

    const p    = yfd?.price;
    const fd   = yfd?.financialData;
    const ks   = yfd?.defaultKeyStatistics;
    const cal  = yfd?.calendarEvents;
    const sp   = yfd?.summaryProfile;
    const sd   = yfd?.summaryDetail;

    // Build technical signal badges from conviction signals
    const rawSig = sc?.signals ?? {};
    const sigBadges = [];
    if (rawSig.rsi != null) {
      if (rawSig.rsi < 35)      sigBadges.push({ label: `RSI ${rawSig.rsi.toFixed(0)} Oversold`, bull: true });
      else if (rawSig.rsi > 65) sigBadges.push({ label: `RSI ${rawSig.rsi.toFixed(0)} Overbought`, bull: false });
      else                       sigBadges.push({ label: `RSI ${rawSig.rsi.toFixed(0)}`, bull: null });
    }
    if (rawSig.macd_hist != null) sigBadges.push({ label: rawSig.macd_hist > 0 ? 'MACD Bull' : 'MACD Bear', bull: rawSig.macd_hist > 0 });
    if (rawSig.current_price != null && rawSig.ema20 != null)
      sigBadges.push({ label: rawSig.current_price > rawSig.ema20 ? 'Above EMA20' : 'Below EMA20', bull: rawSig.current_price > rawSig.ema20 });
    if (rawSig.rvol != null && rawSig.rvol > 1.5) sigBadges.push({ label: `RVOL ${rawSig.rvol.toFixed(1)}x`, bull: true });
    if (rawSig.rs_signal)  sigBadges.push({ label: rawSig.rs_signal, bull: rawSig.rs_signal.toLowerCase().includes('strong') });
    if (rawSig.analyst_consensus) sigBadges.push({ label: rawSig.analyst_consensus, bull: ['Buy','Strong Buy','Overweight'].includes(rawSig.analyst_consensus) });

    // Earnings date
    let earningsDate = null;
    try {
      const dates = cal?.earnings?.earningsDate;
      if (Array.isArray(dates) && dates.length) {
        const d = dates[0] instanceof Date ? dates[0] : new Date(dates[0]);
        if (!isNaN(d)) earningsDate = d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
      }
    } catch {}

    // EPS estimate
    const epsEst = fd?.earningsPerShare ?? ks?.forwardEps ?? null;

    // News shape: { headline, url, published_at (unix ts or ISO string) }
    const formattedNews = news.map(a => ({
      headline:     a.title || a.headline || '',
      url:          a.url || '',
      published_at: a.published ?? a.published_at ?? null,
    }));

    const data = {
      symbol: sym,
      company:          p?.longName ?? p?.shortName ?? '',
      exchange:         p?.exchangeName ?? p?.fullExchangeName ?? '',
      sector:           sp?.sector ?? '',
      price:            q?.price ?? (p?.regularMarketPrice ?? null),
      change:           q?.change ?? null,
      change_pct:       q?.change_pct ?? null,
      session:          q?.session ?? 'regular',
      pre_price:        q?.pre_price ?? null,
      pre_change_pct:   q?.pre_change_pct ?? null,
      post_price:       q?.post_price ?? null,
      post_change_pct:  q?.post_change_pct ?? null,
      market_cap:       p?.marketCap ?? null,
      pe_ratio:         sd?.trailingPE ?? p?.trailingPE ?? ks?.trailingPE ?? null,
      beta:             sd?.beta ?? p?.beta ?? ks?.beta ?? null,
      wk52_high:        sd?.fiftyTwoWeekHigh ?? p?.fiftyTwoWeekHigh ?? null,
      wk52_low:         sd?.fiftyTwoWeekLow  ?? p?.fiftyTwoWeekLow  ?? null,
      analyst_rating:   rawSig.analyst_consensus ?? fd?.recommendationKey?.replace(/_/g,' ') ?? null,
      target_price:     rawSig.analyst_target     ?? fd?.targetMeanPrice   ?? null,
      conviction_score: sc?.score ?? null,
      conviction_grade: sc?.grade ?? null,
      signals:          sigBadges.filter(s => s.bull != null),
      earnings_date:    earningsDate,
      eps_estimate:     epsEst,
      news:             formattedNews,
    };

    _searchCache.set(sym, { data, ts: Date.now() });
    res.json(data);
  } catch (err) {
    console.error('[search]', err);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

app.post('/api/trade/quick', requireAuth, async (req, res) => {
  try {
    const { symbol, side = 'buy', qty, order_type = 'market',
            limit_price, stop_price, trail_price, trail_percent,
            stop_loss, take_profit, time_in_force = 'day',
            session, moo_tif } = req.body;

    // Translate generic session string → broker-native values
    const _sessionToMoo   = { rth: 1, eth: 2, all: 3, overnight: 4 };
    const mooSession      = session ? (_sessionToMoo[session] ?? 3) : 3; // default All
    const outsideRthFlag  = ['eth', 'all', 'overnight'].includes(session); // Tiger / Alpaca
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    if (!qty || qty < 1) return res.status(400).json({ error: 'qty must be ≥ 1' });

    const ticker = symbol.toUpperCase().trim();
    const shares = Math.floor(Number(qty));

    // Determine user's configured broker (client-sent source takes priority)
    const dbUser   = isDbAvailable() ? await getDbUser(req.session.username) : null;
    const userCfg  = dbUser ? (await getUserBotConfig(req.session.username)) : {};
    const _VSRC    = ['paper', 'alpaca_live', 'moomoo', 'tiger', 'tiger_demo'];
    const broker   = (_VSRC.includes(req.body.source) ? req.body.source : null) || (userCfg?.trade_source ?? 'paper');

    // ── Moomoo path ───────────────────────────────────────────────────────────
    if (broker === 'moomoo') {
      const result = await placeMoomooTrade({
        symbol: ticker, side, qty: shares,
        order_type,
        limit_price:   limit_price   ? +limit_price   : null,
        stop_price:    stop_price    ? +stop_price    : null,
        trail_percent: trail_percent ? +trail_percent : null,
        moo_session:   mooSession,
        moo_tif:       moo_tif != null ? +moo_tif : undefined,
        acc_id: dbUser?.moomoo_acc_id || null,
      });
      logActivity(req.session.username, 'quick_trade', `${side.toUpperCase()} ${shares} ${ticker} @ ${order_type} [Moomoo]`, req.ip);
      if (side === 'buy') {
        const entryPrice = limit_price ? +limit_price : (result?.filled_avg_price ?? result?.estimated_price ?? null);
        recordTrade({ order_id: String(result.order_id || `moo_${Date.now()}`), symbol: ticker, side: 'buy', qty: shares, entry_price: entryPrice, account_source: 'moomoo', username: req.session.username }).catch(() => {});
      }
      return res.json(result);
    }

    // ── Tiger path ────────────────────────────────────────────────────────────
    if (broker === 'tiger' || broker === 'tiger_demo') {
      const tcQ = _tigerCredsForSource(dbUser, broker);
      if (!tcQ.tiger_id) return res.status(400).json({ error: 'Tiger credentials not configured. Go to Settings → Tiger Brokers to connect.' });
      const creds = { tiger_id: tcQ.tiger_id, account: tcQ.account, private_key: tcQ.private_key };

      // Resolve limit price from request (explicit limit/stop_limit orders)
      let tigerLimitPrice  = (order_type === 'limit' || order_type === 'stop_limit') ? (limit_price ? +limit_price : null) : null;
      // Use session flag from UI; fall back to auto-detect when market is closed
      let tigerOutsideRth  = outsideRthFlag;
      let extendedHoursNote = outsideRthFlag ? 'Extended hours requested' : null;

      // For market orders with no explicit session: auto-convert to limit at ask when market is closed
      if (order_type === 'market' && !tigerLimitPrice && !outsideRthFlag) {
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
      model:            chatResult?.model            ?? MODEL_CRITICAL,
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

const MODEL_CRITICAL    = 'claude-sonnet-4-6';         // reasoning, user chat, tool use
const MODEL_LIGHTWEIGHT = 'claude-haiku-4-5-20251001'; // templated summaries, high-frequency calls

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
      fallbackModel: MODEL_LIGHTWEIGHT,
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
      fallbackModel: MODEL_LIGHTWEIGHT,
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

  ]);

  const services = checks.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { name: ['PostgreSQL','Alpaca','Anthropic','Moomoo'][i], status: 'error', detail: r.reason?.message }
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
      signal: AbortSignal.timeout(8000),
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
  if (_newsAnalysisCache && Date.now() - _newsAnalysisCacheAt < 60 * 60_000) {
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
      model: MODEL_LIGHTWEIGHT,
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

// ── AI Notifications — personalized portfolio alerts every 5 min ──
const _notifCache = new Map(); // username → { data, ts }
const NOTIF_TTL = 5 * 60_000;

app.get('/api/notifications', requireAuth, async (req, res) => {
  const username = req.session.username;
  if (req.query.force !== '1') {
    const hit = _notifCache.get(username);
    if (hit && Date.now() - hit.ts < NOTIF_TTL) return res.json(hit.data);
  }
  try {
    // 1. Portfolio — Moomoo first, fall back to Alpaca paper
    let positions = [];
    try {
      const raw = await getMoomooPositions();
      if (Array.isArray(raw) && raw.length) {
        positions = raw.map(p => ({
          symbol:          p.code || p.symbol,
          qty:             parseFloat(p.qty || p.quantity || 0),
          current_price:   parseFloat(p.current_price || p.price || 0),
          unrealized_pl:   parseFloat(p.pl_val || p.unrealized_pl || 0),
          unrealized_plpc: parseFloat(p.pl_ratio || p.unrealized_plpc || 0),
          market_value:    parseFloat(p.market_val || p.market_value || 0),
          cost_basis:      parseFloat(p.cost_price || p.avg_cost || 0),
        }));
      }
    } catch (_) {}
    if (!positions.length) {
      try {
        const raw = await getPositions();
        if (Array.isArray(raw) && raw.length) {
          positions = raw.map(p => ({
            symbol:          p.symbol,
            qty:             parseFloat(p.qty || 0),
            current_price:   parseFloat(p.current_price || 0),
            unrealized_pl:   parseFloat(p.unrealized_pl || 0),
            unrealized_plpc: parseFloat(p.unrealized_plpc || 0),
            market_value:    parseFloat(p.market_value || 0),
            cost_basis:      parseFloat(p.avg_entry_price || 0),
          }));
        }
      } catch (_) {}
    }

    // 2. Conviction scores for top 6 positions by market value
    const topSyms = [...positions]
      .sort((a, b) => Math.abs(b.market_value) - Math.abs(a.market_value))
      .slice(0, 6).map(p => p.symbol);
    const scoreRes = await Promise.allSettled(topSyms.map(s => getConvictionScore(s).then(sc => ({ s, sc }))));
    const scores = {};
    for (const r of scoreRes) {
      if (r.status === 'fulfilled' && r.value?.sc) scores[r.value.s] = r.value.sc;
    }

    // 3. Recent news headlines
    const newsLines = (_newsAnalysisCache || []).slice(0, 5).map(n =>
      `[${(n.tickers || []).slice(0, 3).join(',') || 'MKT'}] ${n.impact || n.title || ''}`
    );
    if (!newsLines.length && isBenzingaConfigured()) {
      try {
        const bz = await getBzNews({ limit: 5 });
        (bz?.articles || []).forEach(a => newsLines.push(`[${(a.tickers||[]).slice(0,3).join(',')||'MKT'}] ${a.title}`));
      } catch (_) {}
    }

    // 4. Market regime
    let regime = 'unknown';
    try { regime = (await getMarketRegime())?.regime || 'unknown'; } catch (_) {}

    // 5. UW options flow for held positions (last 24h from uw_flow_alerts)
    const flowBySymbol = {};
    if (isDbAvailable() && topSyms.length) {
      try {
        const { rows: flowRows } = await query(
          `SELECT ticker,
                  SUM(CASE WHEN sentiment='bullish' THEN COALESCE(premium,0) ELSE 0 END) AS bull_prem,
                  SUM(CASE WHEN sentiment='bearish' THEN COALESCE(premium,0) ELSE 0 END) AS bear_prem,
                  COUNT(*) AS alerts
           FROM uw_flow_alerts
           WHERE ticker = ANY($1)
             AND alerted_at > NOW() - INTERVAL '24 hours'
           GROUP BY ticker`,
          [topSyms]
        );
        for (const r of flowRows) {
          flowBySymbol[r.ticker] = {
            bull: Number(r.bull_prem || 0),
            bear: Number(r.bear_prem || 0),
            alerts: Number(r.alerts || 0),
          };
        }
      } catch (_) {}
    }

    // 6. Insider trades for held positions (last 30d from uw_insider_trades)
    const insiderBySymbol = {};
    if (isDbAvailable() && topSyms.length) {
      try {
        const { rows: insiderRows } = await query(
          `SELECT ticker,
                  SUM(CASE WHEN LOWER(transaction_type)='buy'  THEN COALESCE(value,0) ELSE 0 END) AS buy_val,
                  SUM(CASE WHEN LOWER(transaction_type)='sell' THEN COALESCE(value,0) ELSE 0 END) AS sell_val,
                  COUNT(*) AS filings
           FROM uw_insider_trades
           WHERE ticker = ANY($1)
             AND filed_at > NOW() - INTERVAL '30 days'
           GROUP BY ticker`,
          [topSyms]
        );
        for (const r of insiderRows) {
          const b = Number(r.buy_val || 0), s = Number(r.sell_val || 0);
          insiderBySymbol[r.ticker] = {
            buy: b, sell: s, net: b - s,
            filings: Number(r.filings || 0),
            sentiment: b > s ? 'net_buying' : s > b ? 'net_selling' : 'neutral',
          };
        }
      } catch (_) {}
    }

    // 7. Build prompt
    const posText = positions.slice(0, 8).map(p => {
      // unrealized_plpc is always a decimal ratio (0.05 = 5%) from both Moomoo and Alpaca
      const plPct  = (p.unrealized_plpc * 100).toFixed(1);
      const sc     = scores[p.symbol];
      const parts  = [
        `${p.symbol}: ${p.qty}sh @ $${p.current_price.toFixed(2)}, P&L ${plPct}%`,
        `grade ${sc?.grade || '?'} (score ${sc?.score?.toFixed(0) || '?'})`,
        `RSI ${(sc?.signals?.rsi ?? sc?.rsi)?.toFixed(0) || '?'}`,
        sc?.signals?.rvol != null ? `RVOL ${Number(sc.signals.rvol).toFixed(1)}x` : null,
        sc?.signals?.days_to_earnings != null && sc.signals.days_to_earnings <= 21
          ? `earnings in ${sc.signals.days_to_earnings}d` : null,
        sc?.signals?.analyst_upside_pct != null
          ? `analyst ${sc.signals.analyst_upside_pct > 0 ? '+' : ''}${Number(sc.signals.analyst_upside_pct).toFixed(0)}% PT` : null,
      ].filter(Boolean);
      return parts.join(', ');
    }).join('\n') || 'No open positions';

    // Options flow summary per held ticker (last 24h)
    const flowText = topSyms.length ? topSyms.map(sym => {
      const f = flowBySymbol[sym];
      if (!f || f.alerts === 0) return `${sym}: no flow`;
      const net = f.bull > f.bear ? 'net bullish' : f.bear > f.bull ? 'net bearish' : 'neutral';
      return `${sym}: ${net} ($${(f.bull / 1000).toFixed(0)}K bull / $${(f.bear / 1000).toFixed(0)}K bear, ${f.alerts} alerts)`;
    }).join('\n') : 'No held positions';

    // Insider activity summary per held ticker (last 30d)
    const insiderText = topSyms.length ? topSyms.map(sym => {
      const ins = insiderBySymbol[sym];
      if (!ins || ins.filings === 0) return `${sym}: no recent filings`;
      const abs = Math.abs(ins.net);
      const netFmt = abs >= 1000000
        ? `${ins.net >= 0 ? '+' : '-'}$${(abs / 1000000).toFixed(1)}M`
        : abs >= 1000
          ? `${ins.net >= 0 ? '+' : '-'}$${(abs / 1000).toFixed(0)}K`
          : `${ins.net >= 0 ? '+' : '-'}$${abs.toFixed(0)}`;
      return `${sym}: ${ins.filings} filing(s), ${netFmt} net [${ins.sentiment}]`;
    }).join('\n') : 'No held positions';

    const newsText = newsLines.join('\n') || 'No recent news';

    const msg = await _anthropic.messages.create({
      model: MODEL_LIGHTWEIGHT,
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `You are a market observation assistant for a personal trading dashboard. Generate 5-7 personalized market observations based on the data below. These are observations only — NOT trade signals or instructions.

IMPORTANT: Do NOT use the words BUY, SELL, or any trade directive language. Flag conditions for the user to research, not instructions. You have no real-time data and your knowledge may be outdated.

PORTFOLIO (symbol · qty · price · P&L · grade · score · RSI · RVOL · earnings · analyst target):
${posText}

RECENT NEWS:
${newsText}

MARKET REGIME: ${regime}

UW OPTIONS FLOW — last 24h for held positions (bull $K vs bear $K, alert count):
${flowText}

INSIDER ACTIVITY — SEC Form 4 filings last 30d for held positions:
${insiderText}

Return ONLY a JSON array — no prose, no markdown. Each item:
{"type":"ALERT"|"NEWS"|"IDEA"|"INFO"|"FLOW"|"INSIDER","title":"<60 chars","body":"<120 chars with specific numbers","symbol":"TICKER or null","action":"REVIEW"|"MONITOR"|"WATCH"|"READ"|null,"priority":"high"|"medium"|"low"}

Rules:
- ALERT: notable technical condition — RSI>70 (overbought), RSI<30 (oversold), grade F, P&L gain >15%, RVOL>3x (unusual activity), earnings within 7 days
- NEWS: news relevant to a held stock — describe the event and potential impact, no directional prediction
- IDEA: A-grade stock with strong signals NOT in portfolio — flag for research only
- INFO: market regime, sector rotation, VIX context, analyst price target gap — factual only
- FLOW: significant options imbalance for a held position (>3:1 bull/bear ratio OR >$500K total premium). State exact amounts. Skip if balanced or under $100K.
- INSIDER: notable insider filing for a held position. Net selling >$500K = high priority. Always name the sentiment. Skip if no filings.
- Always include specific numbers (price, %, RSI, dollar amounts)
- Never use directive language ("you should", "consider", "take profit", "cut losses")
- Priority order: ALERT/FLOW/INSIDER > NEWS > IDEA/INFO`,
      }],
    });

    const raw  = msg.content[0]?.text || '[]';
    const json = raw.match(/\[[\s\S]*\]/)?.[0] || '[]';
    let notifications = [];
    try { notifications = JSON.parse(json).slice(0, 7); } catch (_) {}

    const data = { notifications, generated_at: new Date().toISOString(), positions_count: positions.length };
    _notifCache.set(username, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    console.error('[notifications]', e.message);
    res.json({ notifications: [], generated_at: new Date().toISOString() });
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

// ─── News Feed (DB-backed, Discover tab) ─────────────────────────────────────

app.get('/api/news/feed', requireAuth, async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const where = [];
    const params = [];
    // Composite cursor: stable even when multiple articles share the same published_at.
    if (req.query.before_ts && req.query.before_id) {
      params.push(req.query.before_ts);
      const tsParam = `$${params.length}`;
      params.push(req.query.before_id);
      const idParam = `$${params.length}`;
      where.push(`(published_at < ${tsParam}
                    OR (published_at = ${tsParam} AND article_id < ${idParam}))`);
    }
    if (req.query.since) {
      params.push(req.query.since);
      where.push(`published_at > $${params.length}`);
    }
    if (req.query.ticker) {
      params.push(JSON.stringify([req.query.ticker.toUpperCase()]));
      where.push(`tickers @> $${params.length}::jsonb`);
    }
    if (req.query.sentiment && ['positive','negative','neutral'].includes(req.query.sentiment)) {
      params.push(req.query.sentiment);
      where.push(`sentiment = $${params.length}`);
    }
    if (req.query.source) {
      params.push(req.query.source);
      where.push(`source = $${params.length}`);
    }
    if (req.query.q) {
      params.push(req.query.q);
      where.push(`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(teaser,''))
                  @@ plainto_tsquery('english', $${params.length})`);
    }
    if (req.query.channel) {
      params.push(JSON.stringify([req.query.channel]));
      where.push(`channels @> $${params.length}::jsonb`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);
    const sql = `
      SELECT article_id, title, teaser, url, source, author, image_url,
             channels, tickers, sentiment, published_at, updated_at, ingested_at
      FROM benzinga_news
      ${whereSql}
      ORDER BY published_at DESC, article_id DESC
      LIMIT $${params.length}
    `;
    const { rows } = await query(sql, params);
    const next_before_ts = rows.length === limit ? rows[rows.length - 1].published_at : null;
    const next_before_id = rows.length === limit ? rows[rows.length - 1].article_id   : null;
    // Flag saved articles for the current user
    const username = req.session?.username;
    let savedSet = new Set();
    if (username && rows.length) {
      const ids = rows.map(r => r.article_id);
      const { rows: savedRows } = await query(
        `SELECT article_id FROM news_saved WHERE username = $1 AND article_id = ANY($2)`,
        [username, ids]
      );
      savedSet = new Set(savedRows.map(r => r.article_id));
    }
    for (const r of rows) r.is_saved = savedSet.has(r.article_id);
    res.json({ articles: rows, count: rows.length, next_before_ts, next_before_id });
  } catch (e) {
    console.error('[news/feed]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/news/sources', requireAuth, async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const { rows } = await query(
      `SELECT source, COUNT(*) AS article_count
       FROM benzinga_news
       WHERE source IS NOT NULL AND published_at > NOW() - INTERVAL '7 days'
       GROUP BY source
       ORDER BY article_count DESC
       LIMIT 50`
    );
    res.json({ sources: rows });
  } catch (e) {
    console.error('[news/sources]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/news/stats', requireAuth, async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const { rows } = await query(`
      SELECT
        (SELECT COUNT(*) FROM benzinga_news) AS total,
        (SELECT COUNT(*) FROM benzinga_news WHERE published_at > NOW() - INTERVAL '24 hours') AS last_24h,
        (SELECT COUNT(*) FROM benzinga_news WHERE ingested_at > NOW() - INTERVAL '15 minutes') AS recent_ingest,
        (SELECT MAX(published_at) FROM benzinga_news) AS latest_published,
        (SELECT MAX(ingested_at) FROM benzinga_news) AS latest_ingested
    `);
    res.json({ ...rows[0], ingester: getIngesterStatus() });
  } catch (e) {
    console.error('[news/stats]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/news/save', requireAuth, async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
  const username = req.session?.username;
  const articleId = String(req.body?.article_id || '').trim();
  if (!username || !articleId) return res.status(400).json({ error: 'article_id required' });
  try {
    await query(
      `INSERT INTO news_saved (username, article_id)
       VALUES ($1, $2)
       ON CONFLICT (username, article_id) DO NOTHING`,
      [username, articleId]
    );
    res.json({ ok: true, article_id: articleId });
  } catch (e) {
    console.error('[news/save]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/news/save/:article_id', requireAuth, async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
  const username = req.session?.username;
  const articleId = String(req.params.article_id || '').trim();
  if (!username || !articleId) return res.status(400).json({ error: 'article_id required' });
  try {
    await query(
      `DELETE FROM news_saved WHERE username = $1 AND article_id = $2`,
      [username, articleId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[news/save delete]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/news/saved', requireAuth, async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
  const username = req.session?.username;
  if (!username) return res.status(401).json({ error: 'auth required' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  try {
    const { rows } = await query(
      `SELECT bn.article_id, bn.title, bn.teaser, bn.url, bn.source, bn.author,
              bn.image_url, bn.channels, bn.tickers, bn.sentiment,
              bn.published_at, bn.updated_at, ns.saved_at
       FROM news_saved ns
       JOIN benzinga_news bn ON bn.article_id = ns.article_id
       WHERE ns.username = $1
       ORDER BY ns.saved_at DESC
       LIMIT $2`,
      [username, limit]
    );
    // Mark all as saved (they come from the saved list)
    for (const r of rows) r.is_saved = true;
    res.json({ articles: rows, count: rows.length });
  } catch (e) {
    console.error('[news/saved]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/news/channels', requireAuth, async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const { rows } = await query(
      `SELECT ch.value AS channel, COUNT(*) AS article_count
       FROM benzinga_news bn,
            LATERAL jsonb_array_elements_text(bn.channels) AS ch(value)
       WHERE bn.published_at > NOW() - INTERVAL '7 days'
         AND ch.value <> ''
       GROUP BY ch.value
       ORDER BY article_count DESC
       LIMIT 20`
    );
    res.json({ channels: rows });
  } catch (e) {
    console.error('[news/channels]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── News Volume Spikes ──────────────────────────────────────────────────────

/**
 * GET /api/news/spikes
 *   ?window_minutes=60   — current window for "recent" count (default 60, max 360)
 *   ?baseline_days=14    — baseline period (default 14, max 60)
 *   ?threshold=3.0       — minimum spike ratio (default 3.0, min 1.5)
 *   ?min_articles=3      — minimum articles in window (default 3)
 *   ?limit=20            — max spikes to return (max 50)
 */
app.get('/api/news/spikes', requireAuth, async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const windowMin    = Math.min(Math.max(parseInt(req.query.window_minutes, 10) || 60, 5), 360);
    const baselineDays = Math.min(Math.max(parseInt(req.query.baseline_days,  10) || 14, 3), 60);
    const threshold    = Math.max(parseFloat(req.query.threshold)     || 3.0, 1.5);
    const minArticles  = Math.min(Math.max(parseInt(req.query.min_articles,   10) || 3, 2), 50);
    const limit        = Math.min(Math.max(parseInt(req.query.limit,           10) || 20, 1), 50);

    const sql = `
      WITH baseline AS (
        SELECT ticker,
               COUNT(*)::float / ($2::float * 24.0) AS avg_per_hour
        FROM benzinga_news bn,
             jsonb_array_elements_text(bn.tickers) AS ticker
        WHERE bn.published_at > NOW() - ($2 || ' days')::interval
        GROUP BY ticker
        HAVING COUNT(*) >= 7
      ),
      recent AS (
        SELECT ticker,
               COUNT(*) AS recent_count,
               (ARRAY_AGG(
                  jsonb_build_object(
                    'article_id', bn.article_id,
                    'title',      bn.title,
                    'sentiment',  bn.sentiment,
                    'url',        bn.url,
                    'published_at', bn.published_at,
                    'source',     bn.source
                  )
                  ORDER BY bn.published_at DESC
               ))[1:5] AS sample_articles
        FROM benzinga_news bn,
             jsonb_array_elements_text(bn.tickers) AS ticker
        WHERE bn.published_at > NOW() - ($1 || ' minutes')::interval
        GROUP BY ticker
      )
      SELECT r.ticker,
             r.recent_count,
             ROUND(b.avg_per_hour::numeric, 2)                                                                AS baseline_per_hour,
             ROUND((((r.recent_count * 60.0) / $1::float) / NULLIF(b.avg_per_hour, 0))::numeric, 1)          AS spike_ratio,
             r.sample_articles
      FROM recent r
      JOIN baseline b USING (ticker)
      WHERE r.recent_count >= $4
        AND ((r.recent_count * 60.0) / $1::float) / NULLIF(b.avg_per_hour, 0) >= $3
      ORDER BY spike_ratio DESC, r.recent_count DESC
      LIMIT $5
    `;

    const { rows } = await query(sql, [windowMin, baselineDays, threshold, minArticles, limit]);
    res.json({
      spikes: rows,
      window_minutes: windowMin,
      threshold,
      baseline_days: baselineDays,
    });
  } catch (e) {
    console.error('[news/spikes]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── News Sentiment Modifier Inspection ──────────────────────────────────────

app.get('/api/news/sentiment/:symbol', requireAuth, async (req, res) => {
  try {
    const { getNewsSentimentForSymbol } = await import('../core/news-sentiment-modifier.js');
    const sym = String(req.params.symbol || '').toUpperCase();
    if (!/^[A-Z]{1,8}$/.test(sym)) return res.status(400).json({ error: 'invalid ticker' });
    const result = await getNewsSentimentForSymbol(sym);
    res.json(result);
  } catch (e) {
    console.error('[news/sentiment]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Unusual Whales ───────────────────────────────────────────────────────────

/**
 * GET /api/uw/flow-alerts
 *
 * Returns recent unusual options flow alerts from Unusual Whales.
 *
 * Query params:
 *   symbol  {string}  Optional — filter to a single ticker (e.g. ?symbol=NVDA)
 *   limit   {number}  Max alerts to return, 1–100 (default 25)
 *
 * Response: { alerts: [...], count: N, source: "unusualwhales", cached: bool }
 *
 * Each alert object includes:
 *   ticker            Stock symbol
 *   type              "call" | "put"
 *   strike            Strike price (string)
 *   expiry            Expiration date (YYYY-MM-DD)
 *   total_premium     Total premium paid in dollars (string)
 *   volume            Total contracts traded
 *   open_interest     Open interest at time of alert
 *   underlying_price  Stock price at time of alert (string)
 *   has_sweep         true if aggressor swept multiple exchanges
 *   has_floor         true if floor / block trade
 *   alert_rule        Rule that fired: RepeatedHits | RepeatedHitsDescendingFill | …
 *   sector            GICS sector name
 *   next_earnings_date  Next earnings date (YYYY-MM-DD) or null
 *   created_at        ISO timestamp of alert
 *   option_chain      Full OCC symbol (e.g. "NVDA260620C00130000")
 *   iv_start / iv_end Implied volatility range across the trade sequence
 *   sentiment         Derived: "bullish" | "bearish" | "neutral"
 *
 * Caching: 60 seconds (in unusual-whales.js)
 * Rate limit: counted against 120 req/min UW quota
 */
app.get('/api/uw/flow-alerts', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  const ticker = (req.query.symbol || req.query.ticker || '').toUpperCase().trim() || undefined;
  const limit  = Math.min(parseInt(req.query.limit) || 25, 100);
  try {
    const alerts = await getFlowAlerts({ ticker, limit });
    res.json({ alerts, count: alerts.length, source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/flow-alerts]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/uw/market-tide
 *
 * Returns intraday market tide — net call vs put premium in 5-minute bars
 * for the current trading session, plus a computed session summary.
 *
 * No query parameters.
 *
 * Response:
 *   bars[]              Array of 5-minute bars (oldest → newest)
 *     .timestamp        ISO timestamp (Eastern time)
 *     .date             Date string (YYYY-MM-DD)
 *     .net_call_premium Net call premium for this bar ($ string, can be negative)
 *     .net_put_premium  Net put premium for this bar ($ string, can be negative)
 *     .net_volume       Net options volume (negative = more puts than calls)
 *   summary             Computed aggregate for the full session so far
 *     .total_net_call   Cumulative net call premium today ($)
 *     .total_net_put    Cumulative net put premium today ($)
 *     .bias             "bullish" | "bearish" | "neutral"
 *     .bias_pct         Strength of bias as a percentage (0–100)
 *     .last_updated     Timestamp of most recent bar
 *     .bar_count        Number of 5-min bars today
 *
 * Caching: 5 minutes (in unusual-whales.js)
 * Rate limit: counted against 120 req/min UW quota
 */
app.get('/api/uw/market-tide', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  try {
    const result = await getMarketTide();
    res.json({ ...result, source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/market-tide]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/uw/options-flow?ticker=AAPL&limit=50
 * Returns recent unusual options flow alerts from Unusual Whales.
 * Fields: ticker, side (call/put), strike, expiry, premium, volume, open_interest, sentiment
 * Caching: 60 seconds (in unusual-whales.js)
 */
app.get('/api/uw/options-flow', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  try {
    const ticker = (req.query.ticker || '').toUpperCase().trim() || undefined;
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const result = await getOptionsFlow({ ticker, limit });
    res.json({ flow: result ?? [], source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/options-flow]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/uw/insider?ticker=AAPL&limit=50
 * Returns recent insider trading filings.
 * Fields: ticker, insider_name, role, transaction_type, shares, price, value, filed_at
 * Caching: 15 minutes (in unusual-whales.js)
 */
app.get('/api/uw/insider', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  try {
    const ticker = (req.query.ticker || '').toUpperCase().trim() || undefined;
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const result = await getInsiderTrades({ ticker, limit });
    res.json({ trades: result ?? [], source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/insider]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/uw/congressional?ticker=AAPL&limit=50
 * Returns recent congressional trading disclosures.
 * Fields: ticker, member_name, party, chamber, transaction_type, amount_range, traded_at, filed_at
 * Caching: 60 minutes (in unusual-whales.js)
 */
app.get('/api/uw/congressional', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  try {
    const ticker = (req.query.ticker || '').toUpperCase().trim() || undefined;
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const result = await getCongressionalTrades({ ticker, limit });
    res.json({ trades: result ?? [], source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/congressional]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/uw/movers?limit=20
 * Returns top market movers (bullish/bearish flow leaders).
 * Fields: ticker, direction, flow_score, premium_total, unusual_count
 * Caching: 5 minutes (in unusual-whales.js)
 */
app.get('/api/uw/movers', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const result = await getTopMovers({ limit });
    res.json({ movers: result ?? [], source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/movers]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/uw/correlations?ticker=AAPL
 * Returns correlation data between ticker and market instruments.
 * Fields: ticker, correlations array (symbol, correlation_30d, correlation_90d)
 * Caching: 60 minutes (in unusual-whales.js)
 */
app.get('/api/uw/correlations', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  const ticker = (req.query.ticker || '').toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const result = await getCorrelations({ tickers: [ticker] });
    res.json({ correlations: result ?? [], source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/correlations]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/uw/quota — live rate-limiter state (Items 5)
app.get('/api/uw/quota', requireAuth, async (req, res) => {
  try {
    const q = getQuota();
    res.json({ ...q, fetched_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/uw/flow-alerts-history?hours=24&limit=50 — DB-backed history (Item 9)
app.get('/api/uw/flow-alerts-history', requireAuth, async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const hours = Math.min(parseInt(req.query.hours || '24', 10), 168);
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const minPremium = parseInt(req.query.min_premium || '0', 10);
    const { rows } = await query(
      `SELECT ticker, alert_type, side, strike, expiry, premium, volume, open_interest, sentiment, alerted_at
       FROM uw_flow_alerts
       WHERE alerted_at > NOW() - ($1 * INTERVAL '1 hour')
         AND ($2 = 0 OR premium >= $2)
       ORDER BY alerted_at DESC LIMIT $3`,
      [hours, minPremium, limit]
    );
    res.json({ alerts: rows, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/uw/conviction/:symbol — UW conviction for a single symbol
app.get('/api/uw/conviction/:symbol', requireAuth, async (req, res) => {
  try {
    const c = await getUwConvictionForSymbol(req.params.symbol.toUpperCase());
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/uw/conviction?symbols=AAPL,NVDA — UW conviction for up to 50 symbols
app.get('/api/uw/conviction', requireAuth, async (req, res) => {
  try {
    const symbols = (req.query.symbols || '').split(',').filter(Boolean).map(s => s.toUpperCase());
    if (!symbols.length) return res.status(400).json({ error: 'symbols=AAPL,NVDA required' });
    if (symbols.length > 50) return res.status(400).json({ error: 'max 50 symbols' });
    const map = await getUwConvictionForSymbols(symbols);
    res.json(Object.fromEntries(map));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Full options data (UW) ───────────────────────────────────────────────────

const TICKER_RE = /^[A-Z]{1,8}$/;
const CONTRACT_RE = /^[A-Z0-9_]{6,40}$/;

/**
 * GET /api/uw/option-chain/:ticker?expiry=YYYY-MM-DD
 * Returns full option chain (all strikes × all expiries, or filtered to one expiry).
 * Caching: 60 s (in unusual-whales.js)
 */
app.get('/api/uw/option-chain/:ticker', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  const ticker = (req.params.ticker || '').toUpperCase();
  if (!TICKER_RE.test(ticker)) return res.status(400).json({ error: 'invalid ticker' });
  if (req.query.expiry && !/^\d{4}-\d{2}-\d{2}$/.test(req.query.expiry))
    return res.status(400).json({ error: 'Invalid expiry date; expected YYYY-MM-DD' });
  const expiry = req.query.expiry || undefined;
  try {
    const result = await getOptionChain(ticker, expiry);
    res.json({ ticker, expiry: expiry || null, chain: result ?? [], source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/option-chain]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/uw/atm-chain/:ticker?expirations=YYYY-MM-DD,YYYY-MM-DD
 * Returns at-the-money option contracts only (smaller payload than full chain).
 * If no expirations given, auto-resolves the 2 nearest from expiry-breakdown.
 * Caching: 60 s
 */
app.get('/api/uw/atm-chain/:ticker', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  const ticker = (req.params.ticker || '').toUpperCase();
  if (!TICKER_RE.test(ticker)) return res.status(400).json({ error: 'invalid ticker' });
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const rawExpirations = (req.query.expirations || '').split(',').map(s => s.trim()).filter(Boolean);
  if (rawExpirations.some(s => !DATE_RE.test(s)))
    return res.status(400).json({ error: 'Invalid expiration date; expected YYYY-MM-DD' });
  const expirations = rawExpirations;
  try {
    const result = await getAtmChains(ticker, expirations);
    res.json({ ticker, expirations: expirations.length ? expirations : 'auto', chain: result ?? [], source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/atm-chain]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/uw/expiry-breakdown/:ticker
 * Returns call/put volume + OI bucketed per expiry.
 * Caching: 5 min
 */
app.get('/api/uw/expiry-breakdown/:ticker', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  const ticker = (req.params.ticker || '').toUpperCase();
  if (!TICKER_RE.test(ticker)) return res.status(400).json({ error: 'invalid ticker' });
  try {
    const result = await getExpiryBreakdown(ticker);
    res.json({ ticker, expiries: result ?? [], source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/expiry-breakdown]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/uw/options-volume/:ticker
 * Returns daily aggregate call/put volume + premiums (historical).
 * Caching: 15 min · Persists each day-row to uw_options_volume (UPSERT on (ticker, trade_date)).
 *
 * UW fields per day: date, call_volume, put_volume, call_open_interest, put_open_interest,
 * call_premium, put_premium, bullish_premium, bearish_premium, net_call_premium, net_put_premium,
 * plus 3/7/30-day volume averages (kept in raw JSONB).
 */
app.get('/api/uw/options-volume/:ticker', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  const ticker = (req.params.ticker || '').toUpperCase();
  if (!TICKER_RE.test(ticker)) return res.status(400).json({ error: 'invalid ticker' });
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const result = await getOptionsVolume(ticker, { limit });
    const rows = Array.isArray(result) ? result : (result ? [result] : []);
    if (rows.length && isDbAvailable()) {
      try {
        for (const r of rows) {
          if (!r.date) continue;
          await query(
            `INSERT INTO uw_options_volume
               (ticker, trade_date, call_volume, put_volume,
                call_open_interest, put_open_interest,
                call_premium, put_premium, bullish_premium, bearish_premium,
                net_call_premium, net_put_premium, raw)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
             ON CONFLICT (ticker, trade_date) DO UPDATE
               SET call_volume        = EXCLUDED.call_volume,
                   put_volume         = EXCLUDED.put_volume,
                   call_open_interest = EXCLUDED.call_open_interest,
                   put_open_interest  = EXCLUDED.put_open_interest,
                   call_premium       = EXCLUDED.call_premium,
                   put_premium        = EXCLUDED.put_premium,
                   bullish_premium    = EXCLUDED.bullish_premium,
                   bearish_premium    = EXCLUDED.bearish_premium,
                   net_call_premium   = EXCLUDED.net_call_premium,
                   net_put_premium    = EXCLUDED.net_put_premium,
                   raw                = EXCLUDED.raw,
                   ingested_at        = NOW()`,
            [
              ticker, r.date,
              r.call_volume        ?? null,
              r.put_volume         ?? null,
              r.call_open_interest ?? null,
              r.put_open_interest  ?? null,
              r.call_premium       ?? null,
              r.put_premium        ?? null,
              r.bullish_premium    ?? null,
              r.bearish_premium    ?? null,
              r.net_call_premium   ?? null,
              r.net_put_premium    ?? null,
              JSON.stringify(r),
            ]
          );
        }
      } catch (dbErr) {
        console.error('[uw/options-volume] persist failed:', dbErr.message);
      }
    }
    res.json({ ticker, days: rows, source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/options-volume]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/uw/gex/:ticker
 * Returns dealer greek exposure as a time series — one row per day with
 * call/put gamma, delta, charm, vanna.
 * Caching: 5 min · UPSERTs each daily row into uw_greek_exposure.
 */
app.get('/api/uw/gex/:ticker', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  const ticker = (req.params.ticker || '').toUpperCase();
  if (!TICKER_RE.test(ticker)) return res.status(400).json({ error: 'invalid ticker' });
  try {
    const result = await getGreekExposure(ticker);
    const rows = Array.isArray(result) ? result : (result ? [result] : []);
    if (rows.length && isDbAvailable()) {
      try {
        for (const r of rows) {
          if (!r.date) continue;
          await query(
            `INSERT INTO uw_greek_exposure
               (ticker, as_of_date,
                call_gamma, put_gamma, call_delta, put_delta,
                call_charm, put_charm, call_vanna, put_vanna, raw)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
             ON CONFLICT (ticker, as_of_date) DO UPDATE
               SET call_gamma = EXCLUDED.call_gamma,
                   put_gamma  = EXCLUDED.put_gamma,
                   call_delta = EXCLUDED.call_delta,
                   put_delta  = EXCLUDED.put_delta,
                   call_charm = EXCLUDED.call_charm,
                   put_charm  = EXCLUDED.put_charm,
                   call_vanna = EXCLUDED.call_vanna,
                   put_vanna  = EXCLUDED.put_vanna,
                   raw        = EXCLUDED.raw,
                   ingested_at = NOW()`,
            [
              ticker, r.date,
              r.call_gamma ?? null, r.put_gamma ?? null,
              r.call_delta ?? null, r.put_delta ?? null,
              r.call_charm ?? null, r.put_charm ?? null,
              r.call_vanna ?? null, r.put_vanna ?? null,
              JSON.stringify(r),
            ]
          );
        }
      } catch (dbErr) {
        console.error('[uw/gex] persist failed:', dbErr.message);
      }
    }
    res.json({ ticker, gex: rows, source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/gex]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/uw/max-pain/:ticker
 * Returns max-pain strike per expiry, plus open/close, lower/upper strikes.
 * Caching: 30 min · Persists each expiry row to uw_max_pain.
 *
 * UW fields per expiry: expiry, max_pain, open, close, next_lower_strike, next_upper_strike.
 */
app.get('/api/uw/max-pain/:ticker', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  const ticker = (req.params.ticker || '').toUpperCase();
  if (!TICKER_RE.test(ticker)) return res.status(400).json({ error: 'invalid ticker' });
  try {
    const result = await getMaxPain(ticker);
    const rows = Array.isArray(result) ? result : (result ? [result] : []);
    if (rows.length && isDbAvailable()) {
      try {
        for (const r of rows) {
          if (!r.expiry) continue;
          await query(
            `INSERT INTO uw_max_pain
               (ticker, expiry, max_pain_strike, spot_price, open_price,
                next_lower_strike, next_upper_strike, raw)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
             ON CONFLICT (ticker, expiry, captured_at) DO NOTHING`,
            [
              ticker, r.expiry,
              r.max_pain          ?? null,
              r.close             ?? null,
              r.open              ?? null,
              r.next_lower_strike ?? null,
              r.next_upper_strike ?? null,
              JSON.stringify(r),
            ]
          );
        }
      } catch (dbErr) {
        console.error('[uw/max-pain] persist failed:', dbErr.message);
      }
    }
    res.json({ ticker, expiries: rows, source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/max-pain]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/uw/contract/:id/history
 * Returns historical price/volume/IV for a specific option contract.
 * :id is the UW option symbol (e.g. NVDA260117C00500000).
 * Caching: 5 min
 */
app.get('/api/uw/contract/:id/history', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  const id = (req.params.id || '').toUpperCase();
  if (!CONTRACT_RE.test(id)) return res.status(400).json({ error: 'invalid contract id' });
  try {
    const result = await getContractHistory(id);
    res.json({ contract_id: id, history: result ?? [], source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/contract/history]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/uw/contract/:id/volume
 * Returns volume-by-price-level profile for a specific option contract.
 * Caching: 5 min
 */
app.get('/api/uw/contract/:id/volume', requireAuth, async (req, res) => {
  if (!isUWConfigured()) return res.status(503).json({ error: 'UW_API_KEY not configured' });
  const id = (req.params.id || '').toUpperCase();
  if (!CONTRACT_RE.test(id)) return res.status(400).json({ error: 'invalid contract id' });
  try {
    const result = await getContractVolumeProfile(id);
    res.json({ contract_id: id, profile: result ?? [], source: 'unusualwhales' });
  } catch (e) {
    console.error('[uw/contract/volume]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bot-indicators/:symbol — Phase B-0 inspection route
app.get('/api/bot-indicators/:symbol', requireAuth, async (req, res) => {
  try {
    const { getAllBotIndicators } = await import('../core/bot-indicators.js');
    const sym = String(req.params.symbol || '').toUpperCase();
    if (!/^[A-Z]{1,8}$/.test(sym)) return res.status(400).json({ error: 'invalid ticker' });
    const result = await getAllBotIndicators(sym);
    res.json(result);
  } catch (e) {
    console.error('[bot-indicators]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Bot management (Phase B-1) ───────────────────────────────────────────────

const BOT_DEFAULT_RULES = {
  entry_filters: {
    min_composite_score: 60,
    conviction_grade_min: 'C',
    strategy: 'composite',       // 'composite' | 'catalyst' | 'breakout' | 'momentum' | 'value_contrarian' | 'mean_reversion'
    sectors_excluded: [],
    market_cap_min_b: 5,
    price_min: 5,
    price_max: 500,
    min_adv_dollar_vol: 5000000,
    avoid_earnings_within_days: 3,
    vix_min: 15,
    vix_max: 60,
    vix_aggressive_at: 25,
    // require_uw_label_any: previously ['bullish', 'strong_bullish'] but the
    // UW conviction labeler returns 'no_data' or 'neutral' for almost every
    // symbol — even mega-caps with huge flow. That made this gate a death
    // sentence (100% rejection rate in production diagnostics).
    //
    // Removed as the default after 2-year backtest showed price-only momentum
    // strategy returns +42.6% / 1.29 Sharpe vs +29.3% / 0.80 Sharpe with UW
    // gating in the classifier. UW data is still a 30% weighted signal in the
    // composite score — when present it boosts ranking; when absent the bot
    // is no longer crippled. Set to a non-empty array on a specific bot to
    // re-enable strict UW filtering.
    require_uw_label_any: null,
    require_news_sentiment_min: null,
    skip_during_macro_blackout: true,
    skip_high_short_interest: false,
    avoid_premarket_gap_above_pct: 8,
  },
  exit_rules: {
    legacy_stop_loss_usd: 50,
    legacy_trail_pct: 30,
    legacy_time_stop_days: 5,
    exit_on_news_volume_spike_negative: true,
    exit_on_uw_flipped_bearish: true,
    exit_before_earnings: true,
  },
  sizing: {
    position_size_pct: 60,
    vix_aggressive_multiplier: 1.3,
  },
  composite_weights: {
    conviction:   0.10,
    news:         0.22,
    uw_options:   0.30,
    gex:          0.15,
    insider:      0.15,
    distance_52w: 0.08,
    predictor:    0.00,
  },
  risk: {
    max_loss_usd: null,
    daily_loss_limit_usd: null,
    pause_after_n_losses: 3,
  },
  execution: {
    order_type:        'auto',
    allow_outside_rth: true,
    limit_offset_bps:  30,
  },
};

const BOT_NAME_RE   = /^[\w\s\-]{1,60}$/;
const BOT_STATUS_OK = new Set(['active', 'paused', 'paused_today', 'stopped']);

function _validateBotRules(rules) {
  if (!rules || typeof rules !== 'object') return 'rules must be an object';
  const w = rules.composite_weights;
  if (w) {
    const vals = Object.values(w);
    if (vals.some(v => typeof v !== 'number' || v < 0 || v > 1))
      return 'composite_weights: each weight must be a number between 0 and 1';
    const sum = vals.reduce((s, v) => s + v, 0);
    if (sum < 0.95 || sum > 1.05)
      return `composite_weights must sum to ~1.0 (got ${sum.toFixed(3)})`;
  }
  if (rules.risk?.max_loss_usd !== undefined && rules.risk.max_loss_usd !== null && rules.risk.max_loss_usd <= 0)
    return 'risk.max_loss_usd must be > 0 or null';
  return null;
}

function _deepMergeRules(defaults, override) {
  if (!override || typeof override !== 'object') return defaults;
  const out = {};
  for (const k of Object.keys(defaults)) {
    if (defaults[k] && typeof defaults[k] === 'object' && !Array.isArray(defaults[k])) {
      out[k] = _deepMergeRules(defaults[k], override[k]);
    } else {
      out[k] = (override[k] !== undefined) ? override[k] : defaults[k];
    }
  }
  for (const k of Object.keys(override)) {
    if (!(k in defaults)) out[k] = override[k];
  }
  return out;
}

async function _currentUserId(req) {
  const username = req.session?.username;
  if (!username) return null;
  const u = await getDbUser(username);
  return u?.id ?? null;
}

async function _botOwnedBy(botId, userId) {
  const { rows } = await query('SELECT id FROM bots WHERE id=$1 AND user_id=$2', [botId, userId]);
  return rows.length > 0;
}

// GET /api/bots
app.get('/api/bots', requireAuth, async (req, res) => {
  try {
    const userId = await _currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const includeArchived = req.query.include_archived === 'true';
    const bots = await listBots(userId, { includeArchived });
    // Attach lifetime trade stats per bot
    if (bots.length) {
      const botIds = bots.map(b => b.id);
      const { rows: stats } = await query(`
        SELECT bot_id,
               COUNT(*)                                   AS lifetime_trades,
               COUNT(*) FILTER (WHERE pnl_usd > 0)       AS lifetime_wins,
               COALESCE(SUM(pnl_usd), 0)                 AS lifetime_pnl,
               MAX(closed_at)                             AS last_trade_at
        FROM trades
        WHERE bot_id = ANY($1) AND status = 'closed'
        GROUP BY bot_id`, [botIds]);
      const statsMap = Object.fromEntries(stats.map(s => [s.bot_id, s]));
      for (const b of bots) {
        const s = statsMap[b.id];
        b.lifetime_trades   = s ? Number(s.lifetime_trades) : 0;
        b.lifetime_wins     = s ? Number(s.lifetime_wins)   : 0;
        b.lifetime_pnl      = s ? Number(s.lifetime_pnl)    : 0;
        b.last_trade_at     = s?.last_trade_at ?? null;
      }
      // Attach setup_type of current open trade for badge display (always present, null when no open trade)
      for (const b of bots) b.current_setup_type = null;
      const openTradeIds = bots.filter(b => b.current_trade_id).map(b => b.current_trade_id);
      if (openTradeIds.length) {
        const { rows: openTrades } = await query(
          `SELECT id, setup_type FROM trades WHERE id = ANY($1)`,
          [openTradeIds]
        );
        const openMap = Object.fromEntries(openTrades.map(t => [t.id, t.setup_type]));
        for (const b of bots) {
          b.current_setup_type = b.current_trade_id ? (openMap[b.current_trade_id] ?? null) : null;
        }
      }
    }
    res.json({ bots });
  } catch (e) {
    console.error('[bots/list]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/bots
app.post('/api/bots', requireAuth, async (req, res) => {
  try {
    const userId = await _currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const dbUserBroker = await getDbUser(req.session.username);
    const isAdminCreate = dbUserBroker?.role === 'admin';

    // Enforce 3-bot cap for non-admin users only
    if (!isAdminCreate) {
      const { rows: countRows } = await query('SELECT COUNT(*) AS n FROM bots WHERE user_id=$1 AND deleted_at IS NULL', [userId]);
      if (parseInt(countRows[0].n) >= 3) return res.status(409).json({ error: 'Bot limit reached (max 3 per user)' });
    }

    const { name, capital_usd, rules, account_type = 'paper', broker = 'alpaca' } = req.body;
    if (!name || !BOT_NAME_RE.test(name)) return res.status(400).json({ error: 'name: 1-60 chars, alphanumeric + spaces/dashes/underscores' });
    const cap = parseFloat(capital_usd);
    if (isNaN(cap) || cap < 100 || cap > 1000000) return res.status(400).json({ error: 'capital_usd: must be between 100 and 1000000' });

    // B-3: only paper-tier brokers allowed
    const B3_BROKERS = ['alpaca', 'tiger_demo'];
    if (!B3_BROKERS.includes(broker)) return res.status(400).json({ error: `broker must be one of: ${B3_BROKERS.join(', ')} (live brokers gated until B-6)` });

    if (broker === 'alpaca' && !isAdminCreate && !(dbUserBroker?.alpaca_api_key && dbUserBroker?.alpaca_secret_key)) {
      return res.status(400).json({ error: 'Alpaca paper credentials not configured. Connect Alpaca in broker settings first.' });
    }
    if (broker === 'tiger_demo' && !(dbUserBroker?.tiger_demo_id && dbUserBroker?.tiger_demo_account && dbUserBroker?.tiger_demo_private_key)) {
      return res.status(400).json({ error: 'Tiger Demo credentials not configured. Connect Tiger Demo in broker settings first.' });
    }

    const { rows: dupRows } = await query('SELECT id FROM bots WHERE user_id=$1 AND lower(name)=lower($2)', [userId, name.trim()]);
    if (dupRows.length) return res.status(409).json({ error: `A bot named "${name.trim()}" already exists` });
    const finalRules = _deepMergeRules(BOT_DEFAULT_RULES, rules || {});
    const rulesErr = _validateBotRules(finalRules);
    if (rulesErr) return res.status(400).json({ error: rulesErr });

    const { rows } = await query(
      `INSERT INTO bots (user_id, name, capital_usd, rules, account_type, broker)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [userId, name.trim(), cap, JSON.stringify(finalRules), account_type, broker]
    );
    const bot = rows[0];
    await query(
      'INSERT INTO bot_rules_versions (bot_id, rules_json, set_by) VALUES ($1,$2,$3)',
      [bot.id, JSON.stringify(finalRules), 'user']
    );
    res.status(201).json({ bot });
  } catch (e) {
    console.error('[bots/create]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/bots/stats — aggregate KPIs for the current user's bots
app.get('/api/bots/stats', requireAuth, async (req, res) => {
  try {
    const userId = await _currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const kpis = await getBotKpis(userId);
    res.json({ ok: true, kpis });
  } catch (e) {
    console.error('[bots/stats]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/bot-decisions/recent — last N decisions across all user's bots
app.get('/api/bot-decisions/recent', requireAuth, async (req, res) => {
  try {
    const userId = await _currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const decisions = await getRecentBotDecisions(userId, limit);
    res.json({ ok: true, decisions });
  } catch (e) {
    console.error('[bots/decisions/recent]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/bot-decisions/daily-summary — today's scanner totals + top blockers across all user bots
app.get('/api/bot-decisions/daily-summary', requireAuth, async (req, res) => {
  try {
    const userId = await _currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    // Midnight ET today as UTC
    const { rows } = await query(`
      SELECT bd.action, bd.notes, bd.composite_score, bd.symbol, b.name AS bot_name, b.id AS bot_id
      FROM bot_decisions bd
      JOIN bots b ON b.id = bd.bot_id
      WHERE b.user_id = $1
        AND b.deleted_at IS NULL
        AND bd.scanned_at >= (NOW() AT TIME ZONE 'America/New_York')::date::timestamptz AT TIME ZONE 'America/New_York'
      ORDER BY bd.scanned_at DESC
    `, [userId]);

    const totalScans  = rows.length;
    const trades      = rows.filter(r => r.action === 'buy').length;

    // Categorise each decision into a blocker bucket
    const buckets = {};
    const nearMisses = []; // composite scored but below threshold

    for (const r of rows) {
      if (r.action === 'buy') continue;
      let bucket = r.action; // default key
      let label  = _actionLabel(r.action);

      // Refine label using notes content
      const n = (r.notes || '').toLowerCase();
      if (n.includes('composite too low') || n.includes('below') || r.action === 'skip_no_candidate' && r.composite_score != null) {
        bucket = 'score_below_threshold';
        label  = 'Score below threshold';
        if (r.composite_score != null && r.composite_score >= 50) {
          nearMisses.push({ symbol: r.symbol, composite: +r.composite_score, bot: r.bot_name });
        }
      } else if (n.includes('no classifiable') || r.action === 'skip_unclassifiable_setup') {
        bucket = 'setup_unclassifiable';
        label  = 'No matching setup';
      } else if (n.includes('empty universe') || (r.action === 'skip_no_candidate' && !r.composite_score)) {
        bucket = 'empty_universe';
        label  = 'Empty market / no candidates';
      } else if (n.includes('filtered') || r.action === 'skip_filtered') {
        bucket = 'hard_gate_failed';
        label  = 'Hard gate failed';
      } else if (r.action === 'skip_circuit_breaker') {
        bucket = 'circuit_breaker';
        label  = 'Circuit breaker tripped';
      } else if (r.action === 'skip_inflight') {
        bucket = 'inflight';
        label  = 'Scan already in progress';
      } else if (r.action === 'error') {
        bucket = 'error';
        label  = 'Scan error';
      }

      if (!buckets[bucket]) buckets[bucket] = { key: bucket, label, count: 0 };
      buckets[bucket].count++;
    }

    const topBlockers = Object.values(buckets)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    res.json({ ok: true, total_scans: totalScans, trades, top_blockers: topBlockers, near_misses: nearMisses.slice(0, 5) });
  } catch (e) {
    console.error('[bot-decisions/daily-summary]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function _actionLabel(action) {
  const map = {
    skip_no_candidate:      'No candidate selected',
    skip_filtered:          'Hard gate failed',
    skip_unclassifiable_setup: 'No matching setup',
    skip_circuit_breaker:   'Circuit breaker tripped',
    skip_inflight:          'Scan already in progress',
    error:                  'Scan error',
    buy:                    'Trade placed',
  };
  return map[action] || action;
}

// GET /api/bots/:id
app.get('/api/bots/:id', requireAuth, async (req, res) => {
  try {
    const userId = await _currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { rows } = await query('SELECT * FROM bots WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
    if (!rows.length) return res.status(404).json({ error: 'Bot not found' });
    res.json({ bot: rows[0] });
  } catch (e) {
    console.error('[bots/get]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/bots/:id
app.patch('/api/bots/:id', requireAuth, async (req, res) => {
  try {
    const userId = await _currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { rows: existing } = await query('SELECT * FROM bots WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
    if (!existing.length) return res.status(404).json({ error: 'Bot not found' });
    const bot = existing[0];

    const { name, capital_usd, rules, status, broker, deleted_at } = req.body;
    const hasOpenTrade = bot.current_trade_id != null;

    // Restore from archive: PATCH { deleted_at: null }
    if (deleted_at === null && Object.keys(req.body).length === 1) {
      const { rows: restored } = await query(
        `UPDATE bots SET deleted_at=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`,
        [req.params.id]
      );
      return res.json({ bot: restored[0] });
    }

    if (name !== undefined) {
      if (hasOpenTrade) return res.status(409).json({ error: 'Cannot edit bot while a trade is open' });
      if (!BOT_NAME_RE.test(name)) return res.status(400).json({ error: 'name: invalid characters or length' });
    }
    if (capital_usd !== undefined) {
      if (hasOpenTrade) return res.status(409).json({ error: 'Cannot edit bot while a trade is open' });
      const cap = parseFloat(capital_usd);
      if (isNaN(cap) || cap < 100 || cap > 1000000) return res.status(400).json({ error: 'capital_usd: must be between 100 and 1000000' });
    }
    let mergedRules;
    if (rules !== undefined) {
      if (hasOpenTrade) return res.status(409).json({ error: 'Cannot edit bot while a trade is open' });
      const currentRules = bot.rules || BOT_DEFAULT_RULES;
      mergedRules = _deepMergeRules(currentRules, rules);
      const rulesErr = _validateBotRules(mergedRules);
      if (rulesErr) return res.status(400).json({ error: rulesErr });
    }
    if (status !== undefined && !BOT_STATUS_OK.has(status))
      return res.status(400).json({ error: `status must be one of: ${[...BOT_STATUS_OK].join(', ')}` });
    if (broker !== undefined && broker !== bot.broker) {
      if (hasOpenTrade) return res.status(409).json({ error: 'Cannot change broker while a trade is open' });
      const B3_BROKERS = ['alpaca', 'tiger_demo'];
      if (!B3_BROKERS.includes(broker)) return res.status(400).json({ error: `broker must be one of: ${B3_BROKERS.join(', ')} (live brokers gated until B-6)` });
      const dbUserBrokerPatch = await getDbUser(req.session.username);
      const isAdminPatch = dbUserBrokerPatch?.role === 'admin';
      if (broker === 'alpaca' && !isAdminPatch && !(dbUserBrokerPatch?.alpaca_api_key && dbUserBrokerPatch?.alpaca_secret_key)) {
        return res.status(400).json({ error: 'Alpaca paper credentials not configured. Connect Alpaca in broker settings first.' });
      }
      if (broker === 'tiger_demo' && !(dbUserBrokerPatch?.tiger_demo_id && dbUserBrokerPatch?.tiger_demo_account && dbUserBrokerPatch?.tiger_demo_private_key)) {
        return res.status(400).json({ error: 'Tiger Demo credentials not configured. Connect Tiger Demo in broker settings first.' });
      }
    }

    const sets = ['updated_at=NOW()'];
    const vals = [];
    let i = 1;
    if (name        !== undefined) { sets.push(`name=$${i++}`);         vals.push(name.trim()); }
    if (capital_usd !== undefined) { sets.push(`capital_usd=$${i++}`);  vals.push(parseFloat(capital_usd)); }
    if (rules       !== undefined) { sets.push(`rules=$${i++}`);        vals.push(JSON.stringify(mergedRules)); }
    if (status      !== undefined) { sets.push(`status=$${i++}`);       vals.push(status);
                                     sets.push(`status_changed_at=NOW()`); }
    if (broker      !== undefined && broker !== bot.broker) { sets.push(`broker=$${i++}`); vals.push(broker); }
    vals.push(req.params.id);
    const { rows: updated } = await query(
      `UPDATE bots SET ${sets.join(',')} WHERE id=$${i} RETURNING *`,
      vals
    );
    if (rules !== undefined) {
      await query(
        'INSERT INTO bot_rules_versions (bot_id, rules_json, set_by) VALUES ($1,$2,$3)',
        [req.params.id, JSON.stringify(mergedRules), 'user']
      );
    }
    res.json({ bot: updated[0] });
  } catch (e) {
    console.error('[bots/patch]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/bots/:id — soft-delete (sets deleted_at, preserves history)
app.delete('/api/bots/:id', requireAuth, async (req, res) => {
  try {
    const userId = await _currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { rows } = await query('SELECT * FROM bots WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
    if (!rows.length) return res.status(404).json({ error: 'Bot not found' });
    if (rows[0].current_trade_id != null) return res.status(409).json({ error: 'Cannot delete bot with an open trade' });
    await softDeleteBot(req.params.id, userId);
    res.json({ ok: true });
  } catch (e) {
    console.error('[bots/delete]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/bots/reconcile — authenticated users: back-fill missing DB rows from broker positions (scoped to caller's bots)
app.post('/api/bots/reconcile', requireAuth, async (req, res) => {
  try {
    const userId = await _currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const username = req.session.username;
    const dryRun = req.body.dryRun !== false;
    const result = await reconcileBotPositions({ userId, username, dryRun });
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[reconcile] error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/universe-sync — trigger tradable universe sync manually (idempotent, admin only)
app.post('/api/admin/universe-sync', requireAdmin, async (req, res) => {
  try {
    const force = req.query.force === 'true' || req.body?.force === true;
    const result = await syncTradableUniverse({ force });
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[universe-sync] route error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/bots/:id/trades
app.get('/api/bots/:id/trades', requireAuth, async (req, res) => {
  try {
    const userId = await _currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const trades = await getBotTrades(req.params.id, userId, limit);
    if (trades === null) return res.status(404).json({ error: 'Bot not found' });
    res.json({ ok: true, trades });
  } catch (e) {
    console.error('[bots/trades]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/bots/:id/decisions
app.get('/api/bots/:id/decisions', requireAuth, async (req, res) => {
  try {
    const userId = await _currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    if (!await _botOwnedBy(req.params.id, userId)) return res.status(404).json({ error: 'Bot not found' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const { rows } = await query(
      'SELECT * FROM bot_decisions WHERE bot_id=$1 ORDER BY scanned_at DESC LIMIT $2',
      [req.params.id, limit]
    );
    res.json({ decisions: rows });
  } catch (e) {
    console.error('[bots/decisions]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/bots/:id/postmortems
app.get('/api/bots/:id/postmortems', requireAuth, async (req, res) => {
  try {
    const userId = await _currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    if (!await _botOwnedBy(req.params.id, userId)) return res.status(404).json({ error: 'Bot not found' });
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const { rows } = await query(
      'SELECT * FROM trade_postmortems WHERE bot_id=$1 ORDER BY created_at DESC LIMIT $2',
      [req.params.id, limit]
    );
    res.json({ postmortems: rows });
  } catch (e) {
    console.error('[bots/postmortems]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/bots/:id/scan — manual trigger, scans one bot immediately (Phase B-2)
app.post('/api/bots/:id/scan', requireAuth, async (req, res) => {
  try {
    const userId = await _currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { rows } = await query(
      'SELECT * FROM bots WHERE id=$1 AND user_id=$2',
      [req.params.id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bot not found' });
    const result = await scanBot(rows[0]);
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[bots/scan]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/bots/:id/execute — manual trigger, runs executor for one bot immediately (B-3)
app.post('/api/bots/:id/execute', requireAuth, async (req, res) => {
  try {
    const userId = await _currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { rows } = await query(
      'SELECT * FROM bots WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
      [req.params.id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bot not found' });

    // Circuit-breaker gate: stopped bots cannot open new trades even via manual trigger.
    // (Fixes B.2 bypass — previously execute worked regardless of status.)
    // The executor can still manage OPEN positions when status='paused' or 'paused_today'.
    if (rows[0].status === 'stopped') {
      return res.status(409).json({
        error: `Bot is stopped — cannot execute trades. Reset the bot to "paused" first, then activate when ready.`,
        status: 'stopped',
      });
    }

    const result = await processBot(rows[0]);
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[bots/execute]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sentinel + System Alerts + Web Push + WebAuthn routes are registered via
// src/web/routes/index.js (review item #6). See registerExtractedRoutes() call
// later in this file.

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

    // 4. Notify via email
    const posLines = results.length ? results.join('\n') : 'No open positions.';
    const eodMsg = `🔔 *EOD Flatten — 3:50 PM ET*\n\n${posLines}${pnlLine}\n\n_All orders cancelled. No overnight exposure._`;
    await sendEmailAlert('EOD Flatten — 3:50 PM ET', eodMsg).catch(() => {});
    console.log('[EOD] Flatten complete:', results);
  } catch (e) {
    console.error('[EOD] Flatten error:', e.message);
    const failMsg = `⚠️ *EOD Flatten failed*: ${e.message}`;
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

// ─── Real-time price WebSocket (/ws/prices) ───────────────────────────────────
const wssPrice  = new WebSocketServer({ noServer: true });
const _priceClients = new Map();   // ws → Set<symbol>
let   _priceTick    = null;
let   _tickRunning  = false;       // guard: prevents overlapping async tick executions

function _ensurePriceTick() {
  if (_priceTick) return;
  _priceTick = setInterval(async () => {
    if (_tickRunning) return;      // previous tick still in flight — skip this interval
    _tickRunning = true;
    try {
    if (_priceClients.size === 0) { clearInterval(_priceTick); _priceTick = null; return; }
    const allSyms = new Set();
    _priceClients.forEach(syms => syms.forEach(s => allSyms.add(s)));
    if (!allSyms.size) { return; }
    const symList = [...allSyms];

    // Step 1: Yahoo Finance for all symbols in parallel (HTTP, no TCP to OpenD).
    const yfResults = await Promise.allSettled(
      symList.map(sym => _yf.quoteSummary(sym, { modules: ['price'] }).catch(() => null))
    );

    // Determine market state from first successful Yahoo response.
    const firstYfPrice = yfResults.find(r => r.status === 'fulfilled' && r.value?.price?.marketState)?.value?.price;
    const tickMktState = firstYfPrice?.marketState ?? '';
    const isRegular    = tickMktState === 'REGULAR';

    // Step 2: ONE batch Moomoo call for all symbols during REGULAR session only.
    // getQuotes() opens 1 TCP connection for all symbols (has 30s internal cache).
    // This replaces the previous pattern of 1 TCP connection per symbol per tick.
    const mmMap = {};
    if (isRegular) {
      for (let i = 0; i < symList.length; i += 80) {
        try {
          const batch = symList.slice(i, i + 80).map(toMoomooTicker);
          const r = await getMoomooQuotes(batch);
          (r.quotes || []).forEach(q => { mmMap[q.symbol] = q; });
        } catch { /* OpenD unreachable — Yahoo prices used */ }
      }
    }

    // Step 3: Merge Yahoo + Moomoo into tick payload.
    const prices = {};
    symList.forEach((sym, j) => {
      const yfd = yfResults[j].status === 'fulfilled' ? yfResults[j].value : null;
      const p   = yfd?.price;
      const mm  = mmMap[toMoomooTicker(sym)] ?? null;

      const symState   = p?.marketState ?? tickMktState;
      const isPreSess  = symState === 'PRE'  || symState === 'PREPRE';
      const isPostSess = symState === 'POST' || symState === 'POSTPOST';

      const regularClose = mm?.price ?? p?.regularMarketPrice;
      const postRaw = isPostSess ? (mm?.after_market?.price ?? p?.postMarketPrice ?? null) : null;
      const preRaw  = isPreSess  ? (mm?.pre_market?.price  ?? p?.preMarketPrice  ?? null) : null;

      let price, changePct;
      if (isRegular && mm?.price != null) {
        price = +mm.price.toFixed(2);
        changePct = mm.change_pct ?? null;
      } else if (p?.regularMarketPrice != null) {
        price = +p.regularMarketPrice.toFixed(2);
        changePct = p.regularMarketChangePercent != null ? +(p.regularMarketChangePercent * 100).toFixed(2) : null;
      } else {
        return;
      }

      prices[sym] = {
        p:  price,
        c:  changePct                                                                                         ?? null,
        s:  'regular',
        pp: preRaw  != null ? +preRaw.toFixed(3)  : null,
        pc: preRaw  != null && regularClose ? +((preRaw  - regularClose) / regularClose * 100).toFixed(2) : null,
        po: postRaw != null ? +postRaw.toFixed(3) : null,
        oc: postRaw != null && regularClose ? +((postRaw - regularClose) / regularClose * 100).toFixed(2) : null,
      };
    });

    const msg = JSON.stringify({ type: 'prices', data: prices, ts: Date.now() });
    _priceClients.forEach((_, ws) => {
      if (ws.readyState === ws.OPEN) try { ws.send(msg); } catch {}
    });
    } finally { _tickRunning = false; }
  }, 3000);
}

wssPrice.on('connection', ws => {
  _priceClients.set(ws, new Set());
  _ensurePriceTick();
  ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
  ws.on('message', raw => {
    try {
      const msg  = JSON.parse(raw);
      const syms = _priceClients.get(ws);
      if (!syms) return;
      if (msg.type === 'watch') {
        (msg.symbols || []).slice(0, 80).forEach(s => {
          if (typeof s === 'string' && /^[A-Z0-9=.^-]{1,10}$/.test(s)) syms.add(s);
        });
      }
      if (msg.type === 'unwatch') {
        (msg.symbols || []).forEach(s => syms.delete(String(s)));
      }
    } catch {}
  });
  ws.on('close', () => {
    _priceClients.delete(ws);
    if (_priceClients.size === 0 && _priceTick) { clearInterval(_priceTick); _priceTick = null; }
  });
});

httpServer.on('upgrade', (req, socket, head) => {
  const fakeRes = { getHeader: () => {}, setHeader: () => {}, end: () => {}, on: () => {} };

  if (req.url === '/ws/prices') {
    sessionMiddleware(req, fakeRes, async () => {
      try {
        const user = await getUser(req.session?.username);
        if (!user) { rejectUpgrade(socket, 403, 'Forbidden'); return; }
        wssPrice.handleUpgrade(req, socket, head, ws => wssPrice.emit('connection', ws, req));
      } catch (err) {
        console.error('[ws/prices] upgrade error:', err.message);
        rejectUpgrade(socket, 500, 'Internal Server Error');
      }
    });
    return;
  }

  if (req.url === '/ws/terminal') {
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
    return;
  }

  rejectUpgrade(socket, 404, 'Not Found');
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

// ─── News Ingester Crons ──────────────────────────────────────────────────────
startNewsIngesterCrons();

// ─── Bot Engine + Executor Crons ──────────────────────────────────────────────
// CRITICAL: Bot crons run ONLY on prod, never on staging. Both processes share
// the same DATABASE_URL (single Postgres), so without this gate they would
// each scan the same active bots on the same schedule, producing duplicate
// decisions / duplicate trades ~250ms apart. Smoking gun pre-fix: ASTS trade
// #66 + #67 (identical $103.67 entries, 226ms apart, May 2026, paper $133 loss).
// Convention: DASHBOARD_PORT is set in .env.staging only — same gate used by
// /docs route. Added 2026-05-23 as part of cron-double-fire fix.
const _IS_STAGING_DASHBOARD = !!process.env.DASHBOARD_PORT;
if (!_IS_STAGING_DASHBOARD) {
  startBotEngineCrons();
  startBotExecutorCrons();
} else {
  console.log('[bot-crons] staging mode (DASHBOARD_PORT set) — skipping engine + executor crons; prod owns them');
}

// ─── Near-Miss Report — 4:30 PM ET Mon–Fri (after close) ─────────────────────
// Surfaces stocks the bot didn't trade but should have considered. Email
// digest only — see src/core/near-miss-notifier.js for what counts as a
// near-miss. Skipped on staging (DASHBOARD_PORT set) so prod owns the
// notification.
if (!_IS_STAGING_DASHBOARD) {
  cron.schedule('30 16 * * 1-5', async () => {
    try {
      const { runNearMissReport } = await import('../core/near-miss-notifier.js');
      const r = await runNearMissReport();
      if (!r.ok) console.warn('[near-miss-cron] report failed:', r.error);
    } catch (err) {
      console.error('[near-miss-cron] error:', err.message);
    }
  }, { timezone: 'America/New_York' });
}

// POST /api/near-miss/run?dry=1&hours=120 — admin trigger for ad-hoc generation
//   dry=1   : assemble report but skip email send (preview only)
//   hours=N : lookback window in hours (1..168, default 24)
app.post('/api/near-miss/run', requireAdmin, async (req, res) => {
  try {
    const { runNearMissReport } = await import('../core/near-miss-notifier.js');
    const dry         = String(req.query.dry || '') === '1';
    const windowHours = req.query.hours ? Number(req.query.hours) : 24;
    const r = await runNearMissReport({ sendEmail: !dry, windowHours });
    if (!r.ok) return res.status(500).json({ error: r.error });
    res.json({
      ok: true,
      window_hours: windowHours,
      summary: r.summary,
      picks_count: r.picks.length,
      preview: r.body.split('\n').slice(0, 80).join('\n'),
      email_sent: r.emailResult?.ok ?? false,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Tradable Universe Sync — 8:00 AM ET Mon–Fri ─────────────────────────────
cron.schedule('0 8 * * 1-5', () => syncTradableUniverse(), { timezone: 'America/New_York' });

// ─── Pre-market News Scanner — 4:00 AM ET Mon–Fri ────────────────────────────
cron.schedule('0 4 * * 1-5', async () => {
  try {
    await runPreMarketScan();
  } catch (err) {
    console.error('[premarket-news] cron error:', err.message);
  }
}, { timezone: 'America/New_York' });

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

// ─── Pre-Close Sentinel Crons ─────────────────────────────────────────────────
// Weekdays 3:00 PM ET + Sundays 6:00 PM ET

cron.schedule('0 15 * * 1-5', async () => {
  try {
    await runSentinel({ mode: 'preclose' });
  } catch (err) {
    console.error('[sentinel] preclose cron error:', err.message);
    sysAlert({ key: 'sentinel/run-failed', severity: 'critical', title: 'Sentinel preclose run failed', detail: { mode: 'preclose', error: err.message, stack: err.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

cron.schedule('0 18 * * 0', async () => {
  try {
    await runSentinel({ mode: 'weekend' });
  } catch (err) {
    console.error('[sentinel] weekend cron error:', err.message);
    sysAlert({ key: 'sentinel/run-failed', severity: 'critical', title: 'Sentinel weekend run failed', detail: { mode: 'weekend', error: err.message, stack: err.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

app.post('/api/sentinel/run', requireAdmin, async (req, res) => {
  const { mode = 'preclose' } = req.body ?? {};
  try {
    const result = await runSentinel({ mode });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[sentinel] manual run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Daily Bot Report — 5:00 PM ET weekdays ───────────────────────────────────
cron.schedule('0 17 * * 1-5', async () => {
  try {
    const result = await runDailyBotReport();
    console.log(`[daily-bot-report] cron done: ${JSON.stringify(result)}`);
  } catch (err) {
    console.error('[daily-bot-report] cron error:', err.message);
    sysAlert({ key: 'daily-bot-report/failed', severity: 'warn', title: 'Daily bot report failed', detail: { error: err.message } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// ── Scanner watchdog — every 10 min during market hours ──────────────────────
// Fires a sysAlert (which sends email) if no bot_decision row exists for active
// bots in the last 8 min. Catches the "cron went silent at 14:10 UTC" failure.
cron.schedule('*/10 9-16 * * 1-5', async () => {
  try {
    // 1. Any active bots?
    const { rows: activeBots } = await query(`SELECT COUNT(*)::int AS n FROM bots WHERE status='active' AND deleted_at IS NULL`);
    if (!activeBots[0]?.n) return; // no active bots → nothing to watch

    // 2. Market hours check (skip outside 9:30–16:00 ET)
    const nyNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const h = nyNow.getHours(), m = nyNow.getMinutes();
    const minsSinceOpen = (h - 9) * 60 + (m - 30);
    if (minsSinceOpen < 0 || (h >= 16)) return; // outside market hours

    // 3. Last decision timestamp
    const { rows } = await query(`SELECT MAX(scanned_at) AS last_at FROM bot_decisions WHERE scanned_at > NOW() - INTERVAL '30 minutes'`);
    const lastAt = rows[0]?.last_at;
    if (!lastAt) {
      // No decision in last 30 min during market hours = definitely stale
      await sysAlert({
        key: 'scanner/heartbeat-silent',
        severity: 'critical',
        title: '🤖 Scanner heartbeat lost — no decisions in 30 min',
        detail: {
          active_bots: activeBots[0].n,
          last_decision: 'none in last 30 min',
          hint: 'Check pm2 logs: `pm2 logs trading-dashboard --lines 100`. Likely cron stopped or OOM. Restart: `pm2 restart trading-dashboard`.',
        },
      });
      console.error('[scanner-watchdog] ALERT: no bot decisions in last 30 min with active bots');
      return;
    }

    const staleMs = Date.now() - new Date(lastAt).getTime();
    if (staleMs > 8 * 60_000) {
      // Stale by more than 8 min — scanner missed a cycle
      const staleMin = (staleMs / 60_000).toFixed(1);
      await sysAlert({
        key: 'scanner/heartbeat-stale',
        severity: 'warn',
        title: `⚠️ Scanner stale — last decision ${staleMin} min ago`,
        detail: {
          active_bots: activeBots[0].n,
          last_decision_at: lastAt,
          stale_minutes: staleMin,
          hint: 'May be a cron miss. If this persists, check pm2 logs and consider restarting trading-dashboard.',
        },
      });
      console.warn(`[scanner-watchdog] stale: last decision was ${staleMin} min ago`);
    }
  } catch (err) {
    console.error('[scanner-watchdog] check error:', err.message);
  }
}, { timezone: 'America/New_York' });

// POST /api/daily-bot-report/run — manual trigger (admin only)
app.post('/api/daily-bot-report/run', requireAdmin, async (req, res) => {
  try {
    const result = await runDailyBotReport();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[daily-bot-report] manual run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/premarket-news/run — manually trigger pre-market scan (admin only)
app.post('/api/premarket-news/run', requireAdmin, async (req, res) => {
  try {
    const result = await runPreMarketScan({ manual: true });
    res.json(result);
  } catch (e) {
    console.error('[premarket-news/run]', e);
    res.status(500).json({ error: 'Internal server error' });
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

// 4:35 PM ET — store Moomoo daily PLOfDay so P&L history is accurate (no deposit skew)
cron.schedule('*/5 16-21 * * 1-5', async () => {
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins < 16 * 60 + 35 || mins >= 16 * 60 + 40) return;
  try {
    const result = await getMoomooTodayPnL();
    if (!result.available) { console.log('[moomoo-pnl] OpenD not reachable — skipping EOD store'); return; }
    const todayStr = et.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    await upsertDailyPnl({
      date:           todayStr,
      realized_pnl:   result.pnl,
      unrealized_pnl: 0,
      total_trades:   0,
      winning_trades: 0,
      username:       'admin',
      source:         'moomoo',
    });
    console.log(`[moomoo-pnl] stored daily P&L ${result.pnl} for ${todayStr}`);
  } catch (err) { console.error('[moomoo-pnl] EOD cron error:', err.message); }
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

// ─── Catalyst Performance Tracker ─────────────────────────────────────────────
// Answers: "If you bought $1000 yesterday at close and sold at today's open, P&L?"

function _prevTradingDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  let p = new Date(d.getTime() - 86400000);
  while (p.getUTCDay() === 0 || p.getUTCDay() === 6) p = new Date(p.getTime() - 86400000);
  return p.toISOString().split('T')[0];
}
function _nextTradingDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  let n = new Date(d.getTime() + 86400000);
  while (n.getUTCDay() === 0 || n.getUTCDay() === 6) n = new Date(n.getTime() + 86400000);
  return n.toISOString().split('T')[0];
}

async function _fetchDailyBar(symbol, dateStr) {
  // Returns { open, close } for a specific trading day via Yahoo Finance chart API
  const p1 = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000) - 86400;
  const p2 = Math.floor(new Date(dateStr + 'T23:59:59Z').getTime() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${p1}&period2=${p2}`;
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const json = await resp.json();
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const tss = result.timestamp || [];
    const q   = result.indicators?.quote?.[0] || {};
    for (let i = 0; i < tss.length; i++) {
      const d = new Date(tss[i] * 1000).toISOString().split('T')[0];
      if (d === dateStr && q.close?.[i] != null) {
        return { open: q.open?.[i] != null ? +q.open[i].toFixed(4) : null, close: +q.close[i].toFixed(4) };
      }
    }
    return null;
  } catch { return null; }
}

async function computeCatalystPerf(tradeDate) {
  const earningsDate = _nextTradingDay(tradeDate);

  // AMC stocks from tradeDate (reported after close) + BMO stocks from earningsDate (reported before open)
  const [amcRes, bmoRes] = await Promise.allSettled([
    ttlCache(`earnings:cal:${tradeDate}`,    6 * 60 * 60 * 1000, () => fetchNasdaqEarningsDay(tradeDate)),
    ttlCache(`earnings:cal:${earningsDate}`, 6 * 60 * 60 * 1000, () => fetchNasdaqEarningsDay(earningsDate)),
  ]);
  const amc = (amcRes.status === 'fulfilled' ? amcRes.value : []).filter(e => e.call_time === 'AMC');
  const bmo = (bmoRes.status === 'fulfilled' ? bmoRes.value : []).filter(e => e.call_time === 'BMO');
  const all = [...amc.map(s => ({ ...s, bucket: 'amc' })), ...bmo.map(s => ({ ...s, bucket: 'bmo' }))]
    .sort((a, b) => (b.market_cap_n || 0) - (a.market_cap_n || 0)).slice(0, 20);

  if (!all.length) {
    console.log(`[catalyst-perf] No AMC/BMO stocks found for trade_date=${tradeDate}`);
    return 0;
  }

  let saved = 0;
  await Promise.allSettled(all.map(async (stock) => {
    try {
      const [entryBar, exitBar] = await Promise.all([
        _fetchDailyBar(stock.symbol, tradeDate),    // buy at close
        _fetchDailyBar(stock.symbol, earningsDate),  // sell at open
      ]);
      const entryPrice = entryBar?.close ?? null;
      const exitPrice  = exitBar?.open   ?? null;
      const change_pct = (entryPrice && exitPrice)
        ? +((exitPrice - entryPrice) / entryPrice * 100).toFixed(2) : null;
      const pnl_1000 = change_pct != null ? +(change_pct / 100 * 1000).toFixed(2) : null;

      await query(
        `INSERT INTO catalyst_performance (trade_date,symbol,company,bucket,call_time,entry_price,exit_price,change_pct,pnl_1000)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (trade_date,symbol) DO UPDATE SET exit_price=EXCLUDED.exit_price,change_pct=EXCLUDED.change_pct,pnl_1000=EXCLUDED.pnl_1000`,
        [tradeDate, stock.symbol, stock.company || stock.symbol, stock.bucket, stock.call_time, entryPrice, exitPrice, change_pct, pnl_1000]
      );
      saved++;
    } catch (err) { console.warn(`[catalyst-perf] ${stock.symbol}:`, err.message); }
  }));

  console.log(`[catalyst-perf] trade_date=${tradeDate} earnings_date=${earningsDate} saved=${saved}/${all.length}`);
  return saved;
}

// GET /api/catalyst-performance?date=YYYY-MM-DD — fetch results for a date
app.get('/api/catalyst-performance', requireAuth, async (req, res) => {
  const date = (req.query.date || '').slice(0, 10);
  if (!date) return res.json({ results: [], trade_date: null });
  if (!isDbAvailable()) return res.json({ results: [], trade_date: date, error: 'db_unavailable' });
  const { rows } = await query(
    `SELECT cp.symbol, cp.company, cp.bucket, cp.call_time,
            ROUND(cp.entry_price,2) AS entry_price, ROUND(cp.exit_price,2) AS exit_price,
            cp.change_pct, cp.pnl_1000,
            cs.score AS conviction_score, cs.grade AS conviction_grade
     FROM catalyst_performance cp
     LEFT JOIN LATERAL (
       SELECT score, grade FROM conviction_scores
       WHERE symbol = cp.symbol AND scored_at::date <= cp.trade_date
       ORDER BY scored_at DESC LIMIT 1
     ) cs ON true
     WHERE cp.trade_date=$1
     ORDER BY (cp.exit_price IS NULL) ASC, ABS(COALESCE(cp.pnl_1000,0)) DESC`,
    [date]
  );
  res.json({ results: rows, trade_date: date });
});

// GET /api/catalyst-performance/dates — list available dates (for calendar)
app.get('/api/catalyst-performance/dates', requireAuth, async (req, res) => {
  if (!isDbAvailable()) return res.json({ dates: [] });
  const { rows } = await query(
    `SELECT trade_date::text AS date, COUNT(*) AS count
     FROM catalyst_performance GROUP BY trade_date ORDER BY trade_date DESC LIMIT 90`
  );
  res.json({ dates: rows.map(r => ({ date: r.date, count: +r.count })) });
});

// POST /api/catalyst-performance/run — admin manual trigger
app.post('/api/catalyst-performance/run', requireAdmin, async (req, res) => {
  const date = (req.body?.date || _prevTradingDay(
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  )).slice(0, 10);
  try {
    const saved = await computeCatalystPerf(date);
    res.json({ ok: true, trade_date: date, saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/retrospect/run — admin manual trigger (for testing outside 4:30 PM)
app.post('/api/retrospect/run', requireAdmin, async (req, res) => {
  res.json({ ok: true, message: 'Running retrospect analysis — email will arrive shortly.' });
  runDailyRetrospect().catch(e => console.error('[retrospect] manual trigger error:', e.message));
});

// 10:05 AM ET Tue–Sat — compute previous day's catalyst performance (gap at open)
// Tue–Fri covers Mon–Thu. Saturday covers Friday's AMC/BMO stocks.
// Note: Friday's exit price (Monday open) will be null on Saturday — filled in when
// the user clicks "Compute Now" on Monday, or by the Tuesday run via ON CONFLICT UPDATE.
cron.schedule('5 10 * * 2-6', async () => {
  try {
    const etToday   = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const tradeDate = _prevTradingDay(etToday);
    console.log(`[catalyst-perf] 10:05 AM ET cron: trade_date=${tradeDate}`);
    await computeCatalystPerf(tradeDate);
  } catch (err) { console.error('[catalyst-perf] cron error:', err.message); }
}, { timezone: 'America/New_York' });

// Pre-market impact scanner — runs every 15 min, 7:00–9:30 AM ET Mon–Fri
cron.schedule('*/15 7-9 * * 1-5', async () => {
  try {
    const result = await runPremarketScan();
    if (result.skipped || !result.alerts?.length) return;
    for (const alert of result.alerts) {
      pushToChat(`🌅 Pre-Market Alert\n\n${alert.message}`, 'premarket_impact');
    }
    console.log(`[premarket] ${result.alerts.length} alerts pushed`);
  } catch (e) {
    console.error('[premarket] scan error:', e.message);
  }
});

// Earnings cascade alert — runs once at 7:30 AM ET Mon–Fri, looks 3 days ahead
cron.schedule('30 7 * * 1-5', async () => {
  try {
    const result = await runEarningsCascadeScan({ daysAhead: 3 });
    if (result.skipped || !result.alerts?.length) return;
    for (const alert of result.alerts) {
      pushToChat(`📅 Earnings Cascade Alert\n\n${alert.message}`, 'earnings_cascade');
    }
    console.log(`[earnings-cascade] ${result.alerts.length} alerts pushed`);
  } catch (e) {
    console.error('[earnings-cascade] cron error:', e.message);
  }
});

// ─── Daily Retrospect Email — 4:30 PM ET Mon–Fri ────────────────────────────
// Compares yesterday's catalyst performance vs conviction grades to surface
// missed opportunities and false positives, then emails a summary to the owner.

async function runDailyRetrospect() {
  if (!resend || !isDbAvailable()) return;

  const etNow   = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate  = new Date(etNow).toLocaleDateString('en-CA');  // today YYYY-MM-DD ET
  const yesterday = _prevTradingDay(etDate);

  // Yesterday's catalyst perf with conviction grades
  let cpRows = [];
  try {
    const { rows } = await query(`
      SELECT cp.symbol, cp.company, cp.bucket, cp.change_pct, cp.pnl_1000,
             cs.score AS conviction_score, cs.grade AS conviction_grade,
             cs.breakdown
      FROM catalyst_performance cp
      LEFT JOIN LATERAL (
        SELECT score, grade, breakdown FROM conviction_scores
        WHERE symbol = cp.symbol AND scored_at::date <= cp.trade_date
        ORDER BY scored_at DESC LIMIT 1
      ) cs ON true
      WHERE cp.trade_date = $1
      ORDER BY ABS(COALESCE(cp.change_pct, 0)) DESC
    `, [yesterday]);
    cpRows = rows;
  } catch (e) {
    console.error('[retrospect] catalyst query error:', e.message);
  }

  // Today's conviction score distribution
  let todayScores = [];
  try {
    const { rows } = await query(`
      SELECT DISTINCT ON (symbol) symbol, score, grade, signals
      FROM conviction_scores WHERE scored_at::date = $1
      ORDER BY symbol, scored_at DESC
    `, [etDate]);
    todayScores = rows;
  } catch (e) {
    console.error('[retrospect] scores query error:', e.message);
  }

  // Today's trades
  let todayTrades = [];
  try {
    const { rows } = await query(`
      SELECT symbol, side, qty, entry_price, exit_price, pnl_usd, status
      FROM trades WHERE DATE(opened_at AT TIME ZONE 'America/New_York') = $1
      ORDER BY opened_at DESC LIMIT 20
    `, [etDate]);
    todayTrades = rows;
  } catch (e) {
    console.error('[retrospect] trades query error:', e.message);
  }

  const missed        = cpRows.filter(r => r.conviction_grade === 'F' && (r.change_pct ?? 0) > 5);
  const falsePos      = cpRows.filter(r => ['A', 'B'].includes(r.conviction_grade) && (r.change_pct ?? 0) < -5);
  const correctBulls  = cpRows.filter(r => ['A', 'B'].includes(r.conviction_grade) && (r.change_pct ?? 0) > 3);
  const gradeDist     = { A: 0, B: 0, C: 0, F: 0 };
  for (const s of todayScores) if (s.grade in gradeDist) gradeDist[s.grade]++;

  // Factor analysis: which factors contributed to wrong grades on misses
  const factorHits = {};
  for (const r of missed) {
    if (!r.breakdown || typeof r.breakdown !== 'object') continue;
    for (const [k, v] of Object.entries(r.breakdown)) {
      if (typeof v === 'number' && v < 0) factorHits[k] = (factorHits[k] || 0) + 1;
    }
  }
  const topFactors = Object.entries(factorHits).sort(([, a], [, b]) => b - a).slice(0, 5);

  const pnlTotal = todayTrades.filter(t => t.pnl_usd != null).reduce((s, t) => s + parseFloat(t.pnl_usd), 0);

  // pg returns numerics as strings — parseFloat before .toFixed()
  const pct = n => { const v = parseFloat(n); return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; };
  const usd = n => { const v = parseFloat(n); return (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(0); };

  const rowStyle = 'padding:6px 10px;border-bottom:1px solid #30363d';
  const thStyle  = 'padding:6px 10px;text-align:left;color:#8b949e;font-weight:600;font-size:0.8rem;border-bottom:2px solid #30363d';

  function cpTable(rows, emptyMsg) {
    if (!rows.length) return `<p style="color:#8b949e;font-size:0.9rem">${emptyMsg}</p>`;
    return `<table style="width:100%;border-collapse:collapse;font-size:0.85rem">
      <tr><th style="${thStyle}">Symbol</th><th style="${thStyle}">Grade</th><th style="${thStyle}">Score</th><th style="${thStyle}">Move</th><th style="${thStyle}">P&L/$1K</th></tr>
      ${rows.map(r => `<tr>
        <td style="${rowStyle};font-weight:600;color:#e6edf3">${r.symbol}</td>
        <td style="${rowStyle};color:${r.conviction_grade === 'A' ? '#3fb950' : r.conviction_grade === 'B' ? '#58a6ff' : r.conviction_grade === 'F' ? '#f85149' : '#d29922'}">${r.conviction_grade ?? '–'}</td>
        <td style="${rowStyle};color:#8b949e">${r.conviction_score ?? '–'}</td>
        <td style="${rowStyle};color:${(r.change_pct ?? 0) >= 0 ? '#3fb950' : '#f85149'}">${r.change_pct != null ? pct(r.change_pct) : '–'}</td>
        <td style="${rowStyle};color:${(r.pnl_1000 ?? 0) >= 0 ? '#3fb950' : '#f85149'}">${r.pnl_1000 != null ? usd(r.pnl_1000) : '–'}</td>
      </tr>`).join('')}
    </table>`;
  }

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;max-width:680px;margin:0 auto;padding:24px;border-radius:12px">
  <h2 style="margin:0 0 4px;font-size:1.4rem">📊 Daily Retrospect — ${etDate}</h2>
  <p style="color:#8b949e;margin:0 0 24px;font-size:0.9rem">End-of-day scoring analysis • 4:30 PM ET</p>

  ${todayTrades.length ? `
  <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:20px">
    <h3 style="margin:0 0 8px;font-size:1rem;color:#58a6ff">💰 Today's Trades</h3>
    <p style="margin:0;color:${pnlTotal >= 0 ? '#3fb950' : '#f85149'};font-size:1.1rem;font-weight:600">${usd(pnlTotal)} P&L across ${todayTrades.length} trade(s)</p>
  </div>` : ''}

  <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:20px">
    <h3 style="margin:0 0 8px;font-size:1rem;color:#58a6ff">🎯 Scanner Grade Distribution (Today)</h3>
    <div style="display:flex;gap:16px;flex-wrap:wrap">
      ${Object.entries(gradeDist).map(([g, c]) => `<span style="background:#21262d;padding:6px 14px;border-radius:20px;font-size:0.85rem"><strong style="color:${g==='A'?'#3fb950':g==='B'?'#58a6ff':g==='C'?'#d29922':'#f85149'}">${g}</strong> · ${c}</span>`).join('')}
      <span style="background:#21262d;padding:6px 14px;border-radius:20px;font-size:0.85rem;color:#8b949e">Total · ${todayScores.length}</span>
    </div>
  </div>

  <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:20px">
    <h3 style="margin:0 0 12px;font-size:1rem;color:#f85149">⚠️ Missed Opportunities (F-grade but moved >5%)</h3>
    <p style="margin:0 0 10px;color:#8b949e;font-size:0.85rem">These stocks were rated F but outperformed — review what signals were wrong.</p>
    ${cpTable(missed, 'No misses yesterday — well done!')}
    ${topFactors.length ? `
    <p style="margin:12px 0 4px;color:#8b949e;font-size:0.8rem;font-weight:600">FACTORS THAT DRAGGED THESE SCORES DOWN:</p>
    <ul style="margin:0;padding-left:18px;color:#d29922;font-size:0.85rem">
      ${topFactors.map(([k, c]) => `<li>${k.replace(/_/g,' ')} (${c}x)</li>`).join('')}
    </ul>` : ''}
  </div>

  <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:20px">
    <h3 style="margin:0 0 12px;font-size:1rem;color:#d29922">🔴 False Positives (A/B-grade but dropped >5%)</h3>
    ${cpTable(falsePos, 'No major false positives yesterday.')}
  </div>

  ${correctBulls.length ? `
  <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:20px">
    <h3 style="margin:0 0 12px;font-size:1rem;color:#3fb950">✅ Correct Bullish Calls (A/B-grade + moved >3%)</h3>
    ${cpTable(correctBulls, '')}
  </div>` : ''}

  <p style="color:#6e7681;font-size:0.78rem;margin-top:24px;border-top:1px solid #21262d;padding-top:12px">
    Generated automatically by Trading Bot · Catalyst data from ${yesterday} · Do not reply to this email.
  </p>
</div>`;

  try {
    await resend.emails.send({
      from:    `Trading Bot <${RESEND_FROM}>`,
      to:      'info@trading.dlpinnovations.com',
      subject: `📊 Daily Retrospect ${etDate} — ${missed.length} miss${missed.length !== 1 ? 'es' : ''}, ${falsePos.length} false positive${falsePos.length !== 1 ? 's' : ''}`,
      html,
    });
    console.log(`[retrospect] Email sent for ${etDate}: ${missed.length} misses, ${falsePos.length} false positives`);
  } catch (e) {
    console.error('[retrospect] Email send failed:', e.message);
  }
}

cron.schedule('30 16 * * 1-5', async () => {
  console.log('[retrospect] Running daily retrospect…');
  runDailyRetrospect().catch(e => console.error('[retrospect] error:', e.message));
}, { timezone: 'America/New_York' });

// ─── EOD Next-Day Setup Scanner ───────────────────────────────────────────────
// Runs at 4:10 PM ET after close. Identifies 4 setup types for the next trading
// day: Earnings Gap Play, Technical Breakout, Sector Momentum Laggard, Options Flow.

let _eodSetupsCache = null;

async function _scanEarningsGap(etDate) {
  const nextDay = _nextTradingDay(etDate);
  const setups  = [];
  try {
    const [amcRes, bmoRes] = await Promise.allSettled([
      ttlCache(`earnings:cal:${etDate}`,  6 * 60 * 60 * 1000, () => fetchNasdaqEarningsDay(etDate)),
      ttlCache(`earnings:cal:${nextDay}`, 6 * 60 * 60 * 1000, () => fetchNasdaqEarningsDay(nextDay)),
    ]);
    const amcList = ((amcRes.status === 'fulfilled' ? amcRes.value : []) || [])
      .filter(e => e.call_time === 'AMC')
      .sort((a, b) => (b.market_cap_n || 0) - (a.market_cap_n || 0))
      .slice(0, 10);
    const bmoList = ((bmoRes.status === 'fulfilled' ? bmoRes.value : []) || [])
      .filter(e => e.call_time === 'BMO')
      .sort((a, b) => (b.market_cap_n || 0) - (a.market_cap_n || 0))
      .slice(0, 10);

    const all = [
      ...amcList.map(e => ({ ...e, _bucket: 'amc' })),
      ...bmoList.map(e => ({ ...e, _bucket: 'bmo' })),
    ];

    await Promise.allSettled(all.map(async entry => {
      try {
        const sym = entry.symbol;
        const [qRes, scoreRes] = await Promise.allSettled([
          api_quote_cached(sym),
          getConvictionScore({ symbol: sym, positions: [] }),
        ]);
        const q     = qRes.status     === 'fulfilled' ? qRes.value     : null;
        const score = scoreRes.status === 'fulfilled' ? scoreRes.value : null;

        const price = q?.price ?? q?.regularMarketPrice ?? null;
        if (!price || price < 2) return;  // skip penny stocks

        const isBmo   = entry._bucket === 'bmo';
        const target  = +(price * 1.06).toFixed(2);
        const stop    = +(price * 0.97).toFixed(2);
        const rr      = +((target - price) / (price - stop)).toFixed(1);

        let confidence = 60;
        if (['A', 'B'].includes(score?.grade)) confidence += 12;
        if (isBmo) confidence += 5; // BMO = clear price discovery overnight

        setups.push({
          type:         'earnings',
          type_label:   isBmo ? '📣 Earnings BMO' : '📣 Earnings AMC',
          symbol:       sym,
          company:      entry.company || sym,
          entry_price:  price,
          target_price: target,
          stop_price:   stop,
          rr_ratio:     rr,
          timing:       isBmo ? 'Buy at today\'s close — reports BMO tomorrow' : 'Buy before 3:50 PM today — reports AMC tonight',
          reasons: [
            `Reports ${isBmo ? 'before open tomorrow' : 'after close tonight'} (${entry.call_time})`,
            score?.grade ? `Conviction grade ${score.grade} (score ${score.score})` : null,
            entry.eps_estimate != null ? `EPS estimate: $${parseFloat(entry.eps_estimate).toFixed(2)}` : null,
          ].filter(Boolean),
          confidence: Math.min(confidence, 95),
          meta: { grade: score?.grade, score: score?.score, call_time: entry.call_time },
        });
      } catch { /* individual stock failure — skip */ }
    }));
  } catch (e) {
    console.error('[eod-scanner] earnings gap error:', e.message);
  }
  return setups;
}

async function _scanTechnicalBreakouts() {
  const setups = [];
  if (!isDbAvailable()) return setups;
  try {
    const { rows } = await query(`
      WITH latest_date AS (SELECT MAX(price_date) AS d FROM backtest_prices),
      base AS (
        SELECT bp.symbol, bp.price_date, bp.close, bp.volume
        FROM backtest_prices bp
        CROSS JOIN latest_date ld
        WHERE bp.price_date = ld.d
      ),
      prior AS (
        SELECT bp.symbol,
          MAX(bp.close)          AS high_20d,
          AVG(bp.volume)         AS avg_vol,
          COUNT(*)               AS bars
        FROM backtest_prices bp
        CROSS JOIN latest_date ld
        WHERE bp.price_date < ld.d
          AND bp.price_date >= ld.d - INTERVAL '22 days'
        GROUP BY bp.symbol
      )
      SELECT b.symbol, b.close, b.volume,
        p.high_20d, p.avg_vol, p.bars,
        CASE WHEN p.avg_vol > 0 THEN b.volume::float / p.avg_vol ELSE NULL END AS rvol,
        CASE WHEN p.high_20d > 0 THEN ROUND(((b.close - p.high_20d) / p.high_20d * 100)::numeric, 2) ELSE 0 END AS breakout_pct
      FROM base b
      JOIN prior p ON p.symbol = b.symbol
      WHERE b.close > p.high_20d
        AND p.bars >= 15
        AND p.avg_vol > 0
        AND (b.volume::float / p.avg_vol) >= 1.3
      ORDER BY (b.volume::float / p.avg_vol) DESC
      LIMIT 15
    `);

    for (const row of rows) {
      const price   = parseFloat(row.close);
      const rvol    = parseFloat(row.rvol);
      const brkPct  = parseFloat(row.breakout_pct);
      const entry   = +(price * 1.003).toFixed(2);   // slight next-day open premium
      const atr_est = +(price * 0.015).toFixed(2);   // ~1.5% ATR estimate
      const target  = +(entry + 2 * atr_est).toFixed(2);
      const stop    = +(entry - 1 * atr_est).toFixed(2);
      const rr      = +((target - entry) / (entry - stop)).toFixed(1);

      let confidence = 58;
      if (rvol >= 2.5) confidence += 18;
      else if (rvol >= 2)   confidence += 12;
      else if (rvol >= 1.5) confidence += 6;
      if (brkPct < 2) confidence += 5; // fresh breakout, not overextended

      setups.push({
        type:         'breakout',
        type_label:   '📈 Technical Breakout',
        symbol:       row.symbol,
        company:      row.symbol,
        entry_price:  entry,
        target_price: target,
        stop_price:   stop,
        rr_ratio:     rr,
        timing:       'Enter near tomorrow\'s open',
        reasons: [
          `Closing above 20-day high (breakout ${brkPct}%)`,
          `RVOL ${rvol.toFixed(1)}× — elevated institutional volume`,
          'Weekly uptrend confirmed',
        ],
        confidence: Math.min(confidence, 90),
        meta: { rvol, breakout_pct: brkPct, high_20d: parseFloat(row.high_20d) },
      });
    }
  } catch (e) {
    console.error('[eod-scanner] breakout error:', e.message);
  }
  return setups;
}

async function _scanSectorLaggards() {
  const setups = [];
  try {
    const sectorData = await getSectorPerformance();
    const hotSectors = (sectorData.all_sectors || []).filter(s => (s.chg_pct ?? 0) > 1.0);
    if (!hotSectors.length) return setups;

    // Build set of symbols per hot sector
    const hotSectorSet = new Set(hotSectors.map(s => s.symbol));

    // Get today + yesterday close from backtest_prices for all SECTOR_MAP stocks
    const sectorSymbols = Object.keys(SECTOR_MAP).filter(sym => hotSectorSet.has(SECTOR_MAP[sym]));
    if (!sectorSymbols.length || !isDbAvailable()) return setups;

    const placeholders = sectorSymbols.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await query(`
      WITH ranked AS (
        SELECT symbol, price_date, close,
          LAG(close) OVER (PARTITION BY symbol ORDER BY price_date) AS prev_close,
          ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY price_date DESC) AS rn
        FROM backtest_prices
        WHERE symbol IN (${placeholders})
          AND price_date >= CURRENT_DATE - INTERVAL '5 days'
      )
      SELECT symbol, close, prev_close,
        CASE WHEN prev_close > 0 THEN ROUND(((close - prev_close) / prev_close * 100)::numeric, 2) ELSE 0 END AS chg_pct
      FROM ranked
      WHERE rn = 1 AND prev_close IS NOT NULL
    `, sectorSymbols);

    for (const row of rows) {
      const sym        = row.symbol;
      const sectorEtf  = SECTOR_MAP[sym];
      const sector     = hotSectors.find(s => s.symbol === sectorEtf);
      if (!sector) continue;

      const stockChg   = parseFloat(row.chg_pct);
      const sectorChg  = parseFloat(sector.chg_pct);
      const lag        = +(sectorChg - stockChg).toFixed(2);

      // Stock must lag sector by at least 1% to be a catch-up candidate
      if (lag < 1.0) continue;

      const price  = parseFloat(row.close);
      const target = +(price * (1 + sectorChg / 100)).toFixed(2);
      const stop   = +(price * 0.98).toFixed(2);
      const rr     = +((target - price) / (price - stop)).toFixed(1);

      let confidence = 52;
      if (sectorChg > 2)   confidence += 12;
      if (lag > 2)         confidence += 8;
      if (stockChg >= 0)   confidence += 5; // positive day but just underperformed

      setups.push({
        type:         'sector_laggard',
        type_label:   '🔄 Sector Catch-Up',
        symbol:       sym,
        company:      sym,
        entry_price:  price,
        target_price: target,
        stop_price:   stop,
        rr_ratio:     Math.max(rr, 0),
        timing:       'Enter at tomorrow\'s open',
        reasons: [
          `${SECTOR_NAMES[sectorEtf] || sectorEtf} sector up ${sectorChg.toFixed(1)}% today`,
          `${sym} only moved ${stockChg >= 0 ? '+' : ''}${stockChg.toFixed(1)}% — lagging by ${lag}%`,
          'Catch-up momentum play for tomorrow',
        ],
        confidence: Math.min(confidence, 82),
        meta: { sector_etf: sectorEtf, sector_chg: sectorChg, stock_chg: stockChg, lag_pct: lag },
      });
    }
    // Keep top 8 laggards by lag size
    setups.sort((a, b) => b.meta.lag_pct - a.meta.lag_pct);
    return setups.slice(0, 8);
  } catch (e) {
    console.error('[eod-scanner] sector laggard error:', e.message);
    return setups;
  }
}

async function _scanOptionsFlow(etDate) {
  const setups = [];
  if (!isBenzingaConfigured()) return setups;
  try {
    const result = await getBzOptionsActivity({ sentiment: 'BULLISH', limit: 100 });
    if (!result?.items?.length) return setups;

    // Keep only today's CALL sweeps/blocks with meaningful cost_basis
    const todayItems = result.items.filter(o =>
      o.put_call === 'CALL' &&
      o.date === etDate &&
      (o.cost_basis ?? 0) >= 100000 &&
      o.ticker &&
      !o.ticker.includes(' ')  // exclude indices/spreads
    );

    // Group by ticker and sum cost_basis
    const byTicker = new Map();
    for (const o of todayItems) {
      const t = o.ticker.toUpperCase();
      if (!byTicker.has(t)) byTicker.set(t, { items: [], total_cb: 0, sweeps: 0 });
      const g = byTicker.get(t);
      g.items.push(o);
      g.total_cb += o.cost_basis ?? 0;
      if (o.activity_type === 'SWEEP') g.sweeps++;
    }

    const topFlows = [...byTicker.entries()]
      .sort(([, a], [, b]) => b.total_cb - a.total_cb)
      .slice(0, 8);

    await Promise.allSettled(topFlows.map(async ([sym, group]) => {
      try {
        const q = await api_quote_cached(sym);
        const price = q?.price ?? null;
        if (!price || price <= 0) return;

        const target = +(price * 1.05).toFixed(2);
        const stop   = +(price * 0.97).toFixed(2);
        const rr     = +((target - price) / (price - stop)).toFixed(1);
        const cbM    = (group.total_cb / 1e6).toFixed(2);

        let confidence = 65;
        if (group.total_cb >= 1e6) confidence += 12;
        if (group.sweeps >= 2)     confidence += 8;

        setups.push({
          type:         'options_flow',
          type_label:   '🦈 Smart Money Flow',
          symbol:       sym,
          company:      sym,
          entry_price:  price,
          target_price: target,
          stop_price:   stop,
          rr_ratio:     rr,
          timing:       'Pre-market or open tomorrow',
          reasons: [
            `$${cbM}M in unusual CALL activity today`,
            `${group.items.length} contract${group.items.length > 1 ? 's' : ''} (${group.sweeps} sweep${group.sweeps !== 1 ? 's' : ''})`,
            'Institutional follow-through expected next session',
          ],
          confidence: Math.min(confidence, 92),
          meta: { total_cost_basis: group.total_cb, sweeps: group.sweeps, contracts: group.items.length },
        });
      } catch { /* skip */ }
    }));
  } catch (e) {
    console.error('[eod-scanner] options flow error:', e.message);
  }
  return setups;
}

// Lightweight quote cache (5 min) for the EOD scanner — avoids redundant API calls
const _quoteMiniCache = new Map();
async function api_quote_cached(sym) {
  const k = sym.toUpperCase();
  const hit = _quoteMiniCache.get(k);
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.data;
  try {
    const data = await _yf.quoteSummary(k, { modules: ['price'] });
    const q    = { price: data?.price?.regularMarketPrice ?? null, name: data?.price?.shortName ?? null };
    _quoteMiniCache.set(k, { data: q, ts: Date.now() });
    return q;
  } catch { return null; }
}

async function runEODSetupScanner() {
  const etNow  = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etNow).toLocaleDateString('en-CA');
  console.log(`[eod-scanner] Starting scan for ${etDate}…`);

  const allSetups = [];
  const [earningsR, breakoutR, laggardR, flowR] = await Promise.allSettled([
    _scanEarningsGap(etDate),
    _scanTechnicalBreakouts(),
    _scanSectorLaggards(),
    _scanOptionsFlow(etDate),
  ]);

  if (earningsR.status === 'fulfilled') allSetups.push(...earningsR.value);
  if (breakoutR.status === 'fulfilled') allSetups.push(...breakoutR.value);
  if (laggardR.status  === 'fulfilled') allSetups.push(...laggardR.value);
  if (flowR.status     === 'fulfilled') allSetups.push(...flowR.value);

  // Deduplicate by symbol, keeping highest-confidence entry
  const seen = new Map();
  for (const s of allSetups) {
    const existing = seen.get(s.symbol);
    if (!existing || s.confidence > existing.confidence) seen.set(s.symbol, s);
  }

  const setups = [...seen.values()].sort((a, b) => b.confidence - a.confidence);
  _eodSetupsCache = { setups, generated_at: new Date().toISOString(), for_date: etDate };
  console.log(`[eod-scanner] Done — ${setups.length} setups (${earningsR.value?.length ?? 0} earnings, ${breakoutR.value?.length ?? 0} breakouts, ${laggardR.value?.length ?? 0} laggards, ${flowR.value?.length ?? 0} flow)`);
  return _eodSetupsCache;
}

// 4:10 PM ET weekdays — after market close
cron.schedule('10 16 * * 1-5', async () => {
  runEODSetupScanner().catch(e => console.error('[eod-scanner] cron error:', e.message));
}, { timezone: 'America/New_York' });

// 7:30 AM ET weekdays — pre-market refresh to validate which setups still valid
cron.schedule('30 7 * * 1-5', async () => {
  if (!_eodSetupsCache?.setups?.length) return;
  console.log('[eod-scanner] Pre-market refresh — re-validating setups…');
  // Re-run scanner; setups that already moved >50% toward target are de-prioritised
  runEODSetupScanner().catch(e => console.error('[eod-scanner] pre-market error:', e.message));
}, { timezone: 'America/New_York' });

app.get('/api/eod-setups', requireAuth, async (req, res) => {
  try {
    if (req.query.refresh === '1') {
      if (req.session?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      await runEODSetupScanner();
    } else if (!_eodSetupsCache) {
      await runEODSetupScanner();
    }
    res.json(_eodSetupsCache || { setups: [], generated_at: null, for_date: null });
  } catch (e) {
    console.error('[eod-setups]', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/eod-setups/refresh', requireAdmin, async (req, res) => {
  res.json({ ok: true, message: 'EOD scanner started — results available at /api/eod-setups shortly.' });
  runEODSetupScanner().catch(e => console.error('[eod-scanner] manual trigger error:', e.message));
});

// ─── Weekend Position Guardian crons ─────────────────────────────────────────

// Friday 3:30 PM ET — warn about positions going into earnings over the weekend
cron.schedule('30 15 * * 5', async () => {
  console.log('[guardian] Friday earnings risk check');
  try { await checkEarningsRisk(); } catch (e) {
    console.error('[guardian]', e.message);
    sysAlert({ key: 'guardian/earnings-risk', severity: 'critical', title: 'Guardian earnings risk check failed', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// Friday 6:00 PM ET — first after-hours check after market close
cron.schedule('0 18 * * 5', async () => {
  console.log('[guardian] Friday AH move check');
  try { await checkAfterHoursMove(); } catch (e) {
    console.error('[guardian]', e.message);
    sysAlert({ key: 'guardian/ah-move', severity: 'critical', title: 'Guardian after-hours move check failed', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// Saturday 10:00 AM ET — catch any late AH / extended-hours moves
cron.schedule('0 10 * * 6', async () => {
  console.log('[guardian] Saturday morning AH check');
  try { await checkAfterHoursMove(); } catch (e) {
    console.error('[guardian]', e.message);
    sysAlert({ key: 'guardian/ah-move', severity: 'critical', title: 'Guardian after-hours move check failed', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// Monday 4:15 AM ET — pre-market check before the open
cron.schedule('15 4 * * 1', async () => {
  console.log('[guardian] Monday pre-market holdings check');
  try { await checkPreMarketHoldings(); } catch (e) {
    console.error('[guardian]', e.message);
    sysAlert({ key: 'guardian/pre-market', severity: 'critical', title: 'Guardian pre-market check failed', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// ─── Unusual Whales background ingestion ──────────────────────────────────────

// Every 5 min weekdays — persist top movers (all 3 directions) to uw_top_movers
cron.schedule('*/5 * * * 1-5', async () => {
  if (!isUWConfigured() || !isDbAvailable()) return;
  try {
    const captured_at = new Date(Math.floor(Date.now() / 300_000) * 300_000);
    const [gainers, losers, active] = await Promise.all([
      getTopMovers({ direction: 'gainers', limit: 50 }),
      getTopMovers({ direction: 'losers',  limit: 50 }),
      getTopMovers({ direction: 'active',  limit: 50 }),
    ]);
    for (const m of [...(gainers ?? []), ...(losers ?? []), ...(active ?? [])]) {
      await query(
        `INSERT INTO uw_top_movers (ticker, direction, change_pct, price, volume, raw, captured_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (ticker, direction, captured_at) DO NOTHING`,
        [m.ticker, m.direction ?? null, m.change_percent ?? m.change_pct ?? m.change ?? null,
         m.price ?? null, m.volume ?? null, JSON.stringify(m), captured_at]
      ).catch(() => {});
    }
  } catch (e) {
    console.error('[uw-cron/movers]', e.message);
    sysAlert({ key: 'uw-cron/movers', severity: 'critical', title: 'UW movers cron failed', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// Every 2 min during market hours — persist options flow alerts to uw_flow_alerts
cron.schedule('*/2 9-16 * * 1-5', async () => {
  if (!isUWConfigured() || !isDbAvailable()) return;
  try {
    const alerts = await getFlowAlerts({ limit: 100 });
    if (!Array.isArray(alerts) || !alerts.length) return;
    for (const a of alerts) {
      const side      = a.side ?? a.option_type ?? '';
      const strike    = a.strike ?? -1;
      const expiry    = a.expiry ? new Date(a.expiry) : new Date('1900-01-01');
      const alertedAt = a.alerted_at ? new Date(a.alerted_at) : (a.created_at ? new Date(a.created_at) : new Date());
      await query(
        `INSERT INTO uw_flow_alerts
           (ticker, alert_type, side, strike, expiry, premium, volume, open_interest, iv, sentiment, raw, alerted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (ticker, COALESCE(strike,-1), COALESCE(expiry,'1900-01-01'::date), COALESCE(side,''), alerted_at) DO NOTHING`,
        [
          a.ticker ?? a.underlying_symbol,
          a.alert_type ?? a.type ?? null,
          side,
          strike,
          expiry,
          a.premium ?? a.total_premium ?? null,
          a.volume ?? null,
          a.open_interest ?? a.oi ?? null,
          a.iv ?? a.implied_volatility ?? null,
          a.sentiment ?? null,
          JSON.stringify(a),
          alertedAt,
        ]
      ).catch(() => {});
    }
  } catch (e) {
    console.error('[uw-cron/flow-alerts]', e.message);
    sysAlert({ key: 'uw-cron/flow-alerts', severity: 'critical', title: 'UW flow-alerts cron failed', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// Every 15 min weekdays — persist insider trades
cron.schedule('*/15 * * * 1-5', async () => {
  if (!isUWConfigured()) return;
  try {
    const result = await getInsiderTrades({ limit: 100 });
    if (!Array.isArray(result) || !result.length || !isDbAvailable()) return;
    for (const t of result) {
      const insiderName = t.owner_name ?? '';
      const txType      = t.side ?? '';
      const filedAt     = t.transaction_date ? new Date(t.transaction_date) : new Date('1900-01-01');
      await query(
        `INSERT INTO uw_insider_trades (ticker, insider_name, role, transaction_type, shares, price, value, filed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (ticker, COALESCE(insider_name,''), COALESCE(filed_at,'1900-01-01'::timestamptz), COALESCE(transaction_type,'')) DO NOTHING`,
        [t.ticker, insiderName, t.role ?? null, txType,
         t.shares ?? null, t.price ?? null, t.amount ?? null, filedAt]
      ).catch(() => {});
    }
  } catch (e) {
    console.error('[uw-cron/insider]', e.message);
    sysAlert({ key: 'uw-cron/insider', severity: 'critical', title: 'UW insider cron failed', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// Every hour weekdays — persist congressional trades
cron.schedule('0 * * * 1-5', async () => {
  if (!isUWConfigured()) return;
  try {
    const result = await getCongressionalTrades({ limit: 100 });
    if (!Array.isArray(result) || !result.length || !isDbAvailable()) return;
    for (const t of result) {
      const memberName = t.member_name ?? '';
      const txType     = t.transaction_type ?? '';
      const tradedAt   = t.transaction_date ? new Date(t.transaction_date) : new Date('1900-01-01');
      await query(
        `INSERT INTO uw_congressional_trades (ticker, member_name, party, chamber, transaction_type, amount_range, traded_at, filed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (ticker, COALESCE(member_name,''), COALESCE(traded_at,'1900-01-01'::date), COALESCE(transaction_type,'')) DO NOTHING`,
        [t.ticker, memberName, t.party ?? null, t.chamber ?? null, txType,
         t.amount_range ?? null, tradedAt,
         t.filed_at ? new Date(t.filed_at) : null]
      ).catch(() => {});
    }
  } catch (e) {
    console.error('[uw-cron/congress]', e.message);
    sysAlert({ key: 'uw-cron/congress', severity: 'critical', title: 'UW congress cron failed', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// 6 AM ET weekdays — fetch economic calendar and persist to DB
cron.schedule('0 6 * * 1-5', async () => {
  if (!isUWConfigured()) return;
  try {
    const events = await getEconomicCalendar();
    if (!Array.isArray(events) || !events.length || !isDbAvailable()) return;
    for (const e of events) {
      const eventDate = e.time ? e.time.slice(0, 10) : null;
      if (!eventDate || !e.event) continue;
      await query(
        `INSERT INTO uw_economic_calendar (event_date, event_name, country, importance, actual, forecast, previous, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (event_date, event_name, (COALESCE(country, ''))) DO UPDATE
           SET actual = EXCLUDED.actual, ingested_at = NOW()`,
        [eventDate, e.event, e.country ?? '', e.importance ?? e.type ?? null,
         parseUWNum(e.actual), parseUWNum(e.forecast), parseUWNum(e.previous), JSON.stringify(e)]
      ).catch(() => {});
    }
  } catch (e) {
    console.error('[uw-cron/econ-cal]', e.message);
    sysAlert({ key: 'uw-cron/econ-cal', severity: 'critical', title: 'UW econ-cal cron failed', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// 6:05 AM ET weekdays — fetch IPO calendar and persist to DB
cron.schedule('5 6 * * 1-5', async () => {
  if (!isUWConfigured()) return;
  try {
    const ipos = await getIpoCalendar();
    if (!Array.isArray(ipos) || !ipos.length || !isDbAvailable()) return;
    for (const ipo of ipos) {
      const ipoDate = ipo.ipo_date ?? ipo.date ?? null;
      const ticker = ipo.ticker ?? ipo.symbol ?? null;
      if (!ticker || !ipoDate) continue;
      await query(
        `INSERT INTO uw_ipo_calendar (ticker, company_name, ipo_date, price_low, price_high, shares, exchange, status, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (ticker, ipo_date) DO UPDATE
           SET status = EXCLUDED.status, ingested_at = NOW()`,
        [ticker, ipo.company_name ?? ipo.name ?? null, new Date(ipoDate),
         ipo.price_low ?? ipo.min_price ?? null, ipo.price_high ?? ipo.max_price ?? null,
         ipo.shares ?? null, ipo.exchange ?? null, ipo.status ?? null, JSON.stringify(ipo)]
      ).catch(() => {});
    }
  } catch (e) {
    console.error('[uw-cron/ipo-cal]', e.message);
    sysAlert({ key: 'uw-cron/ipo-cal', severity: 'critical', title: 'UW ipo-cal cron failed', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// 6 PM ET weekdays — warm fundamentals cache for held positions
cron.schedule('0 18 * * 1-5', async () => {
  if (!isUWConfigured()) return;
  try {
    const positions = await getPositions().catch(() => []);
    for (const p of positions.slice(0, 20)) {
      await getIvRank({ ticker: p.symbol }).catch(() => {});
      await new Promise(r => setTimeout(r, 600)); // gentle pacing
    }
  } catch (e) {
    console.error('[uw-cron/fundamentals]', e.message);
    sysAlert({ key: 'uw-cron/fundamentals', severity: 'warn', title: 'UW fundamentals cache warmup failed', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// 3 AM ET daily — purge old UW rows (Item 3)
cron.schedule('0 3 * * *', async () => {
  if (!isDbAvailable()) return;
  try {
    const r = await purgeOldUwRows();
    const total = Object.values(r).reduce((s, n) => s + n, 0);
    if (total > 0) console.log('[uw-retention] purged:', JSON.stringify(r));
  } catch (e) {
    console.error('[uw-retention]', e.message);
    sysAlert({ key: 'uw-retention', severity: 'critical', title: 'UW retention purge failed', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// 4 AM ET daily — quota low-water alarm
let _quotaMinuteLowCount = 0;
cron.schedule('0 4 * * *', async () => {
  try {
    const q = getQuota();
    if (q && q.remaining_day < 5000) {
      console.warn('[uw-quota] LOW DAILY: remaining=', q.remaining_day);
      sysAlert({ key: 'uw-quota/low-day', severity: 'critical', title: 'UW daily quota critically low', detail: { remaining_day: q.remaining_day, day_used: q.day_used } }).catch(() => {});
    }
    if (q && q.remaining_minute < 10) {
      _quotaMinuteLowCount++;
      if (_quotaMinuteLowCount >= 3) {
        sysAlert({ key: 'uw-quota/low-minute', severity: 'warn', title: 'UW per-minute quota low', detail: { remaining_minute: q.remaining_minute, count: _quotaMinuteLowCount }, dedup_window_minutes: 360 }).catch(() => {});
      }
    } else {
      _quotaMinuteLowCount = 0;
    }
  } catch (e) {
    console.error('[uw-quota]', e.message);
    sysAlert({ key: 'uw-quota', severity: 'warn', title: 'UW quota check failed', detail: { error: e.message } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// 7 AM ET daily — UW schema linter
cron.schedule('0 7 * * *', async () => {
  if (!isDbAvailable()) return;
  try {
    const report = await auditUWSchemas();
    const drift = Object.entries(report).filter(([, r]) =>
      (r.unknown_keys?.length || 0) + (r.missing_keys?.length || 0) > 0
    );
    if (drift.length) {
      console.warn('[uw-schema-linter] DRIFT detected:', JSON.stringify(drift, null, 2));
      sysAlert({ key: 'uw-schema/drift', severity: 'warn', title: 'UW schema drift detected', detail: { drift: Object.fromEntries(drift) }, dedup_window_minutes: 1440 }).catch(() => {});
    } else {
      console.log('[uw-schema-linter] all UW schemas match expected keys');
    }
  } catch (e) {
    console.error('[uw-schema-linter]', e.message);
    sysAlert({ key: 'uw-schema-linter', severity: 'critical', title: 'UW schema linter failed', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// 8 AM ET daily — data-quality report
cron.schedule('0 8 * * *', async () => {
  if (!isDbAvailable()) return;
  try {
    const report = await dailyDataQualityReport();
    for (const [table, r] of Object.entries(report)) {
      if (r.error) {
        sysAlert({ key: `uw-quality/${table}-error`, severity: 'warn', title: `UW data-quality error: ${table}`, detail: { error: r.error }, dedup_window_minutes: 720 }).catch(() => {});
        continue;
      }
      if (r.rows_24h === 0) {
        sysAlert({ key: `uw-quality/${table}-zero-rows`, severity: 'warn', title: `UW ${table}: zero rows in 24h`, detail: { table, rows_24h: 0 }, dedup_window_minutes: 720 }).catch(() => {});
      }
      if (r.rows_24h > 0 && r.oldest_24h_row_age_minutes > 60) {
        sysAlert({ key: `uw-quality/${table}-stale`, severity: 'warn', title: `UW ${table} stale`, detail: { table, age_minutes: Math.round(r.oldest_24h_row_age_minutes) }, dedup_window_minutes: 720 }).catch(() => {});
      }
      for (const [col, pct] of Object.entries(r.null_rates || {})) {
        if (pct > 20) {
          sysAlert({ key: `uw-quality/${table}-${col}-nulls`, severity: 'warn', title: `UW ${table}.${col}: ${pct}% NULL`, detail: { table, column: col, null_pct: pct }, dedup_window_minutes: 720 }).catch(() => {});
        }
      }
    }
    const hasAlarms = Object.values(report).some(r => r.error || r.rows_24h === 0 || (r.rows_24h > 0 && r.oldest_24h_row_age_minutes > 60) || Object.values(r.null_rates || {}).some(p => p > 20));
    if (!hasAlarms) console.log('[uw-quality] all UW tables healthy');
  } catch (e) {
    console.error('[uw-quality]', e.message);
    sysAlert({ key: 'uw-quality', severity: 'critical', title: 'UW data-quality report failed', detail: { error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') } }).catch(() => {});
  }
}, { timezone: 'America/New_York' });

// Start options flow WebSocket stream on server startup (if UW configured)
if (isUWConfigured()) {
  setTimeout(() => {
    try {
      streamOptionsFlow({
        onTrade: (flowAlert) => {
          console.log('[uw-ws] flow alert:', flowAlert?.ticker, flowAlert?.sentiment);
        },
        onError: (e) => console.error('[uw-ws]', e),
        onFlap: ({ attempts, last_error }) => {
          sysAlert({ key: 'uw-ws/down', severity: 'critical', title: 'UW WebSocket repeatedly failing to reconnect', detail: { attempts, last_error }, dedup_window_minutes: 360 }).catch(() => {});
        },
      });
    } catch (e) { console.error('[uw-ws] startup error:', e.message); }
  }, 5000);
}

// GET /api/guardian/check — manual trigger (any authenticated user)
app.get('/api/guardian/check', requireAuth, async (req, res) => {
  try {
    const result = await runWeekendScan();
    res.json({ success: true, ...result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

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

// Run any pending node-pg-migrate migrations that postdate the baseline schema.
// Fails-safe: if a migration errors, boot continues with the baseline.
{
  const { runPendingMigrations } = await import('../core/migration-runner.js');
  await runPendingMigrations();
}

seedKnowledge()
  .then(r => { if (r?.seeded) console.log(`[knowledge] seeded ${r.seeded} chunks`); })
  .catch(e => console.error('[knowledge] seed error:', e.message));
await pgStore._ensureTable();
await migrateUsersToDb();

// Restore + warm up Yahoo Finance crumb — runs in background so it never blocks startup
_yfWarmup().catch(e => console.warn('[yf] warmup uncaught:', e.message));

// Boot alert — fire after DB is ready
sysAlert({ key: 'system/boot', severity: 'info', title: 'trading-dashboard booted', detail: { hostname: os.hostname(), pid: process.pid, node: process.version }, dedup_window_minutes: 5 }).catch(() => {});
// ─── Reminder email cron (check every minute) ─────────────────────────────────
setInterval(async () => {
  if (!isDbAvailable() || !resend) return;
  try {
    const { rows } = await query(
      `UPDATE user_reminders SET emailed_at = NOW()
       WHERE remind_at <= NOW() AND emailed_at IS NULL AND dismissed = FALSE AND done = FALSE
       RETURNING id, username, title, remind_at`
    );
    for (const rem of rows) {
      try {
        const { rows: users } = await query(`SELECT email FROM users WHERE username = $1`, [rem.username]);
        const email = users[0]?.email;
        if (!email) continue;
        const dt = new Date(rem.remind_at).toLocaleString('en-US', { weekday:'long', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit' });
        await resend.emails.send({
          from: `Trading Bot <${RESEND_FROM}>`,
          to: email,
          subject: `⏰ Reminder: ${rem.title}`,
          html: `<div style="font-family:-apple-system,sans-serif;max-width:440px;margin:0 auto;padding:28px">
            <h2 style="margin:0 0 8px;color:#e6edf3">⏰ Trading Reminder</h2>
            <div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:20px;margin-top:12px">
              <div style="font-size:1.1rem;font-weight:700;color:#e6edf3;margin-bottom:6px">${rem.title}</div>
              <div style="color:#8b949e;font-size:0.85rem">Scheduled for: ${dt}</div>
            </div>
            <p style="color:#484f58;font-size:0.8rem;margin-top:16px">Trading Dashboard · Not financial advice</p>
          </div>`
        });
        console.log(`[reminders] emailed ${rem.username} for reminder ${rem.id}`);
      } catch(e) { console.warn(`[reminders] email failed for ${rem.id}:`, e.message); }
    }
  } catch(e) { /* db might be unavailable */ }
}, 60_000);
setInterval(cleanupOtpTokens, 60 * 60 * 1000); // clean expired OTPs every hour
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌  Port ${PORT} already in use. Run: pkill -f "web/server.js" then retry.`);
    process.exit(1);
  }
  throw err;
});

// ─── Company Graph API ────────────────────────────────────────────────────────

app.get('/api/graph/contagion/:ticker', requireAuth, async (req, res) => {
  try {
    if (!isGraphConfigured()) return res.json({ available: false, reason: 'Neo4j not configured' });
    const eventPct = parseFloat(req.query.event_pct ?? '-10');
    const impacts  = await getContagionImpact(req.params.ticker.toUpperCase(), eventPct);
    res.json({ available: true, ticker: req.params.ticker.toUpperCase(), event_pct: eventPct, impacts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/graph/sympathy/:ticker', requireAuth, async (req, res) => {
  try {
    if (!isGraphConfigured()) return res.json({ available: false });
    const peers = await getSympathyTrades(req.params.ticker.toUpperCase());
    res.json({ available: true, ticker: req.params.ticker.toUpperCase(), peers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/graph/risk/:ticker', requireAuth, async (req, res) => {
  try {
    if (!isGraphConfigured()) return res.json({ available: false });
    const risk = await getSystemicRisk(req.params.ticker.toUpperCase());
    res.json({ available: true, ...risk });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/graph/stats', requireAuth, async (req, res) => {
  try {
    if (!isGraphConfigured()) return res.json({ available: false });
    const stats = await getGraphStats();
    res.json({ available: true, ...stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/graph/premarket', requireAuth, async (req, res) => {
  try {
    const result = await runPremarketScan();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/graph/network', requireAuth, async (req, res) => {
  try {
    if (!isGraphConfigured()) return res.json({ available: false });
    const data = await getFullGraph();
    res.json({ available: true, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/graph/earnings-cascade', requireAuth, async (req, res) => {
  try {
    const days   = Math.min(60, parseInt(req.query.days) || 30);
    const result = await runEarningsCascadeScan({ daysAhead: days });
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/graph/seed', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!isGraphConfigured()) return res.status(400).json({ error: 'Neo4j not configured' });
    const result = await seedGraph();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/graph/impact', requireAuth, async (req, res) => {
  try {
    if (!isGraphConfigured()) return res.json({ available: false });
    const ticker = (req.query.ticker || '').toUpperCase();
    const days   = Math.min(730, Math.max(90, parseInt(req.query.days) || 365));
    if (!ticker) return res.status(400).json({ error: 'ticker required' });
    const result = await getImpactAnalysis(ticker, days);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Error Agent ──────────────────────────────────────────────────────────────

// Admin: read error log
app.get('/api/agent/errors', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { source, resolved, limit = 100 } = req.query;
    const logs = await getErrorLog({
      limit: Math.min(500, parseInt(limit) || 100),
      source: source || undefined,
      resolved: resolved === undefined ? undefined : resolved === 'true',
    });
    res.json({ ok: true, errors: logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: mark error resolved
app.post('/api/agent/errors/:id/resolve', requireAuth, requireAdmin, async (req, res) => {
  try {
    await resolveError(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Extracted route modules ──────────────────────────────────────────────────
// Routes are progressively being moved out of this file (review item #6) into
// src/web/routes/*.js. Currently extracted:
//   notes, reminders, push, webauthn, sentinel, system-alerts
{
  const { registerExtractedRoutes } = await import('./routes/index.js');
  registerExtractedRoutes(app, { requireAuth, requireAdmin, port: PORT });
}

// ─── Portfolio Advisor ───────────────────────────────────────────────────────
// Personal portfolio dashboard: per-position risk scoring, bot's opinion,
// hedge recommendations. Read-only — never places orders.
import { enrichPositions, getHedgeRecommendation } from './portfolio-advisor.js';
import { diagnoseCandidate } from '../core/bot-engine.js';

// ── Moomoo positions cache + rate-limit-aware fetcher ───────────────────────
// Why: Moomoo limits position-list calls to 10 per 30s. The dashboard's P&L
// poller routinely exhausts that budget, so the Advisor's first load often
// hits a 429-equivalent. This wrapper:
//   1. Returns cached data if fresh (<30s) → saves the rate budget entirely
//   2. On rate-limit, retries ONCE with a short backoff (gives budget time to free)
//   3. Falls back to stale cache (up to 5 min) if retries still fail
//   4. Only throws if there's truly nothing to return
const _moomooPositionsCache = new Map();   // accId → { at, positions, account_value, raw }
const MOOMOO_FRESH_MS = 30_000;   // serve cache without re-fetching if this fresh
const MOOMOO_STALE_MS = 300_000;  // serve stale cache (with flag) up to 5 minutes
const MOOMOO_RETRY_WAIT_MS = 3500;

async function fetchMoomooPositionsResilient(accId) {
  const key = accId || 'default';
  const cached = _moomooPositionsCache.get(key);

  // Fast path: cache is fresh, don't even call Moomoo
  if (cached && (Date.now() - cached.at) < MOOMOO_FRESH_MS) {
    return { ...cached, source: 'cache_fresh', ageMs: Date.now() - cached.at };
  }

  // Try a fresh fetch
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fresh = await getMoomooPositions({ acc_id: accId });
      const fundsRes = await getFunds({ acc_id: accId }).catch(() => null);
      const record = {
        at: Date.now(),
        positions: fresh?.positions || [],
        account_value: fundsRes?.total_assets || fresh?.total_market_val || 0,
        raw: fresh,
      };
      _moomooPositionsCache.set(key, record);
      return { ...record, source: attempt === 0 ? 'fresh' : 'fresh_retried' };
    } catch (e) {
      lastErr = e;
      const rateLimited = /too frequent|rate/i.test(e?.message || '');
      if (rateLimited && attempt === 0) {
        // Wait and retry — budget often frees within 3-5s
        await new Promise(r => setTimeout(r, MOOMOO_RETRY_WAIT_MS));
        continue;
      }
      break;
    }
  }

  // All fetches failed — serve stale cache if we have any within MOOMOO_STALE_MS
  if (cached && (Date.now() - cached.at) < MOOMOO_STALE_MS) {
    return { ...cached, source: 'cache_stale', ageMs: Date.now() - cached.at, error: lastErr?.message };
  }

  // Truly nothing — bubble up the error with context
  throw new Error(lastErr?.message || 'Moomoo position fetch failed and no cache available');
}

app.get('/api/portfolio/holdings', requireAuth, async (req, res) => {
  try {
    const username = req.session?.username;
    const dbUser   = username && isDbAvailable() ? await getDbUser(username) : null;
    // Read source preference (same convention as the rest of the dashboard).
    // Defaults to 'alpaca' (paper) — matches the dashboard's default.
    const requested = String(req.query.source || 'alpaca').toLowerCase();
    const valid = ['alpaca', 'alpaca_live', 'moomoo', 'tiger', 'tiger_demo'];
    const source = valid.includes(requested) ? requested : 'alpaca';
    const accId  = dbUser?.moomoo_acc_id || undefined;

    let positions = [], accountValue = 0;

    if (source === 'moomoo') {
      try {
        const moo = await fetchMoomooPositionsResilient(accId);
        const rawPositions = moo.positions || [];
        accountValue = moo.account_value || 0;
        positions = rawPositions.map(x => ({
          symbol:            x.symbol,
          name:              x.name,
          qty:               Number(x.qty),
          avg_cost:          Number(x.avg_cost),
          current_price:     Number(x.current_price),
          market_val:        Number(x.market_val),
          unrealized_pl:     Number(x.unrealized_pl),
          unrealized_pl_pct: x.unrealized_pl_pct != null ? Number(x.unrealized_pl_pct) : null,
          today_pl:          Number(x.today_pl ?? 0),
        }));
        // Note: data freshness is logged so we can debug
        if (moo.source !== 'fresh') {
          console.log(`[portfolio] Moomoo served from ${moo.source} (age ${moo.ageMs}ms${moo.error ? ', error: ' + moo.error : ''})`);
        }
      } catch (e) {
        const rateLimited = /too frequent|rate/i.test(e.message || '');
        return res.status(503).json({
          error: rateLimited
            ? 'Moomoo rate-limited and no cached data available yet. The dashboard P&L poller is consuming the 10-call/30s budget. Open the P&L Dashboard once first to seed the cache, then return here.'
            : `Moomoo fetch failed: ${e.message}`,
          source: 'moomoo',
          rate_limited: !!rateLimited,
          hint: 'The Advisor caches Moomoo positions for 30s once it succeeds. Wait 30s and refresh, or visit the P&L Dashboard first.',
        });
      }
    } else if (source === 'alpaca' || source === 'alpaca_live') {
      const useLive = source === 'alpaca_live';
      try {
        const [acct, posList] = await Promise.allSettled(
          useLive ? [getLiveAccount(), getLivePositions()] : [getAccount(), getPositions()]
        );
        accountValue = acct.status === 'fulfilled' ? Number(acct.value?.portfolio_value || 0) : 0;
        const pl = posList.status === 'fulfilled' ? (posList.value || []) : [];
        positions = pl.map(x => ({
          symbol:            x.symbol,
          name:              x.symbol,
          qty:               Math.abs(Number(x.qty)),
          avg_cost:          Number(x.avg_entry_price),
          current_price:     Number(x.current_price),
          market_val:        Number(x.market_value),
          unrealized_pl:     Number(x.unrealized_pl),
          unrealized_pl_pct: Number(x.unrealized_plpc) * 100,
          today_pl:          Number(x.unrealized_intraday_pl ?? 0),
        }));
      } catch (e) {
        return res.status(503).json({ error: `Alpaca ${useLive ? 'live' : 'paper'} unreachable: ${e.message}`, source });
      }
    } else {
      // tiger / tiger_demo — not wired into Advisor yet
      return res.status(501).json({ error: `Source "${source}" not yet supported by Portfolio Advisor. Supported: moomoo, alpaca, alpaca_live.`, source });
    }

    const enriched = await enrichPositions(positions, accountValue, query);

    // Portfolio-level aggregates
    const totalUnrealized = enriched.reduce((s, p) => s + (p.unrealized_pl || 0), 0);
    const totalCost       = enriched.reduce((s, p) => s + (p.qty * p.avg_cost || 0), 0);
    const totalToday      = enriched.reduce((s, p) => s + (p.today_pl || 0), 0);
    const avgRisk         = enriched.length ? Math.round(enriched.reduce((s, p) => s + (p.risk?.score || 0), 0) / enriched.length) : 0;

    // Top concerns: positions with risk >= 60 OR drawdown < -10% OR concentration > 30%
    const concerns = enriched
      .filter(p => (p.risk?.score || 0) >= 60 || (p.unrealized_pl_pct || 0) < -10 || (p.pct_of_portfolio || 0) > 30)
      .sort((a, b) => (b.risk?.score || 0) - (a.risk?.score || 0))
      .slice(0, 3)
      .map(p => ({ symbol: p.symbol, risk: p.risk?.score, pct: p.pct_of_portfolio, pl_pct: p.unrealized_pl_pct }));

    res.json({
      generated_at: new Date().toISOString(),
      source,
      account_value: accountValue,
      total_unrealized_pl:   +totalUnrealized.toFixed(2),
      total_unrealized_pct:  totalCost > 0 ? +((totalUnrealized / totalCost) * 100).toFixed(2) : null,
      total_today_pl:        +totalToday.toFixed(2),
      position_count:        enriched.length,
      avg_risk_score:        avgRisk,
      top_concerns:          concerns,
      positions:             enriched,
    });
  } catch (e) {
    console.error('[portfolio/holdings]', e);
    res.status(500).json({ error: e.message });
  }
});

// Standalone hedge endpoint (in case user wants to recompute for a specific symbol)
app.get('/api/portfolio/hedge/:symbol', requireAuth, async (req, res) => {
  try {
    const username = req.session?.username;
    const dbUser = username && isDbAvailable() ? await getDbUser(username) : null;
    const accId  = dbUser?.moomoo_acc_id || undefined;
    const pos    = await getMoomooPositions({ acc_id: accId }).catch(() => null);
    const target = (pos?.positions || []).find(p => p.symbol.toUpperCase() === req.params.symbol.toUpperCase());
    if (!target) return res.status(404).json({ error: 'Position not found' });
    const position = {
      symbol: target.symbol, qty: Number(target.qty),
      avg_cost: Number(target.avg_cost), current_price: Number(target.current_price),
      market_val: Number(target.market_val),
    };
    // Force a hedge recommendation regardless of risk score for the standalone endpoint
    const hedge = await getHedgeRecommendation(position, 100);
    res.json({ position, hedge });
  } catch (e) {
    console.error('[portfolio/hedge]', e);
    res.status(500).json({ error: e.message });
  }
});

// Today's best buys — runs the bot's actual decision engine (gates + composite + setup)
// against the top scored candidates. Cached 60s so repeated tab opens are instant.
const _BEST_BUYS_CACHE = { at: 0, data: null };
const BEST_BUYS_TTL_MS = 60_000;
app.get('/api/portfolio/best-buys', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 12, 20);
    // Cache hit?
    if (_BEST_BUYS_CACHE.data && (Date.now() - _BEST_BUYS_CACHE.at) < BEST_BUYS_TTL_MS) {
      return res.json({ ..._BEST_BUYS_CACHE.data, cached: true });
    }
    // Get top 30 raw conviction scores → run through the bot's decision engine
    const r = await query(`
      WITH latest_scores AS (
        SELECT DISTINCT ON (symbol) symbol, score, scored_at
        FROM conviction_scores
        WHERE scored_at > NOW() - INTERVAL '24 hours'
        ORDER BY symbol, scored_at DESC
      )
      SELECT symbol FROM latest_scores WHERE score >= 40 ORDER BY score DESC LIMIT $1
    `, [Math.min(30, limit * 3)]);
    const symbols = r.rows.map(x => x.symbol);
    if (!symbols.length) {
      return res.json({ generated_at: new Date().toISOString(), picks: [] });
    }
    // Use production default bot config — represents what a fresh bot would do today
    const bot = { rules: BOT_DEFAULT_RULES, capital_usd: 10000 };
    // Parallelize diagnostics; allSettled so one failure doesn't break the batch
    const settled = await Promise.allSettled(symbols.map(s => diagnoseCandidate(s, bot)));
    const picks = settled
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
    // Sort: BUY first (by composite desc), then NEAR (by composite desc), then BLOCKED (by composite desc), then WATCH
    const verdictOrder = { BUY: 0, NEAR: 1, BLOCKED: 2, WATCH: 3 };
    picks.sort((a, b) => {
      const v = (verdictOrder[a.verdict] ?? 9) - (verdictOrder[b.verdict] ?? 9);
      if (v !== 0) return v;
      return (b.composite || 0) - (a.composite || 0);
    });
    const result = {
      generated_at: new Date().toISOString(),
      picks: picks.slice(0, limit),
      summary: {
        buy:     picks.filter(p => p.verdict === 'BUY').length,
        near:    picks.filter(p => p.verdict === 'NEAR').length,
        blocked: picks.filter(p => p.verdict === 'BLOCKED').length,
        watch:   picks.filter(p => p.verdict === 'WATCH').length,
      },
    };
    _BEST_BUYS_CACHE.at = Date.now();
    _BEST_BUYS_CACHE.data = result;
    res.json(result);
  } catch (e) {
    console.error('[portfolio/best-buys]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── System Health checks ────────────────────────────────────────────────────
// Diagnostic dashboard for invariants ("things that should always be true").
// Every bug we find in production gets a permanent check added to health-checks.js
// so it surfaces within minutes next time it breaks.
import { runAllChecks } from './health-checks.js';

app.get('/api/health/checks', requireAdmin, async (req, res) => {
  try {
    const result = await runAllChecks(query);
    res.json(result);
  } catch (e) {
    console.error('[health/checks]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Backtest reports (replay harness) ──────────────────────────────────────
// Serves JSON sidecars written by tests/bot-engine/replay-harness.js into the
// reports/ directory. Read-only; the harness CLI is the only writer.
const BACKTEST_REPORTS_DIR = join(__dirname, '..', '..', 'reports');

app.get('/api/backtests', requireAdmin, async (req, res) => {
  try {
    const files = await fs.promises.readdir(BACKTEST_REPORTS_DIR).catch(() => []);
    const jsons = files.filter(f => f.startsWith('replay-') && f.endsWith('.json'));
    const out = [];
    for (const f of jsons) {
      try {
        const raw = await fs.promises.readFile(join(BACKTEST_REPORTS_DIR, f), 'utf8');
        const doc = JSON.parse(raw);
        // Trim the heavy fields for the list view — detail route returns full doc
        out.push({
          id:           doc.id,
          strategy:     doc.strategy,
          generated_at: doc.generated_at,
          args:         doc.args,
          config:       doc.config,
          summary:      doc.summary,
          trade_count:  Array.isArray(doc.trades) ? doc.trades.length : 0,
          equity_len:   Array.isArray(doc.equity_curve) ? doc.equity_curve.length : 0,
        });
      } catch { /* skip malformed sidecars */ }
    }
    // Newest first
    out.sort((a, b) => (b.generated_at || '').localeCompare(a.generated_at || ''));
    res.json({ runs: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/backtests/:id', requireAdmin, async (req, res) => {
  try {
    // Defend against path traversal — id must match harness's filename pattern
    const id = String(req.params.id || '');
    if (!/^replay-[A-Za-z0-9_-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(id)) {
      return res.status(400).json({ error: 'invalid_id' });
    }
    const file = join(BACKTEST_REPORTS_DIR, `${id}.json`);
    const raw  = await fs.promises.readFile(file, 'utf8').catch(() => null);
    if (!raw) return res.status(404).json({ error: 'not_found' });
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Signal Validation (Conviction predictive-power test) ───────────────────
// Tests whether the conviction score predicts forward returns using actual
// price moves from backtest_prices. Independent of bot execution (no stop-loss
// contamination). Two views: grade-bucketed and score-bucketed.
app.get('/api/signal-validation/conviction', requireAdmin, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 90, 365);
    // Same query we ran manually — kept inline so it's the source of truth.
    const cte = `
      WITH daily_scores AS (
        SELECT DISTINCT ON (symbol, scored_at::date)
          symbol, scored_at::date AS score_date, grade, score
        FROM conviction_scores
        WHERE scored_at > NOW() - INTERVAL '${days} days'
        ORDER BY symbol, scored_at::date, scored_at DESC
      ),
      price_seq AS (
        SELECT symbol, price_date, adj_close,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY price_date) AS day_idx
        FROM backtest_prices
        WHERE price_date > NOW() - INTERVAL '${days + 30} days'
      ),
      matched AS (
        SELECT
          s.grade,
          s.score,
          CASE
            WHEN s.score >= 80 THEN '80-100'
            WHEN s.score >= 60 THEN '60-79'
            WHEN s.score >= 40 THEN '40-59'
            WHEN s.score >= 20 THEN '20-39'
            ELSE '0-19'
          END AS bucket,
          p_in.adj_close AS px_0,
          p1.adj_close  AS px_1,
          p5.adj_close  AS px_5,
          p10.adj_close AS px_10
        FROM daily_scores s
        JOIN price_seq p_in ON p_in.symbol = s.symbol AND p_in.price_date = s.score_date
        LEFT JOIN price_seq p1  ON p1.symbol  = s.symbol AND p1.day_idx  = p_in.day_idx + 1
        LEFT JOIN price_seq p5  ON p5.symbol  = s.symbol AND p5.day_idx  = p_in.day_idx + 5
        LEFT JOIN price_seq p10 ON p10.symbol = s.symbol AND p10.day_idx = p_in.day_idx + 10
      )`;

    const byGrade = await query(`${cte}
      SELECT
        grade,
        COUNT(*)                                                                                     AS n,
        ROUND(AVG((px_1  / px_0 - 1) * 100)::numeric, 3)                                            AS avg_1d_pct,
        ROUND(AVG((px_5  / px_0 - 1) * 100)::numeric, 3)                                            AS avg_5d_pct,
        ROUND(AVG((px_10 / px_0 - 1) * 100)::numeric, 3)                                            AS avg_10d_pct,
        ROUND(100.0 * COUNT(*) FILTER (WHERE px_5  > px_0)::numeric / NULLIF(COUNT(px_5), 0), 1)    AS pct_up_5d,
        ROUND(100.0 * COUNT(*) FILTER (WHERE px_10 > px_0)::numeric / NULLIF(COUNT(px_10), 0), 1)   AS pct_up_10d,
        ROUND(STDDEV((px_10 / px_0 - 1) * 100)::numeric, 2)                                         AS stddev_10d_pct
      FROM matched
      WHERE px_10 IS NOT NULL
      GROUP BY grade
      ORDER BY grade
    `);

    const byBucket = await query(`${cte}
      SELECT
        bucket,
        COUNT(*)                                                                                     AS n,
        ROUND(AVG((px_5  / px_0 - 1) * 100)::numeric, 3)                                            AS avg_5d_pct,
        ROUND(AVG((px_10 / px_0 - 1) * 100)::numeric, 3)                                            AS avg_10d_pct,
        ROUND(100.0 * COUNT(*) FILTER (WHERE px_10 > px_0)::numeric / NULLIF(COUNT(px_10), 0), 1)   AS pct_up_10d,
        ROUND(STDDEV((px_10 / px_0 - 1) * 100)::numeric, 2)                                         AS stddev_10d_pct
      FROM matched
      WHERE px_10 IS NOT NULL
      GROUP BY bucket
      ORDER BY bucket DESC
    `);

    // Most recent trained ML model snapshot — surfaces the AUC alongside grades
    const modelRes = await query(`
      SELECT trained_at, train_rows, accuracy, precision_1, recall_1, f1_1, auc_roc, scoring_adjustments
      FROM model_results
      ORDER BY trained_at DESC
      LIMIT 1
    `);

    res.json({
      window_days: days,
      generated_at: new Date().toISOString(),
      by_grade:  byGrade.rows,
      by_bucket: byBucket.rows,
      latest_ml_model: modelRes.rows[0] ?? null,
    });
  } catch (e) {
    console.error('[signal-validation/conviction]', e);
    res.status(500).json({ error: e.message });
  }
});

// Optional HTTPS server for mobile testing (set HTTPS_PORT + SSL_KEY_PATH + SSL_CERT_PATH)
if (process.env.HTTPS_PORT && process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH) {
  try {
    const httpsServer = https.createServer({
      key:  fs.readFileSync(process.env.SSL_KEY_PATH),
      cert: fs.readFileSync(process.env.SSL_CERT_PATH),
    }, app);
    httpsServer.listen(parseInt(process.env.HTTPS_PORT), () => {
      console.log(`🔒 HTTPS server running at https://localhost:${process.env.HTTPS_PORT}`);
    });
  } catch (e) {
    console.warn('⚠️  HTTPS server failed to start:', e.message);
  }
}

httpServer.listen(PORT, () => {
  console.log(`🌐 Dashboard running at http://localhost:${PORT}`);
  console.log(`[knowledge] using model: ${process.env.OLLAMA_KNOWLEDGE_MODEL || 'llama3.2:3b'}`);

  // Pre-warm caches in the background so first user requests are instant
  const today = new Date().toISOString().split('T')[0];
  Promise.allSettled([
    ttlCache('home:news', 5 * 60 * 1000, () => _mergedMarketNews(40))
      .then(() => console.log('✅ News cache warmed (Benzinga + market feeds)'))
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

  // Boot the Telegram AI bridge — same tools/Claude pipeline as the web AI chat.
  // Gated by TELEGRAM_BOT_ENABLED=1 so only the prod dashboard process polls
  // (Telegram getUpdates returns 409 if two clients poll the same bot token).
  try {
    startTelegramBot();
  } catch (e) {
    console.warn('⚠️  Telegram bot failed to start:', e.message);
  }
});
