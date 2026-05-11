/**
 * Tier-1 Self-Healing Error Monitor
 *
 * Runs as a separate PM2 process. Every 60 seconds it:
 *  1. Reads PM2 log files for ERROR patterns
 *  2. Checks process memory — restarts if > 600 MB
 *  3. Checks process uptime — alerts if a process is stopped
 *  4. Stores findings in PostgreSQL agent_error_log
 *  5. Applies auto-fixes (PM2 restart) for known safe patterns
 *
 * No LLM calls. No core logic touched. Zero blast radius.
 */

import { execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: join(__dirname, '../../.env') });

// ─── DB ───────────────────────────────────────────────────────────────────────

const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 3,
    })
  : null;

async function dbLog({ source, level, message, stack, context, auto_action }) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO agent_error_log (source, level, message, stack, context, auto_action)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [source, level, message?.slice(0, 2000), stack?.slice(0, 5000),
       context ? JSON.stringify(context) : null, auto_action?.slice(0, 100)]
    );
  } catch { /* DB might not be up yet */ }
}

// ─── PM2 helpers ─────────────────────────────────────────────────────────────

const WATCHED_PROCESSES = ['trading-dashboard', 'trading-staging', 'trading-bot'];
const MEM_LIMIT_MB = 600;

async function getPm2List() {
  try {
    const { stdout } = await execAsync('pm2 jlist');
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

async function restartProcess(name, reason) {
  console.log(`[error-monitor] Restarting ${name}: ${reason}`);
  try {
    await execAsync(`pm2 restart ${name}`);
    await dbLog({ source: 'monitor', level: 'warn', message: `Auto-restarted ${name}`, context: { reason }, auto_action: `pm2 restart ${name}` });
  } catch (e) {
    console.error(`[error-monitor] Restart failed for ${name}:`, e.message);
    await dbLog({ source: 'monitor', level: 'error', message: `Failed to restart ${name}: ${e.message}`, context: { reason } });
  }
}

// ─── Log scanning ─────────────────────────────────────────────────────────────

const LOG_PATHS = {
  'trading-dashboard': `${process.env.HOME}/.pm2/logs/trading-dashboard-error.log`,
  'trading-staging':   `${process.env.HOME}/.pm2/logs/trading-staging-error.log`,
  'trading-bot':       `${process.env.HOME}/.pm2/logs/trading-bot-error.log`,
};

// Track last-seen byte offset per file so we only scan new content.
// Initialise to current file length so we skip historical noise on startup.
const fileOffsets = {};
for (const [name, path] of Object.entries(LOG_PATHS)) {
  if (existsSync(path)) {
    try { fileOffsets[name] = readFileSync(path, 'utf8').length; } catch { fileOffsets[name] = 0; }
  } else {
    fileOffsets[name] = 0;
  }
}

// Known transient/noisy patterns — skip entirely (don't log to DB)
const TRANSIENT_PATTERNS = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /fetch failed/i,
  /AbortError/i,
  /yahoo-finance/i,
  /YahooFinanceError/i,
  /neo4j.*connection/i,
  // TradingView MCP startup disclaimers — not real errors
  /Unofficial tool\. Not affiliated/i,
  /Ensure your usage complies/i,
  /Terms of Use/i,
  // Yahoo Finance validation notices (very common, expected)
  /Failed validation/i,
  /did not validate with schema/i,
  /schema\.org/i,
  /Missing required properties/i,
  /ripHistorical/i,
  /yahooSurvey/i,
  /Please see if anyone has reported/i,
  /This may happen intermittently/i,
  /open a new issue/i,
  /Help Fix Validation Error/i,
  /gadicc\/yahoo/i,
  /at the end of the doc/i,
  /In case you.d like to contribute/i,
  // Generic PM2 / node startup noise
  /ExperimentalWarning/i,
  /DeprecationWarning/i,
];

// Patterns that warrant an auto-restart (OOM, unhandled rejection loops)
const RESTART_PATTERNS = [
  /out of memory/i,
  /heap out of memory/i,
  /ENOMEM/i,
];

function scanLog(name, path) {
  if (!existsSync(path)) return;
  try {
    const full = readFileSync(path, 'utf8');
    const offset = fileOffsets[name] || 0;
    const newContent = full.slice(offset);
    fileOffsets[name] = full.length;

    if (!newContent.trim()) return;

    const lines = newContent.split('\n').filter(l => l.trim());
    for (const line of lines) {
      if (RESTART_PATTERNS.some(p => p.test(line))) {
        console.log(`[error-monitor] OOM/critical pattern in ${name} log`);
        dbLog({ source: 'monitor', level: 'error', message: `OOM pattern in ${name}: ${line.slice(0, 300)}`, context: { process: name }, auto_action: `pm2 restart ${name}` });
        restartProcess(name, `OOM pattern: ${line.slice(0, 100)}`);
        return;
      }
      if (!TRANSIENT_PATTERNS.some(p => p.test(line))) {
        // Unknown error — log it for visibility, no auto-action
        dbLog({ source: 'monitor', level: 'error', message: line.slice(0, 500), context: { process: name } });
      }
    }
  } catch (e) {
    console.error(`[error-monitor] Error reading log ${path}:`, e.message);
  }
}

// ─── Main check loop ──────────────────────────────────────────────────────────

async function runCheck() {
  const procs = await getPm2List();

  for (const name of WATCHED_PROCESSES) {
    const proc = procs.find(p => p.name === name);
    if (!proc) continue;

    const status = proc.pm2_env?.status;
    const memMB  = (proc.monit?.memory || 0) / 1_048_576;
    const pid    = proc.pid;

    // Stopped/errored process
    if (status === 'stopped' || status === 'errored') {
      console.log(`[error-monitor] ${name} is ${status} — restarting`);
      await restartProcess(name, `Process status: ${status}`);
      continue;
    }

    // Memory over limit
    if (memMB > MEM_LIMIT_MB) {
      console.log(`[error-monitor] ${name} using ${memMB.toFixed(0)} MB — restarting`);
      await restartProcess(name, `Memory ${memMB.toFixed(0)} MB > ${MEM_LIMIT_MB} MB limit`);
      continue;
    }

    console.log(`[error-monitor] ${name} OK | status=${status} mem=${memMB.toFixed(0)}MB pid=${pid}`);
  }

  // Scan error logs for new content
  for (const [name, path] of Object.entries(LOG_PATHS)) {
    scanLog(name, path);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

const INTERVAL_MS = 60_000;

console.log('[error-monitor] Starting — checking every 60s');
console.log(`[error-monitor] Watching: ${WATCHED_PROCESSES.join(', ')}`);
console.log(`[error-monitor] Memory limit: ${MEM_LIMIT_MB} MB`);
console.log(`[error-monitor] DB: ${pool ? 'connected' : 'disabled (no DATABASE_URL)'}`);

// Initial check immediately
runCheck().catch(e => console.error('[error-monitor] Initial check failed:', e.message));

// Then every 60s
setInterval(() => {
  runCheck().catch(e => console.error('[error-monitor] Check failed:', e.message));
}, INTERVAL_MS);
