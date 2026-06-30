/**
 * src/sim/learn.mjs — self-learning layer (task 4).
 *
 * At each sim-EOD: reflect on ALREADY-CLOSED trades only (never the future),
 * and possibly adopt a new policy version for the next day.
 *
 *   Claude (Max sub)  = the reasoning  → proposes bounded policy changes + a lesson
 *   Deterministic code = the guardrail → clamps every change to safe bounds and a
 *                                        max step size, so the LLM can't wreck it.
 *
 * Everything (the proposal, the clamped result, the lesson) is written to
 * sim.lessons, so the learning is fully auditable even though an LLM is in it.
 * The LLM runs nightly only — never in the per-trade path.
 */
import { simQuery } from './db.mjs';
import { askClaudeJSON } from './claude-reflect.mjs';

const REFLECT_EVERY = 8;        // reflect once this many NEW trades have closed
const _lastReflectN = new Map(); // runId -> closed-trade count at last reflection

// hard bounds — the LLM's proposal is clamped into these no matter what it says
const BOUNDS = {
  'exits.hard_sl_pct':   [0.05, 0.15, 0.03],   // [min, max, max step per reflection]
  'exits.trail_pct':     [0.05, 0.15, 0.03],
  'exits.time_stop_days':[2, 7, 2],
  'setup.pullback_min':  [-0.12, -0.04, 0.03],
  'setup.pullback_max':  [-0.04, -0.01, 0.02],
  'setup.rvol_max':      [1.5, 3.0, 0.5],
  'setup.dist52w_min':   [-0.25, -0.05, 0.07],
  'entry.earliest_et_min':[570, 720, 60],
  'sizing.max_new_per_day':[2, 8, 2],
};
const ALLOWED_REGIMES = ['R1_up_calm', 'R2_up_vol', 'R3_down_calm', 'R4_down_vol'];

function clampField(path, proposed, current) {
  const b = BOUNDS[path];
  if (!b) return current;
  const [lo, hi, step] = b;
  let v = Number(proposed);
  if (!Number.isFinite(v)) return current;
  v = Math.max(lo, Math.min(hi, v));                       // bound
  v = Math.max(current - step, Math.min(current + step, v)); // step limit
  return v;
}
const get = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
const set = (o, path, v) => { const ks = path.split('.'); const last = ks.pop(); let t = o; for (const k of ks) t = t[k]; t[last] = v; };

async function gatherStats(runId, simDate) {
  const where = `run_id=$1 AND status='closed' AND exit_ts <= ($2::date + 1)`;
  const overall = (await simQuery(`SELECT count(*) n, count(*) FILTER (WHERE pnl>0) wins,
      round(avg(pnl_pct)::numeric,3) avg_pct, round(sum(pnl)::numeric,2) pnl,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY pnl_pct))::numeric,3) med_pct
    FROM sim.trades WHERE ${where}`, [runId, simDate])).rows[0];
  const byExit = (await simQuery(`SELECT exit_reason, count(*) n, count(*) FILTER (WHERE pnl>0) wins,
      round(avg(pnl_pct)::numeric,3) avg_pct FROM sim.trades WHERE ${where}
    GROUP BY 1 ORDER BY 2 DESC`, [runId, simDate])).rows;
  const byRegime = (await simQuery(`SELECT regime, count(*) n, count(*) FILTER (WHERE pnl>0) wins,
      round(avg(pnl_pct)::numeric,3) avg_pct FROM sim.trades WHERE ${where}
    GROUP BY 1 ORDER BY 2 DESC`, [runId, simDate])).rows;
  return { overall, byExit, byRegime };
}

