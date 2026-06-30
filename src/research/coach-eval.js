// Accuracy eval for trading-coach v2.
//
//   node src/research/coach-eval.js
//
// For each question we compute the GROUND TRUTH directly from PostgreSQL, ask
// the coach the same question, and check whether its answer matches the truth.
// Truth is recomputed live every run, so the eval can never go stale — it
// measures "does the coach report what's actually in the DB right now".
//
// This is the test that settles v1-vs-v2: a baked-in model fails the moment the
// data moves; v2 should score ~100% because it fetches.
import './../core/env-loader.js';
import pg from 'pg';
import { askCoach, closeCoach } from '../core/trading-coach-agent.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

// ── matchers (operate on the coach's natural-language answer) ────────────────
const norm = (s) => (s || '').replace(/,/g, ''); // strip thousands separators
const hasPct    = (resp, val) => norm(resp).includes(Number(val).toFixed(1));
const hasDollar = (resp, val) => norm(resp).includes(String(Math.round(Math.abs(Number(val))))); // integer part
const hasInt    = (resp, n)   => new RegExp(`\\b${n}\\b`).test(norm(resp));
const hasTicker = (resp, t)   => new RegExp(`\\b${t}\\b`, 'i').test(resp);
const saysNoData = (resp) => /\b(no|zero|don'?t have|cannot|can't|no recorded|not (any|enough)|haven'?t)\b/i.test(resp);

// ── test definitions ─────────────────────────────────────────────────────────
// Each: question + check(responseText) -> { pass, expected }
const TESTS = [
  {
    id: 'overall-winrate',
    question: 'What is my overall win rate across all closed trades? Give the percentage.',
    check: async (resp) => {
      const r = (await q(`SELECT ROUND(100.0*SUM(CASE WHEN pnl_usd>0 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS v FROM trades WHERE status='closed' AND pnl_usd IS NOT NULL`))[0].v;
      return { pass: hasPct(resp, r), expected: `${r}%` };
    },
  },
  {
    id: 'total-pnl',
    question: 'What is my total P&L in dollars across all closed trades?',
    check: async (resp) => {
      const r = (await q(`SELECT ROUND(SUM(pnl_usd)::numeric,2) AS v FROM trades WHERE status='closed' AND pnl_usd IS NOT NULL`))[0].v;
      return { pass: hasDollar(resp, r), expected: `$${r}` };
    },
  },
  {
    id: 'trade-count',
    question: 'Exactly how many closed trades do I have? Give the number.',
    check: async (resp) => {
      const r = (await q(`SELECT COUNT(*) AS v FROM trades WHERE status='closed' AND pnl_usd IS NOT NULL`))[0].v;
      return { pass: hasInt(resp, r), expected: `${r} trades` };
    },
  },
  {
    id: 'best-symbol',
    question: 'Which single symbol has my highest average P&L (minimum 2 trades)?',
    check: async (resp) => {
      const r = (await q(`SELECT symbol FROM trades WHERE status='closed' AND pnl_usd IS NOT NULL GROUP BY symbol HAVING COUNT(*)>=2 ORDER BY AVG(pnl_usd) DESC LIMIT 1`))[0].symbol;
      return { pass: hasTicker(resp, r), expected: r };
    },
  },
  {
    id: 'worst-symbol',
    question: 'Which single symbol has my lowest (most negative) average P&L, minimum 2 trades?',
    check: async (resp) => {
      const r = (await q(`SELECT symbol FROM trades WHERE status='closed' AND pnl_usd IS NOT NULL GROUP BY symbol HAVING COUNT(*)>=2 ORDER BY AVG(pnl_usd) ASC LIMIT 1`))[0].symbol;
      return { pass: hasTicker(resp, r), expected: r };
    },
  },
  {
    id: 'grade-a-winrate',
    question: 'What is my win rate on grade A conviction trades specifically? Give the percentage.',
    check: async (resp) => {
      const row = (await q(`SELECT ROUND(100.0*SUM(CASE WHEN pnl_usd>0 THEN 1 ELSE 0 END)/COUNT(*),1) AS v FROM trades WHERE status='closed' AND pnl_usd IS NOT NULL AND conviction_grade='A'`))[0];
      if (!row || row.v == null) return { pass: true, expected: '(no grade A trades — skipped)' };
      return { pass: hasPct(resp, row.v), expected: `${row.v}%` };
    },
  },
  {
    id: 'anti-hallucination',
    question: 'What is my win rate on FAKECO? Give me the exact percentage.',
    negative: true,
    check: async (resp) => {
      // Truth: zero FAKECO trades. PASS only if the coach refuses to invent a
      // win-rate number and instead says there's no data.
      const cnt = (await q(`SELECT COUNT(*) AS v FROM trades WHERE symbol='FAKECO'`))[0].v;
      const inventedPct = /\b\d{1,3}(\.\d+)?\s*%/.test(resp); // any "NN%" in the answer
      return { pass: Number(cnt) === 0 && saysNoData(resp) && !inventedPct, expected: 'no FAKECO trades → must refuse' };
    },
  },
];

async function main() {
  console.log(`\n🧪 trading-coach v2 accuracy eval — ${TESTS.length} questions, ground truth from live Postgres\n`);
  let passed = 0;
  const rows = [];

  for (const t of TESTS) {
    let resp = '', toolNames = '';
    try {
      const r = await askCoach(t.question, {});
      resp = r.text;
      toolNames = r.toolCalls.map(c => c.name).join('+') || '(none)';
    } catch (err) {
      rows.push({ id: t.id, pass: false, expected: 'ERROR', got: err.message.slice(0, 60), tools: '' });
      continue;
    }
    const { pass, expected } = await t.check(resp);
    if (pass) passed++;
    rows.push({
      id: t.id, pass, expected,
      got: resp.replace(/\s+/g, ' ').slice(0, 70),
      tools: toolNames,
    });
  }

  // print results
  for (const r of rows) {
    console.log(`${r.pass ? '✅' : '❌'} ${r.id.padEnd(18)} expect: ${String(r.expected).padEnd(26)} tools: ${r.tools}`);
    console.log(`   coach: "${r.got}…"\n`);
  }
  const pct = ((passed / TESTS.length) * 100).toFixed(1);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`SCORE: ${passed}/${TESTS.length} = ${pct}% accuracy vs live DB truth\n`);

  await closeCoach();
  await pool.end();
}

main().catch(async (err) => { console.error(err); await closeCoach().catch(() => {}); await pool.end().catch(() => {}); process.exit(1); });
