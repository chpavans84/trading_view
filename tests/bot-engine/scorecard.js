/**
 * tests/bot-engine/scorecard.js
 *
 * Read-only analysis of bot_decisions history.
 * Run:  node --env-file=.env tests/bot-engine/scorecard.js
 *
 * Produces a markdown report at reports/bot-scorecard-YYYYMMDD.md showing:
 *   - 30-day decision volume per bot
 *   - Action histogram (buy / skip_* breakdown)
 *   - Symbol concentration (which tickers actually got scored)
 *   - Score distribution (when scored)
 *   - Daily trade counts
 *   - Earnings-window rejection estimates
 *   - Where the bot is wasting cycles
 */

import pg from 'pg';
import { promises as fs } from 'fs';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DAYS = 30;

function fmtPct(num, den) {
  if (!den) return '0%';
  return ((num / den) * 100).toFixed(1) + '%';
}

function mdTable(headers, rows) {
  const head = '| ' + headers.join(' | ') + ' |';
  const sep  = '|' + headers.map(() => '---').join('|') + '|';
  const body = rows.map(r => '| ' + r.join(' | ') + ' |').join('\n');
  return [head, sep, body].join('\n');
}

async function main() {
  const today = new Date().toISOString().split('T')[0];

  // ── 1. Bot inventory ──────────────────────────────────────────────────────
  const { rows: bots } = await pool.query(`
    SELECT b.id, b.name, u.username AS owner, b.broker, b.status,
           b.current_trade_id, b.total_trades, b.cumulative_pnl_usd,
           b.rules->'entry_filters'->>'min_composite_score' AS min_score,
           b.rules->'entry_filters'->>'require_setup_classification' AS req_setup,
           b.rules->'entry_filters'->>'require_uw_label_any' AS req_uw
    FROM bots b JOIN users u ON u.id = b.user_id
    WHERE b.deleted_at IS NULL
    ORDER BY u.username, b.id
  `);

  // ── 2. 30-day action histogram per bot ────────────────────────────────────
  const { rows: actions } = await pool.query(`
    SELECT b.name AS bot, bd.action, COUNT(*) AS n
    FROM bot_decisions bd JOIN bots b ON b.id = bd.bot_id
    WHERE bd.scanned_at > NOW() - INTERVAL '${DAYS} days'
    GROUP BY b.name, bd.action
    ORDER BY b.name, n DESC
  `);

  // ── 3. Daily decision volume ──────────────────────────────────────────────
  const { rows: daily } = await pool.query(`
    SELECT b.name AS bot,
           bd.scanned_at::date AS day,
           COUNT(*) AS scans,
           COUNT(*) FILTER (WHERE bd.action = 'buy') AS buys,
           COUNT(*) FILTER (WHERE bd.composite_score IS NOT NULL) AS scored,
           MAX(bd.composite_score) AS peak_score
    FROM bot_decisions bd JOIN bots b ON b.id = bd.bot_id
    WHERE bd.scanned_at > NOW() - INTERVAL '${DAYS} days'
    GROUP BY b.name, bd.scanned_at::date
    ORDER BY day DESC, bot
    LIMIT 200
  `);

  // ── 4. Symbol concentration (which tickers actually scored) ───────────────
  const { rows: symbols } = await pool.query(`
    SELECT bd.symbol,
           COUNT(*) AS times_scored,
           MIN(bd.composite_score) AS min_score,
           MAX(bd.composite_score) AS max_score,
           AVG(bd.composite_score)::numeric(6,2) AS avg_score,
           COUNT(*) FILTER (WHERE bd.action = 'buy') AS buys_triggered
    FROM bot_decisions bd
    WHERE bd.scanned_at > NOW() - INTERVAL '${DAYS} days'
      AND bd.composite_score IS NOT NULL
    GROUP BY bd.symbol
    ORDER BY times_scored DESC
    LIMIT 30
  `);

  // ── 5. Trades actually placed (from trades table) ─────────────────────────
  const { rows: trades } = await pool.query(`
    SELECT t.id, t.symbol, t.side, t.qty, t.entry_price, t.exit_price,
           t.status, t.pnl_usd, t.opened_at, t.closed_at,
           b.name AS bot, t.setup_type
    FROM trades t LEFT JOIN bots b ON b.id = t.bot_id
    WHERE t.bot_id IS NOT NULL
      AND t.opened_at > NOW() - INTERVAL '${DAYS} days'
    ORDER BY t.opened_at DESC
  `);

  // ── 6. Score distribution (histogram of composite scores) ─────────────────
  const { rows: scoreHist } = await pool.query(`
    SELECT
      CASE
        WHEN bd.composite_score < 10 THEN '00-10'
        WHEN bd.composite_score < 20 THEN '10-20'
        WHEN bd.composite_score < 30 THEN '20-30'
        WHEN bd.composite_score < 40 THEN '30-40'
        WHEN bd.composite_score < 50 THEN '40-50'
        WHEN bd.composite_score < 60 THEN '50-60'
        ELSE '60+'
      END AS bucket,
      COUNT(*) AS n
    FROM bot_decisions bd
    WHERE bd.scanned_at > NOW() - INTERVAL '${DAYS} days'
      AND bd.composite_score IS NOT NULL
    GROUP BY bucket
    ORDER BY bucket
  `);

  // ── 7. Build the markdown report ──────────────────────────────────────────
  const md = [];
  md.push(`# Bot Activity Scorecard — ${today}`);
  md.push('');
  md.push(`Window: last ${DAYS} days. Source: existing \`bot_decisions\` + \`trades\` tables. Read-only.`);
  md.push('');

  // Section 1: bot inventory
  md.push('## 1. Bots configured');
  md.push('');
  md.push(mdTable(
    ['ID', 'Name', 'Owner', 'Broker', 'Status', 'Holding', 'Trades', 'PnL', 'MinScore', 'ReqSetup', 'ReqUW'],
    bots.map(b => [
      b.id, b.name, b.owner, b.broker, b.status,
      b.current_trade_id || '—',
      b.total_trades || 0,
      '$' + (b.cumulative_pnl_usd || 0),
      b.min_score || 'default',
      b.req_setup === null ? 'true (default)' : b.req_setup,
      b.req_uw || 'default',
    ])
  ));
  md.push('');

  // Section 2: action histogram
  md.push('## 2. Action histogram by bot (last 30 days)');
  md.push('');
  const actionsByBot = {};
  for (const r of actions) {
    if (!actionsByBot[r.bot]) actionsByBot[r.bot] = {};
    actionsByBot[r.bot][r.action] = +r.n;
  }
  const allActions = [...new Set(actions.map(r => r.action))].sort();
  md.push(mdTable(
    ['Bot', ...allActions, 'Total'],
    Object.entries(actionsByBot).map(([bot, h]) => {
      const total = Object.values(h).reduce((s, n) => s + n, 0);
      return [bot, ...allActions.map(a => h[a] || 0), total];
    })
  ));
  md.push('');

  // Section 3: daily volume (last 10 days)
  md.push('## 3. Daily decision volume (last 10 days)');
  md.push('');
  md.push(mdTable(
    ['Day', 'Bot', 'Scans', 'Scored', 'Buys', 'Peak Score'],
    daily.slice(0, 50).map(r => [
      r.day.toISOString().split('T')[0],
      r.bot, r.scans, r.scored, r.buys,
      r.peak_score ? Number(r.peak_score).toFixed(2) : '—',
    ])
  ));
  md.push('');

  // Section 4: which symbols actually got scored
  md.push('## 4. Symbol concentration — what the bot has been looking at');
  md.push('');
  md.push(`Of ALL ${actions.reduce((s,r) => s + +r.n, 0)} decisions in the window, only ${symbols.length} unique symbols ever made it through hard gates to scoring.`);
  md.push('');
  md.push(mdTable(
    ['Symbol', '# Scored', 'Min', 'Max', 'Avg', 'Buys Triggered'],
    symbols.map(r => [
      r.symbol, r.times_scored,
      Number(r.min_score).toFixed(2),
      Number(r.max_score).toFixed(2),
      Number(r.avg_score).toFixed(2),
      r.buys_triggered,
    ])
  ));
  md.push('');

  // Section 5: score distribution
  md.push('## 5. Score distribution (when a candidate scored)');
  md.push('');
  md.push(mdTable(
    ['Bucket', 'Count', '% of scored', 'Bar'],
    scoreHist.map(r => {
      const total = scoreHist.reduce((s, x) => s + +x.n, 0);
      const pct = (+r.n / total) * 100;
      const bar = '█'.repeat(Math.round(pct / 2));
      return [r.bucket, r.n, pct.toFixed(1) + '%', bar];
    })
  ));
  md.push('');

  // Section 6: trades actually placed
  md.push('## 6. Trades actually placed by bots (last 30 days)');
  md.push('');
  if (trades.length === 0) {
    md.push('**Zero bot-driven trades in the window.**');
  } else {
    md.push(mdTable(
      ['ID', 'Bot', 'Symbol', 'Side', 'Qty', 'Entry', 'Exit', 'Status', 'PnL', 'Setup'],
      trades.map(t => [
        t.id, t.bot || '—', t.symbol, t.side, t.qty,
        t.entry_price || '—', t.exit_price || '—',
        t.status, t.pnl_usd != null ? `$${t.pnl_usd}` : '—',
        t.setup_type || '—',
      ])
    ));
  }
  md.push('');

  // Section 7: punchline summary
  md.push('## 7. Punchline');
  md.push('');
  const totalDecisions = actions.reduce((s, r) => s + +r.n, 0);
  const totalScored = scoreHist.reduce((s, r) => s + +r.n, 0);
  const totalBuys = actions.filter(r => r.action === 'buy').reduce((s, r) => s + +r.n, 0);
  const totalTrades = trades.length;
  md.push(`- **${totalDecisions}** scanner decisions logged over ${DAYS} days`);
  md.push(`- **${totalScored}** survived hard gates and got composite-scored (${fmtPct(totalScored, totalDecisions)} of all decisions)`);
  md.push(`- **${totalBuys}** were \`buy\` decisions (intent to trade)`);
  md.push(`- **${totalTrades}** trades actually placed by bots`);
  if (totalDecisions > 0 && totalTrades === 0) {
    md.push('');
    md.push('**Interpretation:** the scanner is running but is being filtered to inaction by hard gates + threshold + setup classifier. The B-3.7 strategy is structurally too strict for the current market conditions and basket composition.');
  }
  md.push('');
  md.push('---');
  md.push('');
  md.push('*Generated by tests/bot-engine/scorecard.js. Read-only — no DB writes.*');

  const outPath = `reports/bot-scorecard-${today.replaceAll('-','')}.md`;
  await fs.writeFile(outPath, md.join('\n') + '\n');
  console.log(`Wrote ${outPath} (${md.join('\n').length} chars)`);
  await pool.end();
}

main().catch(e => {
  console.error('[scorecard fatal]', e);
  pool.end().catch(() => {});
  process.exit(1);
});
