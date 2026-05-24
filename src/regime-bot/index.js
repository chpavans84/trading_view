/**
 * regime-bot/index.js
 *
 * Cron entry point + lifecycle. Runs as its own PM2 process —
 * `trading-regime-bot` — and registers two crons:
 *
 *   regime_refresh  — 4:05 PM ET weekdays
 *                     pre-computes today's regime for all 116 tickers and
 *                     populates regime_cache. Done after close so prices have
 *                     settled. Makes the next-day decision tick fast.
 *
 *   decision        — 9:31 AM ET weekdays
 *                     primary signal + cached regime → decision log + trade execution.
 *                     Execution requires REGIME_BOT_LIVE=1 in .env (default: log-only).
 *
 * Manual triggers:
 *   - Default invocation runs both jobs once at startup, then schedules:
 *       node --env-file=.env src/regime-bot/index.js
 *   - --once-decision : run a single decision tick, then exit (no cron)
 *   - --once-refresh  : run a single regime refresh, then exit (no cron)
 *   - --help          : usage
 *
 * Graceful shutdown: SIGINT / SIGTERM trigger pool close + cron stop.
 */

import cron from 'node-cron';
import { CRON, TICKER_BASKET, MARKOV } from './config.js';
import { runScanTick, closeAllPools } from './engine.js';
import { getRegime, closePool as closeGatePool } from './markov-gate.js';

// ─── Regime refresh job ─────────────────────────────────────────────────────
// Walks the full basket, calls getRegime() for each ticker. Cache hits return
// immediately; misses spawn the subprocess. Designed to run after-hours so
// the daily decision tick has fully-warmed cache.
async function regimeRefreshJob({ parallelism = 5 } = {}) {
  const t0 = Date.now();
  console.log(`[regime-bot] refresh start — ${TICKER_BASKET.length} tickers, parallelism=${parallelism}`);

  let ok = 0, blocked = 0, errors = 0;
  for (let i = 0; i < TICKER_BASKET.length; i += parallelism) {
    const batch = TICKER_BASKET.slice(i, i + parallelism);
    const results = await Promise.all(batch.map(async sym => {
      try {
        const r = await getRegime(sym);
        return { sym, ok: true, gate: r.gate_passed, regime: r.current_regime, cached: r.cached };
      } catch (e) {
        return { sym, ok: false, error: e.message };
      }
    }));
    for (const r of results) {
      if (!r.ok) { errors++; console.warn(`  ✗ ${r.sym} ${r.error}`); }
      else if (r.gate) ok++;
      else blocked++;
    }
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  const duration = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[regime-bot] refresh done in ${duration}s — ${ok} Bull, ${blocked} non-Bull, ${errors} errors`);
}

// ─── Decision job ───────────────────────────────────────────────────────────
async function decisionJob() {
  try {
    await runScanTick({ parallelism: 5 });
  } catch (e) {
    console.error('[regime-bot] decision tick fatal:', e);
  }
}

// ─── Cron registration ──────────────────────────────────────────────────────
let _refreshTask = null;
let _decisionTask = null;

function startCrons() {
  console.log(`[regime-bot] registering crons (timezone: ${CRON.timezone})`);
  console.log(`  regime_refresh : ${CRON.regime_refresh}  (4:05 PM ET weekdays)`);
  console.log(`  decision       : ${CRON.decision}  (9:31 AM ET weekdays)`);

  _refreshTask = cron.schedule(CRON.regime_refresh, () => {
    regimeRefreshJob().catch(e => console.error('[regime-bot] refresh error:', e));
  }, { timezone: CRON.timezone });

  _decisionTask = cron.schedule(CRON.decision, () => {
    decisionJob().catch(e => console.error('[regime-bot] decision error:', e));
  }, { timezone: CRON.timezone });
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[regime-bot] received ${signal} — shutting down`);
  if (_refreshTask)  _refreshTask.stop();
  if (_decisionTask) _decisionTask.stop();
  try {
    await closeAllPools();
  } catch (e) {
    console.warn('[regime-bot] pool close error:', e.message);
  }
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Boot ───────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
regime-bot — Markov-gated SMA crossover paper bot

Usage:
  node --env-file=.env src/regime-bot/index.js [flag]

Flags:
  (none)            Start daemon: run refresh once, then schedule crons forever
  --once-decision   Run a single decision tick, log results, exit
  --once-refresh    Run a single regime refresh, exit
  --help            Show this message

Crons (when running as daemon):
  regime_refresh    ${CRON.regime_refresh}  (4:05 PM ET weekdays)
  decision          ${CRON.decision}  (9:31 AM ET weekdays)

Tables:
  regime_cache              — daily Markov output per ticker
  regime_bot_decisions      — every scan-tick decision
  regime_bot_trades         — paper orders (not yet wired in this phase)
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  if (argv.includes('--once-decision')) {
    console.log('[regime-bot] one-shot decision tick');
    await decisionJob();
    await closeAllPools();
    process.exit(0);
  }

  if (argv.includes('--once-refresh')) {
    console.log('[regime-bot] one-shot regime refresh');
    await regimeRefreshJob();
    await closeGatePool();
    process.exit(0);
  }

  // Daemon mode
  console.log('[regime-bot] starting daemon');
  console.log(`[regime-bot] basket: ${TICKER_BASKET.length} tickers`);
  console.log(`[regime-bot] markov script: ${MARKOV.script_path}`);
  console.log();

  // Warm cache once at boot so the first decision tick is fast
  await regimeRefreshJob();

  // Register crons — process stays alive
  startCrons();

  console.log('\n[regime-bot] daemon up — Ctrl+C to stop');
}

main().catch(e => {
  console.error('[regime-bot] startup fatal:', e);
  process.exit(1);
});
