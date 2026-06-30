/**
 * scripts/etl/ingest-index-membership.mjs
 * Build/refresh `index_membership` (symbol, in_sp500, in_ndx100) — the constituent lists the
 * 📊 Ownership screener is restricted to. Sources (free, no API key):
 *   - S&P 500:   datasets/s-and-p-500-companies constituents.csv (503 names, GICS-sourced)
 *   - NASDAQ-100: Wikipedia "Nasdaq-100" constituents table (~101 names)
 * Tickers normalized to the tradable_universe convention (BRK.B → BRK-B).
 * Re-run anytime (e.g. monthly) to pick up index reconstitutions. Idempotent full replace.
 */
import 'dotenv/config';
import { query, initDb } from '../../src/core/db.js';

const SP500_CSV = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const NDX_WIKI  = 'https://en.wikipedia.org/wiki/Nasdaq-100';

const norm = t => t.trim().toUpperCase().replace(/-/g, '.');    // class shares use dots here (BRK.B, BF.B)

async function fetchSP500() {
  const r = await fetch(SP500_CSV);
  if (!r.ok) throw new Error(`S&P500 CSV HTTP ${r.status}`);
  const csv = await r.text();
  const out = new Set();
  for (const line of csv.split('\n').slice(1)) {
    const sym = line.split(',')[0];
    if (/^[A-Z.\-]{1,6}$/.test(sym)) out.add(norm(sym));
  }
  return out;
}

async function fetchNDX() {
  const r = await fetch(NDX_WIKI, { headers: { 'User-Agent': 'Mozilla/5.0 (screener-membership-bot)' } });
  if (!r.ok) throw new Error(`NDX wiki HTTP ${r.status}`);
  const html = await r.text();
  // Scope to the constituents table, then take the bare-ticker <td> cells (first cell per row).
  const start = html.indexOf('id="constituents"');
  const region = start >= 0 ? html.slice(start, html.indexOf('</table>', start)) : html;
  const out = new Set();
  for (const m of region.matchAll(/<td>([A-Z][A-Z.\-]{0,5})<\/td>/g)) out.add(norm(m[1]));
  return out;
}

async function main() {
  await initDb();
  const [sp, ndx] = await Promise.all([fetchSP500(), fetchNDX()]);
  console.log(`[index-membership] S&P500=${sp.size}  NASDAQ100=${ndx.size}  union=${new Set([...sp, ...ndx]).size}`);
  if (sp.size < 480 || ndx.size < 90) throw new Error(`refusing to write — counts look wrong (sp=${sp.size}, ndx=${ndx.size})`);

  await query(`CREATE TABLE IF NOT EXISTS index_membership (
    symbol varchar(20) PRIMARY KEY, in_sp500 boolean DEFAULT false, in_ndx100 boolean DEFAULT false, updated_at timestamptz DEFAULT now())`);
  await query(`TRUNCATE index_membership`);
  const all = new Set([...sp, ...ndx]);
  for (const s of all) {
    await query(`INSERT INTO index_membership (symbol, in_sp500, in_ndx100, updated_at) VALUES ($1,$2,$3, now())
                 ON CONFLICT (symbol) DO UPDATE SET in_sp500=EXCLUDED.in_sp500, in_ndx100=EXCLUDED.in_ndx100, updated_at=now()`,
      [s, sp.has(s), ndx.has(s)]);
  }
  console.log(`[index-membership] DONE wrote ${all.size} symbols`);
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
