#!/usr/bin/env node
/**
 * Polygon REST API snapshot to HDD — captures the data NOT in flat-files:
 *   - All tickers reference (sector, market_cap, exchange, type) for all stocks
 *   - Ticker details per symbol (longform)
 *   - Splits history per symbol (full)
 *   - Dividends history per symbol (full)
 *   - Quarterly financials per symbol (income/BS/CF)
 *   - Reference lookups: exchanges, conditions, ticker types
 *
 * Why this matters:
 *   - Polygon S3 flat-files have PRICE data only.
 *   - Adjusted-price backtests need splits + dividends. We currently use Yahoo
 *     which is often wrong / stale. Polygon is authoritative.
 *   - If the subscription ever lapses we cannot re-pull this data.
 *
 * Design:
 *   - Rate-limited (default 5 req/sec; configurable via RPS env)
 *   - Resumable: per-endpoint checkpoint file in manifests/
 *   - Idempotent: skips symbols whose .json.gz already exists & is fresh (<7d)
 *   - Each symbol's output is one gzipped JSON per data type
 *   - Concurrent fetches via a token bucket
 *
 * Output layout:
 *   /Volumes/Archive/polygon-rest/
 *     tickers/all_tickers.json.gz            (~12k rows)
 *     tickers/details/{SYMBOL}.json.gz
 *     corporate_actions/splits/{SYMBOL}.json.gz
 *     corporate_actions/dividends/{SYMBOL}.json.gz
 *     financials/{SYMBOL}_quarterly.json.gz
 *     reference/exchanges.json.gz
 *     reference/conditions_stocks.json.gz
 *     reference/ticker_types.json.gz
 *     manifests/rest-snapshot-{TIMESTAMP}.log
 *     manifests/checkpoint.json               (which symbols completed)
 *
 * Usage:
 *   node scripts/polygon-rest-snapshot.mjs                   # full snapshot
 *   ONLY=AAPL,MSFT,NVDA node scripts/polygon-rest-snapshot.mjs
 *   RPS=3 node scripts/polygon-rest-snapshot.mjs             # slower rate
 *   PHASES=tickers,reference node scripts/polygon-rest-snapshot.mjs
 *   FRESHNESS_DAYS=30 node scripts/polygon-rest-snapshot.mjs # re-pull if older
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const KEY        = process.env.BENZINGA_API || process.env.POLYGON_API_KEY;
if (!KEY) { console.error('Missing API key (BENZINGA_API or POLYGON_API_KEY)'); process.exit(1); }
const BASE       = 'https://api.polygon.io';
const ROOT       = '/Volumes/Archive/polygon-rest';
const RPS        = Number(process.env.RPS) || 5;     // requests per second
const FRESHNESS_DAYS = Number(process.env.FRESHNESS_DAYS) || 7;
const ONLY       = (process.env.ONLY || '').split(',').filter(Boolean).map(s=>s.toUpperCase());
const PHASES     = new Set((process.env.PHASES || 'reference,tickers,details,splits,dividends,financials').split(',').map(s=>s.trim()));
const STAMP      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// Ensure directories
for (const sub of ['tickers/details','corporate_actions/splits','corporate_actions/dividends','financials','reference','manifests']) {
  fs.mkdirSync(path.join(ROOT, sub), { recursive: true });
}
const LOG_FILE = path.join(ROOT, 'manifests', `rest-snapshot-${STAMP}.log`);
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
};

// ─── Rate limiter (simple sliding window) ───────────────────────────────────
const _times = [];
async function rateLimit() {
  const now = Date.now();
  while (_times.length && _times[0] < now - 1000) _times.shift();
  if (_times.length >= RPS) {
    const wait = 1000 - (now - _times[0]) + 5;
    await new Promise(r => setTimeout(r, wait));
  }
  _times.push(Date.now());
}

// ─── HTTP helper with retry ──────────────────────────────────────────────────
async function fetchJson(url, attempt = 1) {
  await rateLimit();
  try {
    const sep = url.includes('?') ? '&' : '?';
    const r = await fetch(`${url}${sep}apiKey=${KEY}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 429) {
      const wait = 1000 * attempt;
      log(`  429 rate-limited on ${url} — waiting ${wait}ms (attempt ${attempt})`);
      await new Promise(rs => setTimeout(rs, wait));
      if (attempt < 5) return fetchJson(url, attempt + 1);
      throw new Error('429 after 5 retries');
    }
    if (r.status === 403) return { _forbidden: true, _url: url };
    if (r.status === 404) return { _notfound: true, _url: url };
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
    return await r.json();
  } catch (e) {
    if (attempt < 3) {
      log(`  retry ${attempt} for ${url}: ${e.message}`);
      await new Promise(rs => setTimeout(rs, 500 * attempt));
      return fetchJson(url, attempt + 1);
    }
    throw e;
  }
}

// ─── Paginated fetch (follows next_url cursor) ───────────────────────────────
async function fetchPaginated(url, max = Infinity) {
  let next = url, results = [], pages = 0;
  while (next && results.length < max) {
    const data = await fetchJson(next);
    if (data?._forbidden || data?._notfound) return { results, _terminal: data };
    if (Array.isArray(data?.results)) results.push(...data.results);
    else if (data?.results) results.push(data.results); // single-object endpoints (e.g. ticker details)
    next = data?.next_url || null;
    pages++;
    if (pages > 1000) { log('  hit 1000 page cap, stopping'); break; }
  }
  return { results, pages };
}

// ─── Write gzipped JSON atomically ──────────────────────────────────────────
async function writeGz(filepath, data) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const tmp = filepath + '.tmp';
  const json = JSON.stringify(data);
  await pipeline(Readable.from([json]), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp));
  fs.renameSync(tmp, filepath);
}

// ─── Freshness check ─────────────────────────────────────────────────────────
function isFresh(filepath) {
  try {
    const st = fs.statSync(filepath);
    const ageDays = (Date.now() - st.mtimeMs) / 86_400_000;
    return ageDays < FRESHNESS_DAYS;
  } catch { return false; }
}

// ─── PHASES ──────────────────────────────────────────────────────────────────
async function phaseReference() {
  if (!PHASES.has('reference')) return;
  log('=== Phase: REFERENCE (exchanges, conditions, ticker types) ===');
  const items = [
    { name: 'exchanges',         url: `${BASE}/v3/reference/exchanges` },
    { name: 'conditions_stocks', url: `${BASE}/v3/reference/conditions?asset_class=stocks&limit=1000` },
    { name: 'ticker_types',      url: `${BASE}/v3/reference/tickers/types` },
  ];
  for (const it of items) {
    const out = path.join(ROOT, 'reference', `${it.name}.json.gz`);
    if (isFresh(out)) { log(`  ${it.name}: fresh, skip`); continue; }
    const data = await fetchPaginated(it.url);
    await writeGz(out, data.results);
    log(`  ${it.name}: ${data.results?.length || 0} rows → ${out}`);
  }
}

async function phaseTickers() {
  if (!PHASES.has('tickers')) return [];
  log('=== Phase: TICKERS (all listed US stocks) ===');
  const out = path.join(ROOT, 'tickers', 'all_tickers.json.gz');
  let tickers;
  if (isFresh(out)) {
    log('  fresh — reading existing file');
    tickers = JSON.parse(zlib.gunzipSync(fs.readFileSync(out)).toString());
  } else {
    const data = await fetchPaginated(`${BASE}/v3/reference/tickers?market=stocks&active=true&limit=1000`);
    tickers = data.results;
    await writeGz(out, tickers);
    log(`  fetched ${tickers.length} tickers → ${out}`);
  }
  return tickers;
}

async function phasePerSymbol(tickers, name, dir, urlFn) {
  if (!PHASES.has(name)) return;
  log(`=== Phase: ${name.toUpperCase()} (per-symbol) ===`);
  const cp = path.join(ROOT, 'manifests', `checkpoint_${name}.json`);
  const done = fs.existsSync(cp) ? new Set(JSON.parse(fs.readFileSync(cp))) : new Set();
  let ok = 0, skip = 0, fail = 0, forbidden = 0;
  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    const sym = (t.ticker || t.symbol || '').toUpperCase();
    if (!sym) continue;
    if (ONLY.length && !ONLY.includes(sym)) continue;
    const fp = path.join(ROOT, dir, `${sym}.json.gz`);
    if (done.has(sym) && isFresh(fp)) { skip++; continue; }
    try {
      const data = await fetchPaginated(urlFn(sym));
      if (data._terminal?._forbidden) { forbidden++; continue; }
      await writeGz(fp, data.results || []);
      done.add(sym); ok++;
      if (ok % 100 === 0) {
        fs.writeFileSync(cp, JSON.stringify([...done]));
        log(`  progress ${name}: ok=${ok} skip=${skip} fail=${fail} forbidden=${forbidden} (${i+1}/${tickers.length})`);
      }
    } catch (e) {
      fail++;
      log(`  ✗ ${sym}: ${e.message?.slice(0, 60)}`);
    }
  }
  fs.writeFileSync(cp, JSON.stringify([...done]));
  log(`=== ${name} done: ok=${ok} skip=${skip} fail=${fail} forbidden=${forbidden} ===`);
}

async function main() {
  log(`Polygon REST snapshot — START (RPS=${RPS}, ROOT=${ROOT})`);
  if (ONLY.length) log(`  ONLY=${ONLY.join(',')}`);
  log(`  PHASES=${[...PHASES].join(',')}`);

  await phaseReference();
  const tickers = await phaseTickers();
  log(`  tickers list = ${tickers.length}`);

  // Per-symbol phases
  await phasePerSymbol(tickers, 'details',    'tickers/details',
    (s) => `${BASE}/v3/reference/tickers/${s}`);
  await phasePerSymbol(tickers, 'splits',     'corporate_actions/splits',
    (s) => `${BASE}/v3/reference/splits?ticker=${s}&limit=1000`);
  await phasePerSymbol(tickers, 'dividends',  'corporate_actions/dividends',
    (s) => `${BASE}/v3/reference/dividends?ticker=${s}&limit=1000`);
  await phasePerSymbol(tickers, 'financials', 'financials',
    (s) => `${BASE}/vX/reference/financials?ticker=${s}&timeframe=quarterly&limit=100`);

  log('Polygon REST snapshot — COMPLETE');
}

main().then(() => process.exit(0))
      .catch(e => { console.error('FATAL:', e); process.exit(1); });
