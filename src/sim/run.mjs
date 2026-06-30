/**
 * src/sim/run.mjs — BOT_SIM orchestrator.
 *
 *   node src/sim/run.mjs [--from 2026-05-11] [--to 2026-06-10] [--days N]
 *                        [--learn] [--run-id sim_xxx]
 *
 * Replays the window minute-by-minute through the forked engine. With --learn,
 * a Claude (Max-sub) reflection runs at each sim-EOD on already-closed trades
 * and may adopt a new policy version for the next day. Writes only to sim.*.
 */
import { simQuery, simEnd } from './db.mjs';
import { Feed } from './feed.mjs';
import { SimEngine } from './bot-sim/engine.mjs';
import { getStrategy } from './bot-sim/strategies/index.mjs';
import { reflectAndAdapt } from './learn.mjs';

function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}

async function main() {
  const from = arg('from', '2026-05-11');
  const to   = arg('to', '2026-06-10');
  const dayLimit = arg('days') ? +arg('days') : null;
  const learn = !!arg('learn', false);
  const quiet = !!arg('quiet', false);
  const exitsOverride = arg('exits') ? JSON.parse(arg('exits')) : null;
  const strategyName = arg('strategy') || 'pullback';
  const strategy = getStrategy(strategyName);
  const runId = arg('run-id') || `sim_${from.replace(/-/g,'')}_${Date.now().toString(36)}`;

  if (!quiet) console.log(`[sim] run ${runId}  window ${from}..${to}  learn=${learn}${dayLimit?`  (first ${dayLimit} days)`:''}`);

  const feed = new Feed();
  const info = await feed.init({ from, to });
  console.log(`[sim] feed: ${info.universe} symbols, ${info.sessions} sessions`);

  await simQuery(`INSERT INTO sim.runs(run_id,window_from,window_to,params,status)
                  VALUES ($1,$2,$3,$4,'running')
                  ON CONFLICT (run_id) DO UPDATE SET status='running', started_at=now()`,
    [runId, from, to, JSON.stringify({ strategy: strategyName, learn, dayLimit, slip_bps: 4 })]);
  // clear any prior rows for this run id (idempotent re-runs)
  for (const t of ['decisions','trades','equity','policy','lessons'])
    await simQuery(`DELETE FROM sim.${t} WHERE run_id=$1`, [runId]);

  let policy = structuredClone(strategy.seedPolicy);
  if (exitsOverride) Object.assign(policy.exits, exitsOverride);
  if (arg('entry')) Object.assign(policy.entry, JSON.parse(arg('entry')));
  if (arg('setup')) Object.assign(policy.setup, JSON.parse(arg('setup')));
  if (arg('regimes')) policy.regimes_allowed = arg('regimes').split(',');   // e.g. R1_up_calm,R2_up_vol,R3_down_calm,R4_down_vol
  await savePolicy(runId, policy, from, 'seed', 'initial evidence-based policy');

  const engine = new SimEngine({ feed, runId, strategy });
  let days = feed.sessionDates;
  if (dayLimit) days = days.slice(0, dayLimit);

  for (const date of days) {
    const r = await engine.runDay(date, policy);
    if (!quiet) console.log(`[sim] ${date}  regime=${r.regime ?? '-'}  qualified=${r.qualified}  entered=${r.entered}  closed=${r.closed}  open=${r.openNow}  equity=$${r.equity.toFixed(0)}`);
    if (learn) {
      const next = await reflectAndAdapt({ runId, simDate: date, policy });
      if (next) { policy = next; await savePolicy(runId, policy, date, policy.source, policy.rationale); console.log(`         ↳ policy v${policy.version} adopted (${policy.source})`); }
    }
  }

  await engine.liquidateAll();
  const summary = await finalize(runId, engine.startCash);
  await simQuery(`UPDATE sim.runs SET status='done', finished_at=now(), summary=$2 WHERE run_id=$1`,
    [runId, JSON.stringify(summary)]);
  if (quiet) {
    console.log(`${runId.padEnd(22)} trades=${String(summary.trades).padStart(3)}  win=${String(summary.win_pct).padStart(4)}%  ret=${String(summary.return_pct).padStart(6)}%  pnl=$${String(summary.pnl_usd).padStart(8)}  avgHold=${(summary.avg_hold_min/1440).toFixed(1)}d`);
  } else {
    console.log(`\n[sim] DONE ${runId}`);
    console.table([summary]);
  }
  await simEnd();
}

async function savePolicy(runId, policy, date, source, rationale) {
  await simQuery(`INSERT INTO sim.policy(run_id,version,effective_date,params,source,rationale)
                  VALUES ($1,$2,$3,$4,$5,$6)`,
    [runId, policy.version, date, JSON.stringify(policy), source, rationale || null]);
}

async function finalize(runId, startCash) {
  const t = (await simQuery(`
    SELECT count(*) n,
      count(*) FILTER (WHERE pnl > 0) wins,
      round(sum(pnl)::numeric,2) pnl,
      round(avg(pnl_pct)::numeric,3) avg_pct,
      round(avg(hold_minutes)::numeric,0) avg_hold_min,
      round(avg(slippage_bps)::numeric,1) avg_slip_bps
    FROM sim.trades WHERE run_id=$1 AND status='closed'`, [runId])).rows[0];
  const eq = (await simQuery(`SELECT equity FROM sim.equity WHERE run_id=$1 ORDER BY ts DESC LIMIT 1`, [runId])).rows[0];
  const finalEq = eq ? +eq.equity : startCash;
  return {
    trades: +t.n,
    win_pct: t.n > 0 ? +(100 * t.wins / t.n).toFixed(1) : 0,
    pnl_usd: +t.pnl || 0,
    avg_trade_pct: +t.avg_pct || 0,
    avg_hold_min: +t.avg_hold_min || 0,
    avg_slip_bps: +t.avg_slip_bps || 0,
    final_equity: +finalEq.toFixed(0),
    return_pct: +(100 * (finalEq - startCash) / startCash).toFixed(2),
  };
}

main().catch(e => { console.error('[sim] FATAL', e); process.exit(1); });
