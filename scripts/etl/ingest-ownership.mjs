/**
 * Daily ownership ingest for the screener — float + institutional holdings from Yahoo quoteSummary.
 * Upserts one snapshot per symbol per day into screener_ownership (history → "change" columns).
 *
 *   node scripts/etl/ingest-ownership.mjs                 # full active universe
 *   ONLY=AAPL,MSFT node scripts/etl/ingest-ownership.mjs # specific symbols (testing)
 *   LIMIT=50 node scripts/etl/ingest-ownership.mjs        # first N (testing)
 */
import 'dotenv/config';
import YahooFinance from 'yahoo-finance2';   // v3: default export is a class — must instantiate
import { initDb, query } from '../../src/core/db.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const ONLY  = (process.env.ONLY || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const LIMIT = Number(process.env.LIMIT) || 0;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 6;

// today's date in America/New_York
const snapDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function fetchOne(sym) {
  const r = await yahooFinance.quoteSummary(sym, {
    modules: ['defaultKeyStatistics', 'majorHoldersBreakdown', 'summaryDetail'],
  });
  const ks = r?.defaultKeyStatistics ?? {};
  const mh = r?.majorHoldersBreakdown ?? {};
  const sd = r?.summaryDetail ?? {};
  const sharesOut = ks.sharesOutstanding ?? null;
  const instPct   = ks.heldPercentInstitutions ?? mh.institutionsPercentHeld ?? null;
  // PE: summaryDetail.trailingPE is null when earnings are negative — that's correct (not a gap).
  // forwardPE: prefer summaryDetail, fall back to defaultKeyStatistics.
  return {
    symbol: sym,
    float_shares: ks.floatShares ?? null,
    shares_outstanding: sharesOut,
    inst_pct: instPct,
    inst_float_pct: mh.institutionsFloatPercentHeld ?? null,
    inst_shares: (instPct != null && sharesOut != null) ? Math.round(instPct * sharesOut) : null,
    insiders_pct: ks.heldPercentInsiders ?? mh.insidersPercentHeld ?? null,
    pe_ratio: sd.trailingPE ?? null,
    forward_pe: sd.forwardPE ?? ks.forwardPE ?? null,
  };
}

async function upsert(o) {
  await query(`
    INSERT INTO screener_ownership
      (symbol, snapshot_date, float_shares, shares_outstanding, inst_pct, inst_float_pct, inst_shares, insiders_pct, pe_ratio, forward_pe, fetched_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
    ON CONFLICT (symbol, snapshot_date) DO UPDATE SET
      float_shares=EXCLUDED.float_shares, shares_outstanding=EXCLUDED.shares_outstanding,
      inst_pct=EXCLUDED.inst_pct, inst_float_pct=EXCLUDED.inst_float_pct,
      inst_shares=EXCLUDED.inst_shares, insiders_pct=EXCLUDED.insiders_pct,
      pe_ratio=EXCLUDED.pe_ratio, forward_pe=EXCLUDED.forward_pe, fetched_at=now()`,
    [o.symbol, snapDate, o.float_shares, o.shares_outstanding, o.inst_pct, o.inst_float_pct, o.inst_shares, o.insiders_pct, o.pe_ratio, o.forward_pe]);
}

async function main() {
  await initDb();
  let symbols = ONLY;
  if (!symbols.length) {
    const { rows } = await query(
      `SELECT symbol FROM tradable_universe WHERE last_price IS NOT NULL ORDER BY adv_dollar_30d DESC NULLS LAST` +
      (LIMIT ? ` LIMIT ${LIMIT}` : ''));
    symbols = rows.map(r => r.symbol);
  }
  console.log(`[ownership] ${symbols.length} symbols, snapshot ${snapDate}, concurrency ${CONCURRENCY}`);

  let ok = 0, fail = 0;
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    const res = await Promise.allSettled(batch.map(fetchOne));
    for (const r of res) {
      if (r.status === 'fulfilled') { try { await upsert(r.value); ok++; } catch (e) { fail++; } }
      else fail++;
    }
    if ((i / CONCURRENCY) % 25 === 0) console.log(`  ${i + batch.length}/${symbols.length}  ok=${ok} fail=${fail}`);
  }
  console.log(`[ownership] DONE ok=${ok} fail=${fail} snapshot=${snapDate}`);
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