function buildPrompt(policy, stats, simDate) {
  return `You are the risk-and-tuning brain of a stock-trading bot, reviewing its OWN closed trades to improve the next day. Be conservative and evidence-driven — small changes, only where the data supports it.

STRATEGY THESIS (do not abandon it): buy "uptrend pullbacks" — names above their 200-day MA, within ~15% of the 52-week high, that pulled back 2-8% over 5 days on BELOW-average volume, entered intraday on stabilization. Exits are intentionally WIDE because tight stops historically sold noise at the bottom.

AS OF ${simDate}. CURRENT POLICY (only these knobs are tunable):
${JSON.stringify({ regimes_allowed: policy.regimes_allowed, setup: policy.setup, entry: { earliest_et_min: policy.entry.earliest_et_min, uw_confirm: policy.entry.uw_confirm }, sizing: { max_new_per_day: policy.sizing.max_new_per_day }, exits: policy.exits }, null, 1)}

CLOSED-TRADE STATS SO FAR (already-closed only — no future data):
overall: ${JSON.stringify(stats.overall)}
by_exit_reason: ${JSON.stringify(stats.byExit)}
by_regime: ${JSON.stringify(stats.byRegime)}

Diagnose: are exits too tight (stops dominating losses)? wrong regime? entries too loose/strict? Then propose adjustments.

Reply with ONLY this JSON (include a key under "changes" ONLY if you want to change it; omit everything you'd leave alone):
{
 "lesson": "one short paragraph explaining what the data shows and what you changed and why",
 "confidence": "low|medium|high",
 "changes": {
   "exits": {"hard_sl_pct": 0.0, "trail_pct": 0.0, "time_stop_days": 0},
   "setup": {"pullback_min": 0.0, "pullback_max": 0.0, "rvol_max": 0.0, "dist52w_min": 0.0},
   "entry": {"earliest_et_min": 0, "uw_confirm": false},
   "sizing": {"max_new_per_day": 0},
   "regimes_allowed": ["R1_up_calm","R2_up_vol"]
 }
}
Values are clamped to safe bounds on my side, so propose freely but sensibly. If the data is too thin or things look fine, return "changes": {}.`;
}

/** Apply Claude's proposal through the deterministic guardrail. Returns {policy,changed,applied}. */
function applyGuardrail(policy, proposal) {
  const next = structuredClone(policy);
  const applied = {};
  const ch = proposal?.changes || {};
  for (const path of Object.keys(BOUNDS)) {
    const [grp, key] = path.split('.');
    if (ch[grp] && ch[grp][key] != null) {
      const cur = get(policy, path);
      const v = clampField(path, ch[grp][key], cur);
      if (v !== cur) { set(next, path, v); applied[path] = { from: cur, to: v }; }
    }
  }
  // booleans / arrays (no numeric clamp, but validated)
  if (ch.entry && typeof ch.entry.uw_confirm === 'boolean' && ch.entry.uw_confirm !== policy.entry.uw_confirm) {
    next.entry.uw_confirm = ch.entry.uw_confirm; applied['entry.uw_confirm'] = { from: policy.entry.uw_confirm, to: ch.entry.uw_confirm };
  }
  if (Array.isArray(ch.regimes_allowed)) {
    const r = ch.regimes_allowed.filter(x => ALLOWED_REGIMES.includes(x));
    if (r.length && JSON.stringify(r) !== JSON.stringify(policy.regimes_allowed)) {
      next.regimes_allowed = r; applied['regimes_allowed'] = { from: policy.regimes_allowed, to: r };
    }
  }
  const changed = Object.keys(applied).length > 0;
  return { policy: next, changed, applied };
}

export async function reflectAndAdapt({ runId, simDate, policy }) {
  const total = (await simQuery(
    `SELECT count(*) n FROM sim.trades WHERE run_id=$1 AND status='closed' AND exit_ts <= ($2::date + 1)`,
    [runId, simDate])).rows[0].n | 0;
  const last = _lastReflectN.get(runId) ?? 0;
  if (total - last < REFLECT_EVERY) return null;     // not enough new evidence yet
  _lastReflectN.set(runId, total);

  const stats = await gatherStats(runId, simDate);
  const prompt = buildPrompt(policy, stats, simDate);

  let proposal;
  try { proposal = await askClaudeJSON(prompt); }
  catch (e) { proposal = { _error: e.message }; }

  const { policy: next, changed, applied } = proposal && !proposal._error && !proposal._parseError
    ? applyGuardrail(policy, proposal)
    : { policy, changed: false, applied: {} };

  if (changed) { next.version = policy.version + 1; next.source = 'claude'; next.rationale = (proposal.lesson || '').slice(0, 500); }

  await simQuery(
    `INSERT INTO sim.lessons(run_id,sim_date,closed_n,claude_proposal,stats_verdict,adopted,narrative)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [runId, simDate, total, JSON.stringify(proposal ?? {}), JSON.stringify({ applied, overall: stats.overall }), changed, (proposal?.lesson || proposal?._error || proposal?._raw || '').slice(0, 1000)]);

  return changed ? next : null;
}
