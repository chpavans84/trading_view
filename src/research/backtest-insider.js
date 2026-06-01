/**
 * backtest-insider.js — Phase 4.1 Pre-rally signal backtest
 *
 * Tests whether insider BUYING is a leading indicator of price rallies.
 * Measures forward returns 5d and 10d after an insider purchase signal.
 *
 * Signal: SEC Form 4 purchase events (type 'P') from uw_insider_trades
 * Entry:  Next trading day's close after signal_date
 * Exit:   5th and 10th trading day after entry
 *
 * Usage:
 *   node src/research/backtest-insider.js
 *   node src/research/backtest-insider.js --from=2024-01-01
 *   node src/research/backtest-insider.js --role=Director --min-value=50000
 *   node src/research/backtest-insider.js --types=P,M
 */

import pg from 'pg';
import 'dotenv/config';

const DB_URL = process.env.DATABASE_URL;

// Parse CLI args
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => a.slice(2).split('='))
);

const FROM_DATE  = args.from     || '2024-01-01';
const TO_DATE    = args.to       || '2026-04-30';
const MIN_VALUE  = parseFloat(args['min-value'] || '0');
const ROLE_FILT  = args.role     || null;   // 'Director' | 'Officer' | 'Director/Officer'
const TX_TYPES   = (args.types   || 'P').split(','); // P=purchase, M=option exercise

const pool = new pg.Pool({ connectionString: DB_URL });

function fmt(n, digits = 2) {
  if (n == null) return 'N/A';
  const s = n.toFixed(digits);
  return n >= 0 ? `+${s}%` : `${s}%`;
}

function fmtN(n) {
  return n?.toLocaleString() ?? 'N/A';
}

function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length))
  );
  const sep = widths.map(w => '─'.repeat(w + 2)).join('┼');
  const fmt = row => row.map((v, i) => String(v ?? '').padEnd(widths[i])).join(' │ ');

  console.log('┌' + sep.replace(/┼/g, '─┬─').replace(/─/g, '─') + '┐');
  console.log('│ ' + fmt(headers) + ' │');
  console.log('├' + sep.replace(/┼/g, '─┼─') + '┤');
  rows.forEach(r => console.log('│ ' + fmt(r) + ' │'));
  console.log('└' + sep.replace(/┼/g, '─┴─').replace(/─/g, '─') + '┘');
}

