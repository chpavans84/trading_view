/**
 * src/web/health-checks.js
 *
 * System Health invariants — encoded as runnable checks.
 *
 * Each check returns:
 *   {
 *     id:        unique slug
 *     category:  'data' | 'cron' | 'integrity' | 'ml' | 'process'
 *     title:     human-friendly name
 *     status:    'ok' | 'warn' | 'fail'
 *     value:     measured value (string)
 *     threshold: human-friendly threshold
 *     doc: {
 *       what:    one-paragraph: what this check measures
 *       why:     one-paragraph: why it matters
 *       if_red:  one-paragraph: what to do when this is FAIL/WARN
 *     }
 *   }
 *
 * Discipline note (2026-05-23): every bug we find in production gets a new
 * permanent check added here. The goal is "bugs surface in minutes, not weeks."
 */

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

// ─── Helpers ────────────────────────────────────────────────────────────────
const fmt = {
  age(d) {
    if (!d) return 'never';
    const ms = Date.now() - new Date(d).getTime();
    if (ms < 0) return 'in the future?';
    const s = ms / 1000;
    if (s < 60)        return `${s.toFixed(0)}s ago`;
    if (s < 3600)      return `${(s/60).toFixed(0)}m ago`;
    if (s < 86400)     return `${(s/3600).toFixed(1)}h ago`;
    return `${(s/86400).toFixed(1)}d ago`;
  },
  number(n)   { return n == null ? '—' : Number(n).toLocaleString(); },
};

function isMarketHours() {
  // Crude but correct enough: Mon-Fri, 9:30 AM - 4:00 PM America/New_York
  const nyFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = nyFmt.formatToParts(new Date());
  const wd  = parts.find(p => p.type === 'weekday').value;
  const h   = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const m   = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(wd);
  const afterOpen = h > 9 || (h === 9 && m >= 30);
  const beforeClose = h < 16;
  return { isMarketHours: isWeekday && afterOpen && beforeClose, weekday: wd, hour: h, minute: m };
}

function ok(  id, category, title, value, threshold, doc) { return { id, category, title, status: 'ok',   value, threshold, doc }; }
function warn(id, category, title, value, threshold, doc) { return { id, category, title, status: 'warn', value, threshold, doc }; }
function fail(id, category, title, value, threshold, doc) { return { id, category, title, status: 'fail', value, threshold, doc }; }

// ─── Individual checks ──────────────────────────────────────────────────────

