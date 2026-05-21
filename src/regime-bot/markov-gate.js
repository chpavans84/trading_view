/**
 * regime-bot/markov-gate.js
 *
 * The Markov gate. Spawns the vendored Python script via uv, parses JSON,
 * caches per (ticker, as_of_date) to regime_cache, and applies the
 * Bull-only gate policy.
 *
 * Fail-closed: on any subprocess error, timeout, parse failure, or yfinance
 * unavailability, the gate returns BLOCK with current_regime='unknown'.
 * Never fail-open — better to skip a session than enter blind.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import pg from 'pg';
import { MARKOV, GATE, ALERTING } from './config.js';
import { writePricesCsv } from './price-loader.js';

const { Pool } = pg;
let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

// ─── Subprocess wrapper ─────────────────────────────────────────────────────
/**
 * Spawns `uv run markov_regime.py --csv <path> --json`, captures stdout/stderr.
 * @param {string} csvPath
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:true, json:object} | {ok:false, error:string}>}
 */
async function runMarkov(csvPath, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? MARKOV.timeout_ms;
  const args = [
    ...MARKOV.uv_args,                      // ['run']
    MARKOV.script_path,
    '--csv', csvPath,
    '--json',
    '--window', String(MARKOV.window_days),
    '--threshold', String(MARKOV.threshold),
    '--min-train', String(MARKOV.min_train_days),
  ];

  return new Promise((resolve) => {
    const child = spawn('uv', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      resolve(value);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('error', err => {
      clearTimeout(timer);
      settle({ ok: false, error: `spawn_error: ${err.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = (stderr || '(no stderr)').split('\n').slice(-3).join(' | ').slice(0, 400);
        return settle({ ok: false, error: `exit_${code}: ${tail}` });
      }
      try {
        const json = JSON.parse(stdout);
        settle({ ok: true, json });
      } catch (e) {
        settle({ ok: false, error: `json_parse: ${e.message}; stdout head: ${stdout.slice(0, 200)}` });
      }
    });
  });
}

// ─── Alert log for consecutive failures ─────────────────────────────────────
const _failureStreak = new Map();   // ticker → count

async function recordFailure(ticker, error) {
  const next = (_failureStreak.get(ticker) ?? 0) + 1;
  _failureStreak.set(ticker, next);
  if (next >= ALERTING.consecutive_failure_threshold) {
    console.error(`[ALERT] regime-bot: ${ticker} failed ${next} consecutive times — ${error}`);
    try {
      const dir = ALERTING.alert_log_path.substring(0, ALERTING.alert_log_path.lastIndexOf('/'));
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(
        ALERTING.alert_log_path,
        JSON.stringify({ ts: new Date().toISOString(), ticker, error, streak: next }) + '\n'
      );
    } catch {
      // best-effort — don't let alert-log errors break the gate
    }
  }
}

function clearFailureStreak(ticker) {
  _failureStreak.delete(ticker);
}

// ─── Cache read/write ───────────────────────────────────────────────────────
function todayDateString() {
  // Use America/New_York calendar date — keys regime_cache by market day, not UTC.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(now);     // YYYY-MM-DD
}

async function readCache(ticker, asOfDate) {
  const { rows } = await getPool().query(
    `SELECT * FROM regime_cache WHERE ticker = $1 AND as_of_date = $2`,
    [ticker.toUpperCase(), asOfDate]
  );
  return rows[0] ?? null;
}

async function writeCache(ticker, asOfDate, jsonResult) {
  const next = jsonResult.next_state_probabilities ?? {};
  const wf   = jsonResult.walk_forward ?? {};
  const persistenceVals = Object.values(jsonResult.persistence_diagonal ?? {})
    .map(Number)
    .filter(Number.isFinite);
  const persistenceDiag = persistenceVals.length
    ? persistenceVals.reduce((s, v) => s + v, 0) / persistenceVals.length
    : null;

  await getPool().query(
    `INSERT INTO regime_cache (
       ticker, as_of_date, current_regime,
       bull_prob, bear_prob, sideways_prob,
       signal, persistence_diag,
       wf_sharpe, wf_max_drawdown,
       raw_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (ticker, as_of_date) DO UPDATE SET
       current_regime   = EXCLUDED.current_regime,
       bull_prob        = EXCLUDED.bull_prob,
       bear_prob        = EXCLUDED.bear_prob,
       sideways_prob    = EXCLUDED.sideways_prob,
       signal           = EXCLUDED.signal,
       persistence_diag = EXCLUDED.persistence_diag,
       wf_sharpe        = EXCLUDED.wf_sharpe,
       wf_max_drawdown  = EXCLUDED.wf_max_drawdown,
       raw_json         = EXCLUDED.raw_json,
       computed_at      = NOW()`,
    [
      ticker.toUpperCase(),
      asOfDate,
      jsonResult.current_regime ?? null,
      next.bull     ?? null,
      next.bear     ?? null,
      next.sideways ?? null,
      jsonResult.signal ?? null,
      persistenceDiag,
      wf.sharpe        ?? null,
      wf.max_drawdown  ?? null,
      jsonResult,
    ]
  );
}

async function writeCacheFailure(ticker, asOfDate, error) {
  // Write an "unknown" row so we don't retry forever within the same day.
  // The bot's fail-closed gate sees current_regime='unknown' and blocks.
  await getPool().query(
    `INSERT INTO regime_cache (
       ticker, as_of_date, current_regime, raw_json
     ) VALUES ($1, $2, 'unknown', $3)
     ON CONFLICT (ticker, as_of_date) DO UPDATE SET
       current_regime = 'unknown',
       raw_json       = EXCLUDED.raw_json,
       computed_at    = NOW()`,
    [ticker.toUpperCase(), asOfDate, JSON.stringify({ error })]
  );
}

// ─── Public API ─────────────────────────────────────────────────────────────
/**
 * Returns the regime for `ticker` for today's market date. Caches per day.
 * Side-effect: also writes to regime_cache.
 *
 * Return shape mirrors what the engine + decision-log need:
 *   {
 *     current_regime, bull_prob, bear_prob, sideways_prob,
 *     markov_signal, persistence_diag,
 *     gate_passed, blocked_reason,
 *     cached: boolean
 *   }
 */
export async function getRegime(ticker, { forceRefresh = false } = {}) {
  const asOfDate = todayDateString();
  const tu       = ticker.toUpperCase();

  // 1. Cache hit?
  if (!forceRefresh) {
    const cached = await readCache(tu, asOfDate);
    if (cached) {
      return shapeFromCache(cached, /*cached=*/ true);
    }
  }

  // 2. Cache miss — build CSV
  let csvPath;
  try {
    const r = await writePricesCsv(tu);
    csvPath = r.csvPath;
  } catch (e) {
    await writeCacheFailure(tu, asOfDate, `price_load: ${e.message}`);
    await recordFailure(tu, `price_load: ${e.message}`);
    return shapeBlocked(tu, `price_load: ${e.message}`);
  }

  // 3. Run subprocess
  let result;
  for (let attempt = 0; attempt <= MARKOV.max_retries; attempt++) {
    result = await runMarkov(csvPath);
    if (result.ok) break;
    if (attempt < MARKOV.max_retries) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  if (!result.ok) {
    await writeCacheFailure(tu, asOfDate, result.error);
    await recordFailure(tu, result.error);
    return shapeBlocked(tu, result.error);
  }

  // 4. Cache + return
  await writeCache(tu, asOfDate, result.json);
  clearFailureStreak(tu);
  const cached = await readCache(tu, asOfDate);
  return shapeFromCache(cached, /*cached=*/ false);
}

// ─── Shapers ────────────────────────────────────────────────────────────────
function shapeFromCache(row, cached) {
  const regime = row.current_regime;
  const gatePassed =
    regime != null &&
    regime !== 'unknown' &&
    GATE.allowed_regimes.includes(regime);

  return {
    current_regime:   regime,
    bull_prob:        row.bull_prob        != null ? Number(row.bull_prob)        : null,
    bear_prob:        row.bear_prob        != null ? Number(row.bear_prob)        : null,
    sideways_prob:    row.sideways_prob    != null ? Number(row.sideways_prob)    : null,
    markov_signal:    row.signal           != null ? Number(row.signal)           : null,
    persistence_diag: row.persistence_diag != null ? Number(row.persistence_diag) : null,
    gate_passed:      gatePassed,
    blocked_reason:   gatePassed ? null
      : regime === 'unknown' ? 'regime_unknown'
      : `regime_${(regime ?? 'null').toLowerCase()}`,
    cached,
  };
}

function shapeBlocked(ticker, error) {
  return {
    current_regime:   'unknown',
    bull_prob:        null,
    bear_prob:        null,
    sideways_prob:    null,
    markov_signal:    null,
    persistence_diag: null,
    gate_passed:      false,
    blocked_reason:   `regime_unavailable: ${error}`,
    cached:           false,
  };
}

export async function closePool() {
  if (_pool) { await _pool.end(); _pool = null; }
}

// ─── Self-test ──────────────────────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const ticker = process.argv[2] || 'SPY';
    const force  = process.argv.includes('--force');
    console.log(`Testing gate for ${ticker}${force ? ' (force-refresh)' : ''}...`);
    const result = await getRegime(ticker, { forceRefresh: force });
    console.log(JSON.stringify(result, null, 2));
    await closePool();
  })();
}
