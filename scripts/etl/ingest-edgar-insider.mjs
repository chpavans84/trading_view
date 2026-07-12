#!/usr/bin/env node
/**
 * scripts/etl/ingest-edgar-insider.mjs
 *
 * FREE SEC EDGAR Form-4 insider feed — a parallel source to validate against UW before
 * cancelling the paid UW subscription (~$1,800/yr). Insider trades are public SEC filings,
 * so EDGAR has the exact same data as UW (which just resells it).
 *
 * Pipeline: EDGAR full-text search (efts.sec.gov) lists Form-4 filings in a date window →
 * fetch each ownershipDocument XML → parse issuer ticker, reporting-owner role, and each
 * non-derivative transaction (code P/S/..., shares, price, dates) → store in
 * edgar_insider_trades (parallel to uw_insider_trades).
 *
 * SEC rules: User-Agent with contact REQUIRED; ≤10 requests/sec. We pace ~7/s.
 *
 * Run: node --env-file=.env scripts/etl/ingest-edgar-insider.mjs [--days 10] [--limit N]
 */
import pg from 'pg';

const UA = 'DLP-Research (pavan) chpavans84@gmail.com';   // SEC requires a UA with contact
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function arg(n, d) { const i = process.argv.indexOf('--' + n); if (i < 0) return d; const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
const DAYS = Number(arg('days', 10));
const LIMIT = arg('limit') ? Number(arg('limit')) : null;

const H = { 'User-Agent': UA, 'Accept-Encoding': 'gzip' };
async function getJson(url) { const r = await fetch(url, { headers: H }); return r.ok ? r.json() : null; }
// Retry on 429/5xx with backoff — SEC throttles sustained bursts even under 10/s.
async function getText(url, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: H });
      if (r.ok) return r.text();
      if (r.status === 429 || r.status >= 500) { await sleep(1200 * (t + 1)); continue; }
      return null;   // 404/403 → give up (won't fix on retry)
    } catch { await sleep(600 * (t + 1)); }
  }
  return null;
}
const ymd = (d) => d.toISOString().slice(0, 10);
const m1 = (s, re) => { const x = s.match(re); return x ? x[1].trim() : null; };
const num = (x) => { const n = Number(x); return isNaN(n) ? null : n; };

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const to = new Date(), from = new Date(Date.now() - DAYS * 86400e3);

  await pool.query(`CREATE TABLE IF NOT EXISTS edgar_insider_trades (
    accession text, ticker text, owner_name text, role text,
    is_director bool, is_officer bool, is_ten_pct bool, officer_title text,
    transaction_type text, shares numeric, price numeric, value numeric,
    transaction_date date, filed_at date, source text DEFAULT 'edgar', ingested_at timestamptz DEFAULT now(),
    PRIMARY KEY (accession, ticker, transaction_type, transaction_date, shares))`);

  // 1. Collect Form-4 filings for the window (efts paginated, 100/page, 10k cap)
  let hits = [], fromIdx = 0;
  while (true) {
    const url = `https://efts.sec.gov/LATEST/search-index?forms=4&startdt=${ymd(from)}&enddt=${ymd(to)}&from=${fromIdx}`;
    const j = await getJson(url); const hh = j?.hits?.hits || [];
    hits.push(...hh);
    if (hh.length < 100 || (LIMIT && hits.length >= LIMIT) || fromIdx >= 9900) break;
    fromIdx += 100; await sleep(150);
  }
  if (LIMIT) hits = hits.slice(0, LIMIT);
  console.log(`[edgar] ${hits.length} Form-4 filings ${ymd(from)}..${ymd(to)}`);

  // 2. Fetch + parse each filing
  let saved = 0, purchases = 0, errs = 0;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]; const [adsh, file] = h._id.split(':');
    const cik = String(Number(adsh.slice(0, 10))), accNo = adsh.replace(/-/g, '');
    const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNo}/${file}`;
    let xml = null;
    try { xml = await getText(url); } catch { /* net */ }
    if (!xml) { errs++; await sleep(120); continue; }
    const ticker = m1(xml, /<issuerTradingSymbol>([^<]+)/);
    if (!ticker || ticker.toUpperCase() === 'NONE') { await sleep(120); continue; }
    const owner = m1(xml, /<rptOwnerName>([^<]+)/);
    const isDir = /<isDirector>\s*(?:<value>)?\s*(1|true)/i.test(xml);
    const isOff = /<isOfficer>\s*(?:<value>)?\s*(1|true)/i.test(xml);
    const isTen = /<isTenPercentOwner>\s*(?:<value>)?\s*(1|true)/i.test(xml);
    const title = m1(xml, /<officerTitle>([^<]*)/);
    const role = [isDir && 'Director', isTen && '10% Owner', isOff && (title || 'Officer')].filter(Boolean).join(', ');
    const filed = h._source?.file_date || null;

    for (const b of xml.split('<nonDerivativeTransaction>').slice(1)) {
      const code = m1(b, /<transactionCode>\s*(?:<value>)?\s*([A-Z])/);
      if (!code) continue;
      const shares = num(m1(b, /<transactionShares>[\s\S]*?<value>([\d.]+)/));
      const price = num(m1(b, /<transactionPricePerShare>[\s\S]*?<value>([\d.]+)/));
      const tdate = m1(b, /<transactionDate>[\s\S]*?<value>([\d-]+)/);
      if (!shares || !tdate) continue;
      const value = (price || 0) * shares;
      try {
        await pool.query(
          `INSERT INTO edgar_insider_trades(accession,ticker,owner_name,role,is_director,is_officer,is_ten_pct,officer_title,transaction_type,shares,price,value,transaction_date,filed_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
          [adsh, ticker.toUpperCase(), owner, role, isDir, isOff, isTen, title, code, shares, price, value, tdate, filed]);
        saved++; if (code === 'P') purchases++;
      } catch { /* dup / bad row */ }
    }
    if (i % 200 === 0) console.log(`[edgar] ${i}/${hits.length} — ${saved} tx (${purchases} P), ${errs} err`);
    await sleep(160);   // ~6 req/s (SEC limit 10/s; stay conservative to avoid throttling)
  }
  console.log(`[edgar] DONE — ${saved} transactions, ${purchases} purchases, ${errs} fetch errors`);
  await pool.end();
}
main().catch(e => { console.error('[edgar] FATAL', e); process.exit(1); });
