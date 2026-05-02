import { query } from './db.js';

const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

// ─── Core screen query ────────────────────────────────────────────────────────

export async function screenFundamentals(conditions = {}) {
  const conditionFilters = [];

  if (conditions.rev_qoq) conditionFilters.push('AND q0.revenue      > q1.revenue');
  if (conditions.rev_yoy) conditionFilters.push('AND q0.revenue      > q4.revenue');
  if (conditions.ni_qoq)  conditionFilters.push('AND q0.net_income   > q1.net_income');
  if (conditions.ni_yoy)  conditionFilters.push('AND q0.net_income   > q4.net_income');
  if (conditions.eps_qoq) conditionFilters.push('AND q0.eps_diluted  > q1.eps_diluted');
  if (conditions.eps_yoy) conditionFilters.push('AND q0.eps_diluted  > q4.eps_diluted');

  const extraWhere = conditionFilters.join('\n    ');

  const { rows } = await query(`
    WITH ranked AS (
      SELECT symbol, period_end, revenue, net_income, eps_diluted,
             gross_profit, operating_income,
             ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY period_end DESC) AS rn
      FROM fundamentals
      WHERE period_type = 'quarterly'
    ),
    q0 AS (SELECT * FROM ranked WHERE rn = 1),
    q1 AS (SELECT * FROM ranked WHERE rn = 2),
    q4 AS (SELECT * FROM ranked WHERE rn = 5)
    SELECT
      q0.symbol,
      q0.period_end                                                                AS latest_quarter,
      q0.revenue,         q1.revenue         AS rev_prev_q,  q4.revenue         AS rev_prev_year,
      q0.net_income,      q1.net_income      AS ni_prev_q,   q4.net_income      AS ni_prev_year,
      q0.eps_diluted,     q1.eps_diluted     AS eps_prev_q,  q4.eps_diluted     AS eps_prev_year,
      q0.gross_profit,
      ROUND(100.0*(q0.revenue    - q1.revenue)   /NULLIF(q1.revenue,0),   1) AS rev_qoq_pct,
      ROUND(100.0*(q0.revenue    - q4.revenue)   /NULLIF(q4.revenue,0),   1) AS rev_yoy_pct,
      ROUND(100.0*(q0.net_income - q1.net_income)/NULLIF(q1.net_income,0),1) AS ni_qoq_pct,
      ROUND(100.0*(q0.net_income - q4.net_income)/NULLIF(q4.net_income,0),1) AS ni_yoy_pct,
      ROUND(100.0*(q0.eps_diluted- q1.eps_diluted)/NULLIF(q1.eps_diluted,0),1) AS eps_qoq_pct,
      ROUND(100.0*(q0.eps_diluted- q4.eps_diluted)/NULLIF(q4.eps_diluted,0),1) AS eps_yoy_pct
    FROM q0
    JOIN q1 ON q0.symbol = q1.symbol
    JOIN q4 ON q0.symbol = q4.symbol
    WHERE q0.revenue    IS NOT NULL
      AND q0.net_income IS NOT NULL
      AND q0.eps_diluted IS NOT NULL
    ${extraWhere}
    ORDER BY q0.revenue DESC
  `);

  return { results: rows, count: rows.length, conditions_applied: conditions };
}

// ─── Pattern-match detector (zero API cost) ───────────────────────────────────

export async function isFundamentalScreeningQuestion(text) {
  const patterns = [
    /revenue.*grow/i,      /profit.*grow/i,       /eps.*grow/i,
    /pass.*condition/i,    /screen.*stock/i,       /filter.*stock/i,
    /which.*stock.*revenue/i, /which.*stock.*profit/i, /which.*stock.*eps/i,
    /s&p.*500.*revenue/i,  /s&p.*500.*profit/i,    /s&p.*500.*eps/i,
    /all.*condition/i,     /fundamental/i,          /quarterly.*growth/i,
    /revenue.*greater/i,   /profit.*greater/i,      /earnings.*grow/i,
  ];
  return patterns.some(p => p.test(text));
}

// ─── Format results with Ollama insight ──────────────────────────────────────

export async function formatScreenerAnswer(results, conditions, userQuestion) {
  if (results.length === 0) {
    const applied = Object.entries(conditions)
      .filter(([, v]) => v)
      .map(([k]) => k.replace('_', ' ').toUpperCase())
      .join(', ');
    return {
      answer: `No stocks in the S&P 500 / NASDAQ-100 universe passed all the requested conditions (${applied || 'none set'}).\n\nThis is unusual — try relaxing one or two filters, or run \`npm run research:fundamentals\` to refresh the data.`,
      count: 0,
      top: [],
    };
  }

  const top20 = results.slice(0, 20);
  const fmt   = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`;
  const fmtB  = v => v == null ? '—' : `$${(v / 1e9).toFixed(1)}B`;

  const header = '| Symbol | Latest Q | Revenue | Rev QoQ | Rev YoY | NI QoQ | NI YoY | EPS QoQ | EPS YoY |';
  const sep    = '|--------|----------|---------|---------|---------|--------|--------|---------|---------|';
  const rows   = top20.map(r =>
    `| ${r.symbol.padEnd(6)} | ${String(r.latest_quarter).slice(0,10)} ` +
    `| ${fmtB(r.revenue)} | ${fmt(r.rev_qoq_pct)} | ${fmt(r.rev_yoy_pct)} ` +
    `| ${fmt(r.ni_qoq_pct)} | ${fmt(r.ni_yoy_pct)} ` +
    `| ${fmt(r.eps_qoq_pct)} | ${fmt(r.eps_yoy_pct)} |`
  );

  const table = [header, sep, ...rows].join('\n');
  const totalNote = results.length > 20
    ? `\n\n*(Showing top 20 by revenue. ${results.length} stocks passed all conditions.)*`
    : '';

  const prompt =
    `You are a stock screener. The user asked: ${userQuestion}\n` +
    `${results.length} stocks passed all conditions. Here are the top results:\n\n` +
    `${table}\n\n` +
    `Give a 2-sentence summary of what this means and the top 3 names to investigate further. ` +
    `Be specific. No waffle.`;

  let insight = '';
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    const resp  = await fetch(`${OLLAMA_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:    OLLAMA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream:   false,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (resp.ok) {
      const data = await resp.json();
      insight = '\n\n**Insight:** ' + (data.message?.content?.trim() ?? '');
    }
  } catch {
    // Ollama offline — omit insight, still return table
  }

  const answer =
    `**${results.length} stock${results.length === 1 ? '' : 's'} passed your screen** ` +
    `(S&P 500 + NASDAQ-100, latest quarterly data):\n\n` +
    `${table}${totalNote}${insight}`;

  return { answer, count: results.length, top: top20 };
}