async function checkTradableUniverse(query) {
  const r = await query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE market_cap_usd >= 5e9 AND adv_dollar_30d >= 5e6
                       AND last_price BETWEEN 5 AND 500 AND fractionable=TRUE) AS pass_filters,
      MAX(last_synced_at) AS last_sync
    FROM tradable_universe
  `);
  const { total, pass_filters, last_sync } = r.rows[0];
  const filtered = Number(pass_filters);
  const doc = {
    what: 'Counts rows in the tradable_universe table that pass the bot’s baseline filters (market cap ≥ $5B, ADV ≥ $5M, price $5–500, fractionable).',
    why:  'This is the bot’s baseline candidate pool. If it’s empty or sparse, scans collapse to UW + news + movers only — which go quiet outside market hours and during news lulls.',
    if_red: 'Run `node --env-file=.env -e "..."` to invoke syncTradableUniverse({force:true}), or wait for the Monday 8 AM ET cron. Common cause: Yahoo Finance rate-limited enrichment (66% failures observed 2026-05-23).',
  };
  const val = `${fmt.number(total)} total · ${fmt.number(filtered)} pass filters · synced ${fmt.age(last_sync)}`;
  const threshold = '≥ 100 passing filters';
  if (filtered < 50)   return fail('tu_count', 'data', 'Tradable universe size',        val, threshold, doc);
  if (filtered < 100)  return warn('tu_count', 'data', 'Tradable universe size',        val, threshold, doc);
  return                       ok(  'tu_count', 'data', 'Tradable universe size',        val, threshold, doc);
}

async function checkUwFlowAlerts(query) {
  const r = await query(`SELECT MAX(alerted_at) AS last_at, COUNT(*) AS total FROM uw_flow_alerts`);
  const { last_at, total } = r.rows[0];
  const ageMs = last_at ? Date.now() - new Date(last_at).getTime() : Infinity;
  const mh = isMarketHours();
  const limit = mh.isMarketHours ? 15 * 60_000 : 18 * 60 * 60_000;
  const doc = {
    what: 'Last timestamp written to uw_flow_alerts — Unusual Whales bullish options flow signals (≥ $100k premium).',
    why:  'UW flow is the highest-priority candidate source (+10 weight) and a key gate signal at 20% of composite. Stale data = bot is flying blind to institutional money flow.',
    if_red: 'Check `pm2 logs trading-dashboard | grep uw` for ingestion errors. UW WebSocket may have disconnected — usually auto-reconnects with exponential backoff. If persistent, validate UW_API_KEY in .env.',
  };
  const val = `last ${fmt.age(last_at)} · ${fmt.number(total)} lifetime alerts`;
  const threshold = mh.isMarketHours ? 'within 15 min during market hours' : 'within 18 h off-hours';
  if (ageMs > limit * 2)  return fail('uw_flow', 'data', 'UW flow alerts freshness',  val, threshold, doc);
  if (ageMs > limit)      return warn('uw_flow', 'data', 'UW flow alerts freshness',  val, threshold, doc);
  return                         ok(  'uw_flow', 'data', 'UW flow alerts freshness',  val, threshold, doc);
}

async function checkBenzingaNews(query) {
  const r = await query(`SELECT MAX(published_at) AS last_at, COUNT(*) AS total FROM benzinga_news`);
  const { last_at, total } = r.rows[0];
  const ageMs = last_at ? Date.now() - new Date(last_at).getTime() : Infinity;
  const mh = isMarketHours();
  const limit = mh.isMarketHours ? 30 * 60_000 : 12 * 60 * 60_000;
  const doc = {
    what: 'Last published_at timestamp in benzinga_news. Indicates whether news ingestion is feeding the bot fresh articles.',
    why:  'News is one of the 4 candidate sources (+8 priority) and a 20% gate weight. Stale news means the bot can’t react to fresh positive sentiment catalysts.',
    if_red: 'Check `pm2 logs trading-dashboard | grep benzinga` for ingestion errors. Validate BENZINGA_API_KEY. Default cron runs every 1–2 min during market hours.',
  };
  const val = `last ${fmt.age(last_at)} · ${fmt.number(total)} lifetime articles`;
  const threshold = mh.isMarketHours ? 'within 30 min during market hours' : 'within 12 h off-hours';
  if (ageMs > limit * 2)  return fail('bz_news', 'data', 'Benzinga news freshness', val, threshold, doc);
  if (ageMs > limit)      return warn('bz_news', 'data', 'Benzinga news freshness', val, threshold, doc);
  return                         ok(  'bz_news', 'data', 'Benzinga news freshness', val, threshold, doc);
}

async function checkUwTopMovers(query) {
  const r = await query(`SELECT MAX(captured_at) AS last_at FROM uw_top_movers`);
  const { last_at } = r.rows[0];
  const ageMs = last_at ? Date.now() - new Date(last_at).getTime() : Infinity;
  const mh = isMarketHours();
  const limit = mh.isMarketHours ? 15 * 60_000 : 20 * 60 * 60_000;
  const doc = {
    what: 'Last captured_at timestamp in uw_top_movers — the running list of biggest % movers in the last hour.',
    why:  'Used as a +5 priority candidate source. Provides price-action catalysts the bot can investigate further.',
    if_red: 'UW top movers cron runs every 5 min. Check `pm2 logs trading-dashboard | grep movers` for ingestion errors.',
  };
  const val = `last ${fmt.age(last_at)}`;
  const threshold = mh.isMarketHours ? 'within 15 min during market hours' : 'within 20 h off-hours';
  if (ageMs > limit * 2)  return fail('uw_movers', 'data', 'UW top movers freshness', val, threshold, doc);
  if (ageMs > limit)      return warn('uw_movers', 'data', 'UW top movers freshness', val, threshold, doc);
  return                         ok(  'uw_movers', 'data', 'UW top movers freshness', val, threshold, doc);
}

async function checkBacktestPrices(query) {
  const r = await query(`SELECT MAX(price_date)::date AS last_date, COUNT(DISTINCT symbol) AS symbols FROM backtest_prices`);
  const { last_date, symbols } = r.rows[0];
  const ageMs = last_date ? Date.now() - new Date(last_date).getTime() : Infinity;
  const doc = {
    what: 'Latest price_date in backtest_prices (the Yahoo daily OHLC table used for the backtest harness, conviction scoring, and the Signal Validation panel).',
    why:  'Used by SMA/RSI/MA50/52w-distance calculations and by the Signal Validation panel. Stale prices mean stale signals.',
    if_red: 'Run `npm run research:download` (Yahoo Finance daily download). Auto-cron runs nightly. Check for Yahoo API errors in pm2 logs.',
  };
  const val = `last ${last_date ?? 'n/a'} (${fmt.age(last_date)}) · ${fmt.number(symbols)} symbols`;
  const threshold = 'within 4 days (allows for weekends + holidays)';
  if (ageMs > 4 * 86_400_000)  return fail('bt_prices', 'data', 'Backtest prices freshness', val, threshold, doc);
  if (ageMs > 2 * 86_400_000)  return warn('bt_prices', 'data', 'Backtest prices freshness', val, threshold, doc);
  return                              ok(  'bt_prices', 'data', 'Backtest prices freshness', val, threshold, doc);
}

async function checkConvictionScoresToday(query) {
  const mh = isMarketHours();
  const r = await query(`SELECT COUNT(*) AS n, MAX(scored_at) AS last_at FROM conviction_scores WHERE scored_at::date = CURRENT_DATE`);
  const { n, last_at } = r.rows[0];
  const doc = {
    what: 'Count of conviction scores written today, and the most-recent timestamp.',
    why:  'If the scanner is firing as expected, scores accumulate continuously during market hours. Zero scores today during market hours = scanner is broken.',
    if_red: 'Check the bot engine cron is running (Health → "Bot scanner heartbeat"). Look at trading-dashboard pm2 logs for scoring errors.',
  };
  const val = `${fmt.number(n)} scores today · last ${fmt.age(last_at)}`;
  // Only assert during market hours; off-hours treat low counts as OK
  if (!mh.isMarketHours) {
    return ok('conv_today', 'data', 'Conviction scores today', val, 'no check off-hours', doc);
  }
  const threshold = '≥ 100 during market hours';
  if (Number(n) === 0)   return fail('conv_today', 'data', 'Conviction scores today', val, threshold, doc);
  if (Number(n) < 100)   return warn('conv_today', 'data', 'Conviction scores today', val, threshold, doc);
  return                        ok(  'conv_today', 'data', 'Conviction scores today', val, threshold, doc);
}

async function checkDanglingTradePointers(query) {
  const r = await query(`
    SELECT COUNT(*) AS n
    FROM bots b JOIN trades t ON t.id = b.current_trade_id
    WHERE t.status = 'closed'
  `);
  const { n } = r.rows[0];
  const doc = {
    what: 'Counts bots whose current_trade_id points to a trade row that is already status="closed". A pointer should be NULL once the trade closes.',
    why:  'Dangling pointers block the bot’s archive operation and confuse the executor (it thinks a trade is open when none is). Caused the BOT2 archive failure on 2026-05-23.',
    if_red: 'Run `UPDATE bots SET current_trade_id=NULL WHERE id IN (...)` for each affected bot. Root cause is the reconciler not nulling the pointer on trade close — see pending_tasks.md section B.2.',
  };
  const val = `${n} bots with dangling pointer`;
  const threshold = '0';
  if (Number(n) > 0)  return fail('dangling_ptr', 'integrity', 'Dangling current_trade_id pointers', val, threshold, doc);
  return                     ok(  'dangling_ptr', 'integrity', 'Dangling current_trade_id pointers', val, threshold, doc);
}

async function checkStalePredictions(query) {
  const r = await query(`
    SELECT COUNT(*) AS n
    FROM stock_predictions
    WHERE actual_price IS NULL AND target_date < CURRENT_DATE - INTERVAL '3 days'
  `);
  const { n } = r.rows[0];
  const doc = {
    what: 'Counts stock_predictions rows where the forecast target date has passed by ≥ 3 days but actual_price was never backfilled.',
    why:  'Calibration training uses (prediction, actual) pairs. Stale unfilled rows skew the model toward stale data and indicate the EOD fill cron has gaps.',
    if_red: 'Run the prediction-actuals backfill (POST /api/forecast/train-calibration). Check `fillTodayActuals` cron in pm2 logs.',
  };
  const val = `${fmt.number(n)} unfilled predictions older than 3 days`;
  const threshold = '< 50';
  if (Number(n) > 200)  return fail('stale_preds', 'integrity', 'Stale predictions waiting actuals', val, threshold, doc);
  if (Number(n) > 50)   return warn('stale_preds', 'integrity', 'Stale predictions waiting actuals', val, threshold, doc);
  return                       ok(  'stale_preds', 'integrity', 'Stale predictions waiting actuals', val, threshold, doc);
}

async function checkUniverseSyncRecency(query) {
  const r = await query(`SELECT MAX(last_synced_at) AS last_at FROM tradable_universe`);
  const { last_at } = r.rows[0];
  const ageMs = last_at ? Date.now() - new Date(last_at).getTime() : Infinity;
  const doc = {
    what: 'Most-recent last_synced_at across all tradable_universe rows. Indicates whether the daily 8 AM ET sync cron is running.',
    why:  'If sync stops, the bot’s baseline universe goes stale — market cap / ADV / price data drift away from reality. Filters silently exclude qualifying names or include disqualified ones.',
    if_red: 'Manual sync: invoke syncTradableUniverse({force:true}). The cron is wired at server startup — check pm2 logs at 8:00 AM ET Mon-Fri.',
  };
  const val = `last sync ${fmt.age(last_at)}`;
  const threshold = '< 36 h (allows for weekends)';
  if (ageMs > 4 * 86_400_000)  return fail('univ_sync', 'cron', 'Universe sync recency',  val, threshold, doc);
  if (ageMs > 36 * 60 * 60_000) return warn('univ_sync', 'cron', 'Universe sync recency', val, threshold, doc);
  return                              ok(  'univ_sync', 'cron', 'Universe sync recency', val, threshold, doc);
}

async function checkBotScanHeartbeat(query) {
  // Look for any bot_decisions write in last 10 min (market hours) or 24 h (off-hours)
  const r = await query(`SELECT MAX(scanned_at) AS last_at, COUNT(*) FILTER (WHERE scanned_at > NOW() - INTERVAL '1 hour') AS recent FROM bot_decisions`);
  const { last_at, recent } = r.rows[0];
  const ageMs = last_at ? Date.now() - new Date(last_at).getTime() : Infinity;
  const mh = isMarketHours();
  const limit = mh.isMarketHours ? 10 * 60_000 : 24 * 60 * 60_000;
  const doc = {
    what: 'Most-recent decided_at in bot_decisions. The scanner writes one decision per active bot per scan cycle (every 5 min during market hours).',
    why:  'Detects "cron stopped mid-day" bug seen 2026-05-20 — scanner went silent at 14:10 UTC, no alerts. Empty bot_decisions during market hours = scanner is dead.',
    if_red: 'If no active bots exist, this will be silent — start a bot to verify. Otherwise check pm2 logs for trading-dashboard errors. Restart with `pm2 restart trading-dashboard`. Note: the runtime scanner-watchdog cron also checks every 10 min during market hours and emails you automatically when stale.',
  };
  const val = last_at ? `last decision ${fmt.age(last_at)} · ${recent} in last hour` : 'no decisions ever';
  const threshold = mh.isMarketHours ? 'within 10 min during market hours' : 'within 24 h off-hours';
  if (ageMs > limit * 2)  return fail('bot_scan', 'cron', 'Bot scanner heartbeat',   val, threshold, doc);
  if (ageMs > limit)      return warn('bot_scan', 'cron', 'Bot scanner heartbeat',   val, threshold, doc);
  return                         ok(  'bot_scan', 'cron', 'Bot scanner heartbeat',   val, threshold, doc);
}

async function checkExecutorHeartbeat(query) {
  // Look for any 'buy' or 'close' actions logged in last hour during market hours
  const r = await query(`
    SELECT MAX(scanned_at) AS last_at
    FROM bot_decisions
    WHERE action IN ('buy', 'sell', 'close', 'manage')
  `);
  const last_at = r.rows[0]?.last_at;
  const ageMs = last_at ? Date.now() - new Date(last_at).getTime() : Infinity;
  const doc = {
    what: 'Most recent bot action that involved live execution (buy/sell/close/manage), as opposed to a skip decision.',
    why:  'A separate health signal from the scanner. The scanner may be running (producing skip_no_candidate every 5 min) but the executor never fires. Catches the case where scans happen but trades never do — what bot 16 looked like.',
    if_red: 'Only meaningful when bots are active and likely to fire. With no bots running, this will look stale and that is expected. Combine with "Active bots" check.',
  };
  const val = last_at ? `last execute ${fmt.age(last_at)}` : 'never';
  return ok('executor', 'cron', 'Executor last fire', val, 'informational', doc);
}

async function checkLastModelTraining(query) {
  const r = await query(`SELECT trained_at, auc_roc, accuracy, f1_1 FROM model_results ORDER BY trained_at DESC LIMIT 1`);
  if (!r.rows.length) {
    return warn('ml_train', 'ml', 'Latest model training', 'no models in DB', 'expected ≥ 1', {
      what: 'Latest entry in model_results.', why: 'Without a trained model, the ML grade-adjustment layer cannot run.',
      if_red: 'Run `npm run research:train`.',
    });
  }
  const { trained_at, auc_roc } = r.rows[0];
  const ageMs = Date.now() - new Date(trained_at).getTime();
  const doc = {
    what: 'Time since the most-recent ML model training run. The trainer runs nightly from the research pipeline.',
    why:  'Stale models go out of sync with current market dynamics. New features added to the conviction scoring should be reflected in model retraining.',
    if_red: 'Run `npm run research:train` manually. Validate the nightly cron is firing.',
  };
  const val = `last ${fmt.age(trained_at)} · AUC ${Number(auc_roc).toFixed(3)}`;
  const threshold = '< 14 days';
  if (ageMs > 30 * 86_400_000)  return fail('ml_train', 'ml', 'Latest model training', val, threshold, doc);
  if (ageMs > 14 * 86_400_000)  return warn('ml_train', 'ml', 'Latest model training', val, threshold, doc);
  return                               ok(  'ml_train', 'ml', 'Latest model training', val, threshold, doc);
}

async function checkModelAuc(query) {
  const r = await query(`SELECT auc_roc, accuracy, f1_1 FROM model_results ORDER BY trained_at DESC LIMIT 1`);
  if (!r.rows.length) return warn('ml_auc', 'ml', 'ML model AUC', 'no models', '> 0.55', {
    what: 'AUC ROC of the latest trained model.', why: 'AUC measures predictive skill.', if_red: 'Train a model.',
  });
  const auc = Number(r.rows[0].auc_roc);
  const doc = {
    what: 'AUC ROC of the latest trained model. 0.5 = random (no skill), 0.7+ = useful predictor.',
    why:  'The ML layer adjusts conviction grades by ±1-3 points. If AUC is near 0.5, the adjustment is noise — neutral at best, actively harmful at worst.',
    if_red: 'Current model is mostly VIX-driven (per feature_weights). Real fix: retrain with per-symbol features (forward momentum, sector-relative strength). Multi-week project. Current adjustments are mild enough to leave in place.',
  };
  const val = `AUC ${auc.toFixed(3)} · Acc ${(Number(r.rows[0].accuracy)*100).toFixed(1)}%`;
  const threshold = 'AUC > 0.55 (skill threshold)';
  if (auc < 0.52)  return fail('ml_auc', 'ml', 'ML model AUC',  val, threshold, doc);
  if (auc < 0.55)  return warn('ml_auc', 'ml', 'ML model AUC',  val, threshold, doc);
  return                  ok(  'ml_auc', 'ml', 'ML model AUC',  val, threshold, doc);
}

async function checkSignalVariance(query) {
  const r = await query(`
    SELECT STDDEV(score) AS sdv, AVG(score) AS avg, COUNT(*) AS n
    FROM (SELECT score FROM conviction_scores ORDER BY scored_at DESC LIMIT 1000) s
  `);
  const { sdv, avg, n } = r.rows[0];
  const doc = {
    what: 'Standard deviation of the most recent 1,000 conviction scores. A healthy distribution spreads across the 0–100 range.',
    why:  'If sigma collapses (all scores stuck at one value), the scoring pipeline has lost discrimination — every name looks identical to the bot. Possible causes: a key data source returned null and the scoring code didn’t handle it, or fixed-weight bias overwhelmed the variable signals.',
    if_red: 'Inspect recent breakdown JSON in conviction_scores. Compare to known-good distribution. Likely a missing data source.',
  };
  const sd  = Number(sdv);
  const val = n ? `σ=${sd.toFixed(1)} · μ=${Number(avg).toFixed(1)} · N=${n}` : 'no scores';
  const threshold = 'σ ≥ 10';
  if (n === 0)     return warn('sig_var', 'ml', 'Signal variance', val, threshold, doc);
  if (sd < 5)      return fail('sig_var', 'ml', 'Signal variance', val, threshold, doc);
  if (sd < 10)     return warn('sig_var', 'ml', 'Signal variance', val, threshold, doc);
  return                  ok(  'sig_var', 'ml', 'Signal variance', val, threshold, doc);
}

async function checkPm2Processes() {
  const expected = ['trading-bot', 'trading-dashboard', 'trading-staging'];
  const docBase = {
    what: 'Calls `pm2 jlist` and inspects each expected PM2-managed process for online status and uptime.',
    why:  'A crashed or down process is the loudest possible bug — but only if you’re watching. This check fails fast when any of the 3 daemons drop offline.',
    if_red: 'Run `pm2 list` to confirm. Restart with `pm2 restart <name>`. Logs: `pm2 logs <name>`. Investigate root cause; do not silently restart in a loop.',
  };
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], { timeout: 5000 });
    const list = JSON.parse(stdout);
    const results = [];
    for (const name of expected) {
      const p = list.find(x => x.name === name);
      if (!p)               results.push(fail(`pm2_${name}`,    'process', `PM2: ${name}`, 'not found',            'online', docBase));
      else if (p.pm2_env?.status !== 'online') results.push(fail(`pm2_${name}`, 'process', `PM2: ${name}`, p.pm2_env?.status ?? '?', 'online', docBase));
      else {
        const uptime = Date.now() - (p.pm2_env?.pm_uptime ?? 0);
        const restarts = p.pm2_env?.restart_time ?? 0;
        const uptimeStr = uptime < 86400_000 ? `${(uptime/3600_000).toFixed(1)}h` : `${(uptime/86400_000).toFixed(1)}d`;
        const val = `online · uptime ${uptimeStr} · ${restarts} restarts`;
        if (uptime < 60_000)            results.push(warn(`pm2_${name}`, 'process', `PM2: ${name}`, val, 'online + stable', docBase));
        else                             results.push(ok(  `pm2_${name}`, 'process', `PM2: ${name}`, val, 'online', docBase));
      }
    }
    return results;
  } catch (e) {
    return [fail('pm2', 'process', 'PM2 list',        `pm2 jlist failed: ${e.message}`,         'available on PATH', docBase)];
  }
}

async function checkDbLatency(query) {
  const t0 = Date.now();
  await query('SELECT 1');
  const ms = Date.now() - t0;
  const doc = {
    what: 'Round-trip latency of a `SELECT 1` query against Postgres.',
    why:  'Slow DB → slow scans, missed cron windows, timeout errors elsewhere. Detects connection pool exhaustion or unhealthy Postgres.',
    if_red: 'Restart trading-dashboard. Check Postgres logs and connection pool. `pg_stat_activity` for stuck queries.',
  };
  const val = `${ms} ms`;
  if (ms > 1000)  return fail('db_latency', 'process', 'Postgres latency', val, '< 200 ms', doc);
  if (ms > 200)   return warn('db_latency', 'process', 'Postgres latency', val, '< 200 ms', doc);
  return                 ok(  'db_latency', 'process', 'Postgres latency', val, '< 200 ms', doc);
}

// Verifies Anthropic API key is set + accepted. Calls /v1/models which is
// the cheapest authenticated GET. Added 2026-05-24 after a PM2 env-cache
// bug silently swallowed the key for weeks and broke every sentinel run.
async function checkAnthropicKey() {
  const doc = {
    what: 'Calls https://api.anthropic.com/v1/models with the dashboard\'s ANTHROPIC_API_KEY. 200 = key valid. 401 = invalid/expired/missing key. Other = transient.',
    why:  'Every Claude-backed feature depends on this: Sentinel risk prose, AI Chat, admin AI, knowledge-base routing, stock-selector. Silent failure here surfaces as "Could not resolve authentication method" everywhere.',
    if_red: 'Most common cause: PM2 cached an empty env value. Run `set -a && . ./.env && set +a && pm2 restart trading-dashboard --update-env`. If still red, check the key on console.anthropic.com (expired / revoked / billing).',
  };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return fail('anthropic_key', 'process', 'Anthropic API key', 'env var ANTHROPIC_API_KEY is empty or unset', 'must be set + valid', doc);
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const valShort = `HTTP ${r.status} · key length ${key.length}`;
    if (r.status === 200)       return ok(  'anthropic_key', 'process', 'Anthropic API key', valShort, '200 OK', doc);
    if (r.status === 401)       return fail('anthropic_key', 'process', 'Anthropic API key', valShort + ' (invalid / expired / wrong key)', '200 OK', doc);
    if (r.status === 429)       return warn('anthropic_key', 'process', 'Anthropic API key', valShort + ' (rate-limited — key valid but throttled)', '200 OK', doc);
    return warn('anthropic_key', 'process', 'Anthropic API key', valShort, '200 OK', doc);
  } catch (e) {
    return warn('anthropic_key', 'process', 'Anthropic API key', `fetch failed: ${e.message}`, '200 OK from /v1/models', doc);
  }
}

async function checkActiveBots(query) {
  const r = await query(`SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL AND status='active') AS active,
                                COUNT(*) FILTER (WHERE deleted_at IS NULL AND status='paused') AS paused,
                                COUNT(*) FILTER (WHERE deleted_at IS NULL AND status='stopped') AS stopped,
                                COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS archived FROM bots`);
  const { active, paused, stopped, archived } = r.rows[0];
  const doc = {
    what: 'Bot population breakdown by status.',
    why:  'Sanity check that the bot fleet matches your expectations. "stopped" bots may have hit the circuit breaker. Sudden change from active → stopped is worth investigating.',
    if_red: 'Click into the Bots tab to inspect each. "stopped" bots show their last error and the cumulative_pnl_usd that tripped max_loss_usd.',
  };
  const val = `${active} active · ${paused} paused · ${stopped} stopped · ${archived} archived`;
  return ok('active_bots', 'process', 'Active bots', val, 'informational', doc);
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function runAllChecks(query) {
  const t0 = Date.now();
  const checks = await Promise.allSettled([
    checkTradableUniverse(query),
    checkUwFlowAlerts(query),
    checkBenzingaNews(query),
    checkUwTopMovers(query),
    checkBacktestPrices(query),
    checkConvictionScoresToday(query),
    checkUniverseSyncRecency(query),
    checkBotScanHeartbeat(query),
    checkExecutorHeartbeat(query),
    checkDanglingTradePointers(query),
    checkStalePredictions(query),
    checkLastModelTraining(query),
    checkModelAuc(query),
    checkSignalVariance(query),
    checkActiveBots(query),
    checkDbLatency(query),
    checkAnthropicKey(),
    // PM2 check returns an array — wrap so allSettled handles it uniformly
    checkPm2Processes(),
  ]);

  // Flatten results; rejected checks get a synthetic fail entry with a unique id
  let errIdx = 0;
  const flat = checks.flatMap((r, i) => {
    if (r.status === 'fulfilled') {
      // PM2 returns an array; all others return a single object
      return Array.isArray(r.value) ? r.value : [r.value];
    }
    return [fail(`err_${errIdx++}`, 'process', 'Check error', r.reason?.message ?? 'unknown', 'no errors', {
      what: 'A health check threw an unhandled exception.',
      why:  'Bug in the check itself or an unexpected runtime error.',
      if_red: 'Inspect server logs for the stack trace.',
    })];
  });

  return {
    generated_at: new Date().toISOString(),
    duration_ms:  Date.now() - t0,
    market_hours: isMarketHours(),
    checks: flat,
    summary: {
      total: flat.length,
      ok:   flat.filter(c => c.status === 'ok').length,
      warn: flat.filter(c => c.status === 'warn').length,
      fail: flat.filter(c => c.status === 'fail').length,
    },
  };
}
