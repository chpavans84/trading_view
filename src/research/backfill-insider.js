/**
 * backfill-insider.js — One-time backfill of UW historical insider trades
 *
 * Iterates day by day from START_DATE to END_DATE, fetching /api/insider/transactions
 * for each date and upserting into uw_insider_trades.
 *
 * Usage:
 *   node src/research/backfill-insider.js
 *   node src/research/backfill-insider.js --from=2024-01-01 --to=2025-12-31
 *   node src/research/backfill-insider.js --dry-run
 *
 * Rate limit: conservatively 80 req/min (limit is 120, leave headroom for live crons)
 * Estimated runtime: ~851 days / 80 req/min ≈ 10-11 minutes
 */

import pg from 'pg';
import 'dotenv/config';

// ─── Config ───────────────────────────────────────────────────────────────────

const UW_API_KEY = process.env.UW_API_KEY;
const DB_URL     = process.env.DATABASE_URL;
const BASE       = 'https://api.unusualwhales.com/api';

// Parse CLI args
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => a.slice(2).split('='))
);

const FROM_DATE = args.from  || '2024-01-01';
const TO_DATE   = args.to    || '2026-04-30';  // stop before our existing May 2026 data
const DRY_RUN   = 'dry-run' in args;
const LIMIT     = 500;
const REQ_PER_MIN = 80;
const DELAY_MS  = Math.ceil(60_000 / REQ_PER_MIN);  // ~750ms between requests

if (!UW_API_KEY) {
  console.error('ERROR: UW_API_KEY not set in .env');
  process.exit(1);
}
if (!DB_URL) {
  console.error('ERROR: DATABASE_URL not set in .env');
  process.exit(1);
}

// ─── DB ───────────────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: DB_URL });

async function upsertTrade(t) {
  const insiderName    = t.owner_name ?? '';
  const txType         = t.transaction_code ?? (t.amount < 0 ? 'S' : 'P');  // S=sale, P=purchase
  const filedAt        = t.transaction_date
    ? new Date(t.transaction_date)
    : new Date('1900-01-01');
  const sharesRaw      = t.amount ?? null;                      // positive=buy, negative=sell
  const sharesAbs      = sharesRaw != null ? Math.abs(sharesRaw) : null;
  const priceNum       = t.price != null ? parseFloat(t.price) : null;
  const valueDollars   = sharesAbs != null && priceNum != null
    ? Math.round(sharesAbs * priceNum * 100) / 100
    : null;

  // Derive role from is_director / is_officer
  const parts = [];
  if (t.is_director)          parts.push('Director');
  if (t.is_officer)           parts.push('Officer');
  if (t.is_ten_percent_owner) parts.push('10% Owner');
  const role = parts.length ? parts.join('/') : null;

  if (DRY_RUN) return { action: 'dry_run', ticker: t.ticker };

  const { rowCount } = await pool.query(
    `INSERT INTO uw_insider_trades
       (ticker, insider_name, role, transaction_type, shares, price, value, filed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (ticker,
                  COALESCE(insider_name,''),
                  COALESCE(filed_at,'1900-01-01'::timestamptz),
                  COALESCE(transaction_type,''))
     DO NOTHING`,
    [
      t.ticker,
      insiderName,
      role,
      txType,
      sharesAbs,
      priceNum,
      valueDollars,
      filedAt,
    ]
  );
  return { action: rowCount > 0 ? 'inserted' : 'skipped' };
}

// ─── UW Fetch ─────────────────────────────────────────────────────────────────

async function fetchDay(dateStr) {
  const url = `${BASE}/insider/transactions?start_date=${dateStr}&end_date=${dateStr}&limit=${LIMIT}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${UW_API_KEY}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  return json.data || [];
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function dateRange(from, to) {
  const days = [];
  const cur  = new Date(from + 'T00:00:00Z');
  const end  = new Date(to   + 'T00:00:00Z');
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const days = dateRange(FROM_DATE, TO_DATE);
  console.log(`\n╔════════════════════════════════════════════════════╗`);
  console.log(`║  UW Insider Backfill — ${FROM_DATE} → ${TO_DATE}  ║`);
  console.log(`╠════════════════════════════════════════════════════╣`);
  console.log(`║  Days to fetch : ${String(days.length).padEnd(32)}║`);
  console.log(`║  Rate limit    : ${String(REQ_PER_MIN + ' req/min').padEnd(32)}║`);
  console.log(`║  Est. duration : ${String(Math.ceil(days.length / REQ_PER_MIN) + ' minutes').padEnd(32)}║`);
  console.log(`║  Dry run       : ${String(DRY_RUN).padEnd(32)}║`);
  console.log(`╚════════════════════════════════════════════════════╝\n`);

  if (DRY_RUN) {
    console.log('DRY RUN — fetching but not writing to DB\n');
  }

  let totalFetched  = 0;
  let totalInserted = 0;
  let totalSkipped  = 0;
  let totalErrors   = 0;
  let emptyDays     = 0;

  const startTime = Date.now();

  for (let i = 0; i < days.length; i++) {
    const dateStr = days[i];
    const pct     = Math.round((i / days.length) * 100);

    try {
      const trades = await fetchDay(dateStr);

      if (trades.length === 0) {
        emptyDays++;
        // Print empty days every 10 to avoid noise
        if (emptyDays % 10 === 0) {
          process.stdout.write(`  ${dateStr}  [empty] (${emptyDays} empty so far)\r`);
        }
      } else {
        let dayInserted = 0;
        let daySkipped  = 0;
        for (const t of trades) {
          try {
            const r = await upsertTrade(t);
            if (r.action === 'inserted') dayInserted++;
            else daySkipped++;
          } catch (e) {
            console.error(`    ↳ upsert error for ${t.ticker}: ${e.message}`);
          }
        }
        totalFetched  += trades.length;
        totalInserted += dayInserted;
        totalSkipped  += daySkipped;
        console.log(`  ${dateStr}  [${String(trades.length).padStart(3)} rows]  +${dayInserted} inserted  ${daySkipped} skipped   ${pct}%`);
      }
    } catch (e) {
      totalErrors++;
      console.error(`  ${dateStr}  ERROR: ${e.message}`);
    }

    // Rate limit delay between requests
    if (i < days.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n╔════════════════════════════════════════════════════╗`);
  console.log(`║  BACKFILL COMPLETE                                 ║`);
  console.log(`╠════════════════════════════════════════════════════╣`);
  console.log(`║  Days processed  : ${String(days.length).padEnd(31)}║`);
  console.log(`║  Empty days      : ${String(emptyDays).padEnd(31)}║`);
  console.log(`║  Rows fetched    : ${String(totalFetched).padEnd(31)}║`);
  console.log(`║  Rows inserted   : ${String(totalInserted).padEnd(31)}║`);
  console.log(`║  Rows skipped    : ${String(totalSkipped).padEnd(31)}║`);
  console.log(`║  Errors          : ${String(totalErrors).padEnd(31)}║`);
  console.log(`║  Time elapsed    : ${String(elapsed + 's').padEnd(31)}║`);
  console.log(`╚════════════════════════════════════════════════════╝\n`);

  await pool.end();
}

main().catch(e => {
  console.error('Fatal:', e);
  pool.end().catch(() => {});
  process.exit(1);
});