async function run() {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║     Phase 4.1 — Insider Pre-Rally Signal Backtest       ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  Period    : ${FROM_DATE} → ${TO_DATE}            ║`);
  console.log(`║  Tx types  : ${String(TX_TYPES.join(',')).padEnd(45)}║`);
  console.log(`║  Min value : $${String(MIN_VALUE.toLocaleString()).padEnd(44)}║`);
  console.log(`║  Role filt : ${String(ROLE_FILT ?? 'all').padEnd(45)}║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);

  // ─── Step 0: data inventory ───────────────────────────────────────────────
  const inv = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE transaction_type = 'P') as purchases,
      COUNT(*) FILTER (WHERE transaction_type = 'S') as sales,
      COUNT(*) FILTER (WHERE transaction_type = 'F') as withholding,
      COUNT(*) FILTER (WHERE transaction_type = 'A') as awards,
      COUNT(*) FILTER (WHERE transaction_type = 'M') as exercises,
      COUNT(*) as total,
      MIN(filed_at)::date as earliest,
      MAX(filed_at)::date as latest,
      COUNT(*) FILTER (WHERE role IS NOT NULL) as with_role,
      COUNT(*) FILTER (WHERE value IS NOT NULL) as with_value
    FROM uw_insider_trades
    WHERE filed_at >= $1 AND filed_at < $2
  `, [FROM_DATE, TO_DATE]);
  const d = inv.rows[0];
  console.log(`Data inventory (${FROM_DATE} → ${TO_DATE}):`);
  console.log(`  Total rows   : ${fmtN(+d.total)}`);
  console.log(`  Purchases P  : ${fmtN(+d.purchases)}  ← primary signal`);
  console.log(`  Exercises M  : ${fmtN(+d.exercises)}`);
  console.log(`  Sales S      : ${fmtN(+d.sales)}`);
  console.log(`  Awards A     : ${fmtN(+d.awards)}`);
  console.log(`  Withholding F: ${fmtN(+d.withholding)}`);
  console.log(`  With role    : ${fmtN(+d.with_role)}`);
  console.log(`  With $ value : ${fmtN(+d.with_value)}`);
  console.log(`  Date range   : ${d.earliest} → ${d.latest}`);
  console.log();

  if (+d.purchases < 10) {
    console.error('ERROR: Fewer than 10 purchase events found. Run backfill-insider.js first.');
    process.exit(1);
  }

  // ─── Step 1: Build signal results using direct index-friendly joins ──────────
  // Uses LATERAL with ORDER BY LIMIT directly against backtest_prices (indexed on symbol, price_date)
  // Much faster than the ROW_NUMBER CTE approach — doesn't require materializing 1.1M-row CTE

  const txPlaceholders = TX_TYPES.map((_, i) => `$${i + 3}`).join(',');
  const roleCond = ROLE_FILT ? `AND uit.role LIKE $${TX_TYPES.length + 3}` : '';
  const roleParam = ROLE_FILT ? [`%${ROLE_FILT}%`] : [];

  const mainQuery = `
    WITH signals AS (
      SELECT
        uit.ticker,
        uit.filed_at::date                          AS signal_date,
        COALESCE(uit.role, 'Unknown')               AS role,
        uit.transaction_type,
        COALESCE(uit.value, 0)                      AS value,
        CASE
          WHEN uit.value >= 1000000 THEN '$1M+'
          WHEN uit.value >= 100000  THEN '$100K-1M'
          WHEN uit.value >= 10000   THEN '$10K-100K'
          WHEN uit.value >= 0       THEN '<$10K'
          ELSE 'Unknown'
        END                                         AS value_bucket
      FROM uw_insider_trades uit
      WHERE uit.filed_at::date >= $1
        AND uit.filed_at::date <= $2
        AND uit.transaction_type IN (${txPlaceholders})
        AND uit.value >= ${MIN_VALUE}
        ${roleCond}
    ),
    -- Entry: next trading day at or after signal date (uses idx_bt_prices_sym_date)
    entry AS (
      SELECT s.*,
             td0.close        AS entry_price,
             td0.price_date   AS entry_date
      FROM signals s
      JOIN LATERAL (
        SELECT close, price_date
        FROM backtest_prices
        WHERE symbol = s.ticker
          AND price_date >= s.signal_date
        ORDER BY price_date
        LIMIT 1
      ) td0 ON TRUE
    )
    -- T+5: 5th trading day after entry, T+10: 10th trading day after entry
    -- OFFSET 4 = skip 4, take 1 → that's the 5th future trading day
    SELECT e.*,
      p5.close  AS price_t5,
      p10.close AS price_t10,
      CASE WHEN p5.close  IS NOT NULL AND e.entry_price > 0
           THEN (p5.close  - e.entry_price) / e.entry_price * 100 END AS ret_5d,
      CASE WHEN p10.close IS NOT NULL AND e.entry_price > 0
           THEN (p10.close - e.entry_price) / e.entry_price * 100 END AS ret_10d
    FROM entry e
    LEFT JOIN LATERAL (
      SELECT close FROM backtest_prices
      WHERE symbol = e.ticker AND price_date > e.entry_date
      ORDER BY price_date LIMIT 1 OFFSET 4
    ) p5  ON TRUE
    LEFT JOIN LATERAL (
      SELECT close FROM backtest_prices
      WHERE symbol = e.ticker AND price_date > e.entry_date
      ORDER BY price_date LIMIT 1 OFFSET 9
    ) p10 ON TRUE
    WHERE e.entry_price IS NOT NULL AND e.entry_price > 0
  `;

  const params = [FROM_DATE, TO_DATE, ...TX_TYPES, ...roleParam];
  const { rows } = await pool.query(mainQuery, params);

  console.log(`\nMatched ${rows.length} insider buy events with price data\n`);

  if (rows.length < 10) {
    console.error('Too few matches — check ticker coverage in backtest_prices');
    await pool.end();
    return;
  }

  // ─── Step 2: Aggregate — overall baseline ─────────────────────────────────
  const withRet5  = rows.filter(r => r.ret_5d  != null);
  const withRet10 = rows.filter(r => r.ret_10d != null);

  const avg    = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const winRate = (arr, field) => {
    const valid = arr.filter(r => r[field] != null);
    return valid.length ? valid.filter(r => r[field] > 0).length / valid.length * 100 : null;
  };

  const overall5d  = avg(withRet5.map(r => +r.ret_5d));
  const overall10d = avg(withRet10.map(r => +r.ret_10d));
  const wr5  = winRate(rows, 'ret_5d');
  const wr10 = winRate(rows, 'ret_10d');

  console.log('══════════════════════════════════════════════');
  console.log('  OVERALL — all insider purchases');
  console.log('══════════════════════════════════════════════');
  console.log(`  N (with 5d price)  : ${withRet5.length}`);
  console.log(`  Avg return 5d      : ${fmt(overall5d)}`);
  console.log(`  Avg return 10d     : ${fmt(overall10d)}`);
  console.log(`  Win rate 5d        : ${wr5?.toFixed(1)}%`);
  console.log(`  Win rate 10d       : ${wr10?.toFixed(1)}%`);
  console.log();

  // ─── Step 3: Breakdowns ───────────────────────────────────────────────────

  // By role
  const roleGroups = {};
  for (const r of withRet5) {
    const k = r.role;
    if (!roleGroups[k]) roleGroups[k] = [];
    roleGroups[k].push(r);
  }

  console.log('── By Insider Role (5d forward return) ───────────────────');
  const roleRows = Object.entries(roleGroups)
    .sort((a, b) => avg(b[1].map(r => +r.ret_5d)) - avg(a[1].map(r => +r.ret_5d)))
    .map(([role, rs]) => [
      role,
      rs.length,
      fmt(avg(rs.map(r => +r.ret_5d))),
      (rs.filter(r => +r.ret_5d > 0).length / rs.length * 100).toFixed(1) + '%',
    ]);
  table(['Role', 'N', 'Avg 5d Return', 'Win Rate'], roleRows);
  console.log();

  // By $ value bucket
  const bucketGroups = {};
  for (const r of withRet5) {
    const k = r.value_bucket;
    if (!bucketGroups[k]) bucketGroups[k] = [];
    bucketGroups[k].push(r);
  }

  const bucketOrder = ['$1M+', '$100K-1M', '$10K-100K', '<$10K', 'Unknown'];
  console.log('── By Buy Size (5d forward return) ───────────────────────');
  const bucketRows = bucketOrder
    .filter(k => bucketGroups[k])
    .map(k => {
      const rs = bucketGroups[k];
      return [
        k,
        rs.length,
        fmt(avg(rs.map(r => +r.ret_5d))),
        fmt(avg(rs.map(r => +r.ret_10d).filter(v => v != null))),
        (rs.filter(r => +r.ret_5d > 0).length / rs.length * 100).toFixed(1) + '%',
      ];
    });
  table(['Buy Size', 'N', 'Avg 5d', 'Avg 10d', 'Win Rate 5d'], bucketRows);
  console.log();

  // By year
  const toDateStr = (d) => {
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
  };
  const yearGroups = {};
  for (const r of withRet5) {
    const k = toDateStr(r.signal_date).slice(0, 4);
    if (!yearGroups[k]) yearGroups[k] = [];
    yearGroups[k].push(r);
  }

  console.log('── By Year (controls for market regime) ─────────────────');
  const yearRows = Object.entries(yearGroups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([yr, rs]) => [
      yr,
      rs.length,
      fmt(avg(rs.map(r => +r.ret_5d))),
      fmt(avg(rs.map(r => +r.ret_10d).filter(v => v != null))),
      (rs.filter(r => +r.ret_5d > 0).length / rs.length * 100).toFixed(1) + '%',
    ]);
  table(['Year', 'N', 'Avg 5d', 'Avg 10d', 'Win Rate 5d'], yearRows);
  console.log();

  // By role × value (director + $1M+) — the highest conviction signal
  console.log('── High-Conviction Subset: Director buying ≥$100K ──────');
  const hc = withRet5.filter(r =>
    r.role?.includes('Director') && +r.value >= 100_000
  );
  if (hc.length >= 5) {
    console.log(`  N: ${hc.length}`);
    console.log(`  Avg 5d : ${fmt(avg(hc.map(r => +r.ret_5d)))}`);
    console.log(`  Avg 10d: ${fmt(avg(hc.filter(r => r.ret_10d).map(r => +r.ret_10d)))}`);
    console.log(`  Win %  : ${(hc.filter(r => +r.ret_5d > 0).length / hc.length * 100).toFixed(1)}%`);
  } else {
    console.log(`  Insufficient data (${hc.length} events)`);
  }
  console.log();

  // Compare vs SPY over same periods as baseline
  console.log('── SPY Baseline (same dates) ────────────────────────────');
  const dates = [...new Set(withRet5.map(r => r.signal_date.toISOString?.()?.slice(0,10) ?? String(r.signal_date)))];
  const spyBase = await pool.query(`
    WITH td AS (
      SELECT price_date, close,
             ROW_NUMBER() OVER (ORDER BY price_date) rn
      FROM backtest_prices WHERE symbol = 'SPY'
    )
    SELECT
      AVG((t5.close - t0.close) / t0.close * 100) as avg_5d,
      AVG((t10.close - t0.close) / t0.close * 100) as avg_10d,
      100.0 * SUM(CASE WHEN t5.close > t0.close THEN 1 ELSE 0 END)::float / COUNT(*) as wr
    FROM td t0
    JOIN td t5  ON t5.rn = t0.rn + 5
    JOIN td t10 ON t10.rn = t0.rn + 10
    WHERE t0.price_date >= $1 AND t0.price_date <= $2
  `, [FROM_DATE, TO_DATE]);
  const spy = spyBase.rows[0];
  console.log(`  SPY avg 5d  : ${fmt(+spy.avg_5d)}`);
  console.log(`  SPY avg 10d : ${fmt(+spy.avg_10d)}`);
  console.log(`  SPY win %   : ${(+spy.wr).toFixed(1)}%`);
  console.log();

  console.log('── Signal vs SPY Edge ───────────────────────────────────');
  console.log(`  5d edge  : ${fmt(overall5d - +spy.avg_5d)}  (insider vs market)`);
  console.log(`  10d edge : ${fmt(overall10d - +spy.avg_10d)}`);
  console.log();

  // Top 10 best performers
  console.log('── Top 10 Individual Events (by 5d return) ──────────────');
  const top10 = [...rows]
    .filter(r => r.ret_5d != null)
    .sort((a, b) => +b.ret_5d - +a.ret_5d)
    .slice(0, 10);
  const t10rows = top10.map(r => [
    r.ticker,
    toDateStr(r.signal_date),
    r.role ?? 'Unknown',
    `$${Math.round(+r.value / 1000)}K`,
    fmt(+r.ret_5d),
    fmt(+r.ret_10d),
  ]);
  table(['Ticker', 'Date', 'Role', 'Value', '5d Ret', '10d Ret'], t10rows);
  console.log();

  await pool.end();
}

run().catch(e => {
  console.error('Fatal:', e);
  pool.end().catch(() => {});
  process.exit(1);
});
