import pg from 'pg';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function safeQuery(sql) {
  try {
    return (await pool.query(sql)).rows;
  } catch {
    return [];
  }
}

async function main() {
  const [stats, grades, regimes, symbols, lessons, patterns] = await Promise.all([
    safeQuery(`
      SELECT
        COUNT(*)                                                                AS total_trades,
        SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END)                          AS wins,
        SUM(CASE WHEN pnl_usd <= 0 THEN 1 ELSE 0 END)                         AS losses,
        ROUND(100.0 * SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 1) AS win_rate,
        ROUND(AVG(CASE WHEN pnl_usd > 0 THEN pnl_usd END)::numeric, 2)        AS avg_win,
        ROUND(AVG(CASE WHEN pnl_usd <= 0 THEN pnl_usd END)::numeric, 2)       AS avg_loss,
        ROUND(SUM(pnl_usd)::numeric, 2)                                        AS total_pnl,
        ROUND(AVG(pnl_usd)::numeric, 2)                                        AS avg_pnl
      FROM trades WHERE status = 'closed' AND pnl_usd IS NOT NULL
    `),
    safeQuery(`
      SELECT
        conviction_grade                                                        AS grade,
        COUNT(*)                                                                AS trades,
        ROUND(100.0 * SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS win_rate,
        ROUND(AVG(pnl_usd)::numeric, 2)                                        AS avg_pnl
      FROM trades
      WHERE status = 'closed' AND pnl_usd IS NOT NULL AND conviction_grade IS NOT NULL
      GROUP BY conviction_grade ORDER BY conviction_grade
    `),
    safeQuery(`
      SELECT
        conviction_breakdown->>'regime'                                         AS regime,
        COUNT(*)                                                                AS trades,
        ROUND(100.0 * SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS win_rate,
        ROUND(AVG(pnl_usd)::numeric, 2)                                        AS avg_pnl
      FROM trades
      WHERE status = 'closed' AND pnl_usd IS NOT NULL
        AND conviction_breakdown->>'regime' IS NOT NULL
      GROUP BY regime ORDER BY win_rate DESC
    `),
    safeQuery(`
      SELECT
        symbol,
        COUNT(*)                                                                AS trades,
        ROUND(SUM(pnl_usd)::numeric, 2)                                        AS total_pnl,
        ROUND(AVG(pnl_usd)::numeric, 2)                                        AS avg_pnl,
        ROUND(100.0 * SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS win_rate
      FROM trades
      WHERE status = 'closed' AND pnl_usd IS NOT NULL
      GROUP BY symbol HAVING COUNT(*) >= 2
      ORDER BY avg_pnl DESC
    `),
    safeQuery(`
      SELECT lesson, outcome, regime, symbol
      FROM trade_lessons
      ORDER BY created_at DESC LIMIT 30
    `),
    safeQuery(`
      SELECT regime, vix_bucket, trades, win_rate, avg_pnl
      FROM performance_patterns
      ORDER BY regime, vix_bucket
    `),
  ]);

  const s = stats[0] ?? {};
  const bestSymbols  = symbols.slice(0, 5);
  const worstSymbols = symbols.slice(-5).reverse();

  const statsSection = (s.total_trades > 0) ? `
=== TRADER'S REAL PERFORMANCE (${s.total_trades} trades) ===
Win Rate: ${s.win_rate}% | Total P&L: $${s.total_pnl}
Avg Win: $${s.avg_win} | Avg Loss: $${s.avg_loss} | Avg per trade: $${s.avg_pnl}
` : '=== NO TRADE HISTORY YET ===';

  const gradeSection = grades.length ? `
=== WIN RATE BY CONVICTION GRADE ===
${grades.map(g => `Grade ${g.grade}: ${g.win_rate}% win rate, avg $${g.avg_pnl} (${g.trades} trades)`).join('\n')}
` : '';

  const regimeSection = regimes.length ? `
=== WIN RATE BY MARKET REGIME ===
${regimes.map(r => `${r.regime}: ${r.win_rate}% win rate, avg $${r.avg_pnl} (${r.trades} trades)`).join('\n')}
` : '';

  const symbolSection = bestSymbols.length ? `
=== BEST PERFORMING SYMBOLS ===
${bestSymbols.map(s => `${s.symbol}: avg $${s.avg_pnl}, ${s.win_rate}% win rate (${s.trades} trades)`).join('\n')}

=== WORST PERFORMING SYMBOLS ===
${worstSymbols.map(s => `${s.symbol}: avg $${s.avg_pnl}, ${s.win_rate}% win rate (${s.trades} trades)`).join('\n')}
` : '';

  const lessonsSection = lessons.length ? `
=== LESSONS LEARNED FROM REAL TRADES ===
${lessons.map(l => `- [${(l.outcome ?? 'TRADE').toUpperCase()}${l.symbol ? ' ' + l.symbol : ''}${l.regime ? ' ' + l.regime : ''}] ${l.lesson}`).join('\n')}
` : '';

  const modelfile = `FROM qwen2.5:32b

PARAMETER temperature 0.3
PARAMETER top_p 0.9
PARAMETER num_ctx 8192
PARAMETER repeat_penalty 1.1

SYSTEM """
You are a personal AI trading coach for a Singapore-based day trader
who trades US stocks during US market hours (9:30 PM to 4:00 AM SGT).
${statsSection}${gradeSection}${regimeSection}${symbolSection}${lessonsSection}
=== FIXED TRADING RULES ===
- Daily profit target: $150-200. Stop trading once hit.
- Daily loss limit: $200. Stop ALL trading once hit.
- Maximum 2 open positions at the same time.
- Minimum conviction score to enter: 50/100.
- Never open new positions after 3:15 PM ET (3:15 AM SGT).
- Stop loss: 1.5x ATR below entry price.
- Profit target: 3x ATR above entry price.
- Risk/reward minimum: 2:1.
- Never average down on a losing position.
- Never revenge trade after a loss — wait 30 minutes minimum.
- Re-entry block: cannot re-enter a symbol that stopped out in last 60 minutes.

=== HOW TO RESPOND ===
- Always reference the trader's ACTUAL data above when available.
- Be direct and concise — 3 to 5 sentences for most answers.
- For trade analysis questions: cite specific dates, symbols, P&L figures, conviction scores.
- For pattern questions: compare winning trade conditions vs losing trade conditions from the data.
- For strategy questions: reference what actually worked in this trader's history.
- Never give generic textbook advice when specific historical data is available above.
- If no trade data exists yet, give general advice but note it is not yet personalised.
"""
`;

  const outPath = resolve('./trading-coach.Modelfile');
  writeFileSync(outPath, modelfile, 'utf8');

  console.log('\n✅ Modelfile written to ./trading-coach.Modelfile');
  console.log('\nNext steps:');
  console.log('  1. ollama create trading-coach -f trading-coach.Modelfile');
  console.log('  2. Set in .env: OLLAMA_MODEL=trading-coach');
  console.log('  3. Restart the server');
  console.log('\nThe model will know your real trade history and personalised rules.');
}

main().catch(err => { console.error(err); process.exit(1); }).finally(() => pool.end());
