// backfill-uw-gex.mjs — one-time ~1yr daily GEX (dealer greek exposure) backfill.
// UW greek-exposure endpoint returns ~250 daily rows per ticker in ONE call (cheap).
// Scoped to S&P500 + NDX100 (index_membership). Throttled to stay under UW 120/min and
// leave headroom for the live ingestion crons. Idempotent upsert into uw_gex_history.
// NOTE: research ETL — calls UW directly (acceptable for a one-off backfill; the live
// path still goes through src/core/unusual-whales.js).
import 'dotenv/config';
import pg from 'pg';

const KEY = process.env.UW_API_KEY;
const BASE = 'https://api.unusualwhales.com/api';
const H = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' };
const SPACING_MS = 600;                       // ~100/min, headroom under 120/min
const sleep = ms => new Promise(r => setTimeout(r, ms));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function fetchGex(sym, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/stock/${sym}/greek-exposure`, { headers: H, signal: AbortSignal.timeout(15000) });
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * 2 ** i); continue; }
      if (!r.ok) return { err: `HTTP ${r.status}` };
      const j = await r.json().catch(() => null);
      return { data: j?.data || [] };
    } catch (e) { if (i < tries - 1) await sleep(1000 * 2 ** i); else return { err: e.message }; }
  }
  return { err: 'retries exhausted' };
}

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uw_gex_history (
      symbol text NOT NULL, date date NOT NULL,
      call_gamma double precision, put_gamma double precision,
      call_delta double precision, put_delta double precision,
      call_charm double precision, put_charm double precision,
      call_vanna double precision, put_vanna double precision,
      net_gamma double precision, net_delta double precision,
      PRIMARY KEY (symbol, date)
    );`);

  const { rows } = await pool.query(
    `SELECT symbol FROM index_membership WHERE in_sp500 OR in_ndx100 ORDER BY symbol`);
  const syms = rows.map(r => r.symbol);
  console.log(`[gex] ${syms.length} tickers; ~${Math.round(syms.length * SPACING_MS / 60000)} min ETA`);

  let ok = 0, err = 0, totalRows = 0;
  for (let i = 0; i < syms.length; i++) {
    const sym = syms[i];
    const { data, err: e } = await fetchGex(sym);
    if (e) { err++; if (err <= 10) console.warn(`[gex] ${sym}: ${e}`); }
    else if (data.length) {
      const vals = [], ph = [];
      data.forEach((d, k) => {
        const cg = +d.call_gamma, pg_ = +d.put_gamma, cd = +d.call_delta, pd = +d.put_delta;
        const b = k * 11;
        ph.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`);
        vals.push(sym, d.date, cg, pg_, cd, pd, +d.call_charm, +d.put_charm, +d.call_vanna, +d.put_vanna, null);
      });
      // net_gamma = call_gamma + put_gamma (put already negative); net_delta = call+put
      const sql = `INSERT INTO uw_gex_history
        (symbol,date,call_gamma,put_gamma,call_delta,put_delta,call_charm,put_charm,call_vanna,put_vanna,net_gamma)
        VALUES ${ph.join(',')}
        ON CONFLICT (symbol,date) DO UPDATE SET
          call_gamma=EXCLUDED.call_gamma, put_gamma=EXCLUDED.put_gamma,
          call_delta=EXCLUDED.call_delta, put_delta=EXCLUDED.put_delta,
          call_charm=EXCLUDED.call_charm, put_charm=EXCLUDED.put_charm,
          call_vanna=EXCLUDED.call_vanna, put_vanna=EXCLUDED.put_vanna`;
      await pool.query(sql, vals);
      ok++; totalRows += data.length;
    } else err++;
    if (i % 50 === 0 || i === syms.length - 1)
      console.log(`[gex] ${i + 1}/${syms.length}  ok=${ok} err=${err} rows=${totalRows}`);
    if (i < syms.length - 1) await sleep(SPACING_MS);
  }
  // fill net columns in one pass
  await pool.query(`UPDATE uw_gex_history SET
      net_gamma = COALESCE(call_gamma,0)+COALESCE(put_gamma,0),
      net_delta = COALESCE(call_delta,0)+COALESCE(put_delta,0)`);
  console.log(`[gex] DONE ok=${ok} err=${err} totalRows=${totalRows}`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
