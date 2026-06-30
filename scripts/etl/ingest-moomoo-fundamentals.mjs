/**
 * scripts/etl/ingest-moomoo-fundamentals.mjs
 * Pull fundamental snapshots (trailing PE, EPS, PB, shares, market cap) from Moomoo OpenD
 * and upsert into `moomoo_fundamentals`. This is the PRIMARY PE source for the 📊 Ownership
 * screener (Moomoo = the user's broker, free + local). Yahoo / tradable_universe are fallbacks.
 *
 * Constraints (from the Futu protocol, verified):
 *   - OpenD must be running (127.0.0.1:11111) with US market-data permission.
 *   - Qot_GetSecuritySnapshot gives TRAILING PE (peTTMRate) only — NO forward PE in the API
 *     (the Moomoo app computes forward PE from analyst estimates separately).
 *   - Loss-making names return a negative PE → we store it + set is_loss=true (shows "Loss").
 *   - Rate-limited (~400 securities / 30s); getSnapshots() chunks 200/request.
 *
 * Usage:
 *   node scripts/etl/ingest-moomoo-fundamentals.mjs            # whole liquid universe
 *   LIMIT=3000 node scripts/etl/ingest-moomoo-fundamentals.mjs # top-3000 by ADV
 *   ONLY=INTC,AAPL node scripts/etl/ingest-moomoo-fundamentals.mjs
 */
import 'dotenv/config';
import { query, initDb } from '../../src/core/db.js';
import { getSnapshots } from '../../src/core/moomoo-tcp.js';

const ONLY  = (process.env.ONLY || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const LIMIT = Number(process.env.LIMIT) || 0;
const BATCH = Number(process.env.BATCH) || 200;

async function upsert(s) {
  const isLoss = (s.pe_ttm != null && s.pe_ttm < 0) || (s.eps != null && s.eps < 0);
  const peTtm = (s.pe_ttm != null && s.pe_ttm > 0) ? s.pe_ttm : null;     // store positive PE only
  const peStatic = (s.pe_static != null && s.pe_static > 0) ? s.pe_static : null;
  await query(`
    INSERT INTO moomoo_fundamentals (symbol, pe_ttm, pe_static, eps, pb, shares_out, market_cap, day_volume, is_loss, fetched_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
    ON CONFLICT (symbol) DO UPDATE SET
      pe_ttm=EXCLUDED.pe_ttm, pe_static=EXCLUDED.pe_static, eps=EXCLUDED.eps, pb=EXCLUDED.pb,
      shares_out=EXCLUDED.shares_out, market_cap=EXCLUDED.market_cap, day_volume=EXCLUDED.day_volume,
      is_loss=EXCLUDED.is_loss, fetched_at=now()`,
    [s.symbol, peTtm, peStatic, s.eps, s.pb, s.shares_out, s.market_cap, s.day_volume ?? null, isLoss]);
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
  console.log(`[moomoo-fund] ${symbols.length} symbols, batch ${BATCH}`);

  let ok = 0, fail = 0;
  // getSnapshots() opens ONE OpenD connection and chunks internally, but to bound memory
  // and surface partial progress we drive it in outer batches too.
  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk = symbols.slice(i, i + BATCH);
    try {
      const r = await getSnapshots(chunk);
      for (const s of (r.snapshots || [])) {
        if (!s.symbol) { continue; }
        try { await upsert(s); ok++; } catch { fail++; }
      }
    } catch (e) {
      fail += chunk.length;
      console.error(`  batch ${i} failed: ${e.message}`);
    }
    if ((i / BATCH) % 5 === 0) console.log(`  ${Math.min(i + BATCH, symbols.length)}/${symbols.length}  ok=${ok} fail=${fail}`);
  }
  console.log(`[moomoo-fund] DONE ok=${ok} fail=${fail}`);
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
