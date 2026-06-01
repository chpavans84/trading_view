#!/usr/bin/env node
/**
 * scripts/build-sector-tags.mjs
 *
 * Fills NULL sector + industry on `tradable_universe` using Yahoo's
 * quoteSummary { assetProfile } module.
 *
 * Today: 9,703 of 12,341 symbols (78.6%) have NULL sector — including
 * mega-caps like MU, NVDA, TSLA, SNDK, MSFT (sync was broken/stale).
 *
 * For ETFs (no sector by definition), tags with `_etf_` placeholder so
 * downstream queries can filter (`sector NOT LIKE '\\_etf%'` for stocks).
 *
 * Usage:
 *   node scripts/build-sector-tags.mjs              # all NULL-sector symbols
 *   node scripts/build-sector-tags.mjs --refresh    # refresh ALL (including non-NULL)
 *   node scripts/build-sector-tags.mjs --symbols MU,NVDA,TSLA
 */

import '../src/core/env-loader.js';
import { initDb, query } from '../src/core/db.js';
import YahooFinance from 'yahoo-finance2';

const yahoo = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const REFRESH      = args.includes('--refresh');
const SYMBOLS_CSV  = getArg('symbols');
const CONCURRENCY  = parseInt(getArg('concurrency', '8'), 10);

async function fetchOne(symbol) {
  try {
    const r = await yahoo.quoteSummary(symbol, {
      modules: ['assetProfile', 'summaryProfile', 'quoteType'],
    }, { validateResult: false });

    const ap = r?.assetProfile ?? r?.summaryProfile ?? {};
    const qt = r?.quoteType ?? {};

    let sector   = ap.sector  || null;
    let industry = ap.industry || null;

    // ETF/Index handling
    if (!sector && (qt.quoteType === 'ETF' || qt.quoteType === 'INDEX')) {
      sector   = '_etf_';
      industry = qt.quoteType.toLowerCase();
    }
    if (!sector && qt.quoteType === 'MUTUALFUND') {
      sector = '_fund_'; industry = 'mutual_fund';
    }

    return {
      symbol, sector, industry,
      country: ap.country || null,
      company_name: qt.longName || qt.shortName || ap.name || null,
      status: sector ? 'ok' : 'no_sector',
      error: null,
    };
  } catch (e) {
    return { symbol, status: 'error', error: e.message?.slice(0, 200) };
  }
}

async function upsert(row) {
  if (row.status !== 'ok') return;
  await query(`
    UPDATE tradable_universe
       SET sector           = COALESCE($2, sector),
           industry         = COALESCE($3, industry),
           country          = COALESCE($4, country),
           company_name     = COALESCE($5, company_name),
           sector_synced_at = NOW()
     WHERE symbol = $1
  `, [row.symbol, row.sector, row.industry, row.country, row.company_name]);
}

async function runWithConcurrency(items, limit, worker) {
  let idx = 0, done = 0;
  const tStart = Date.now();
  const counts = { ok: 0, no_sector: 0, error: 0 };

  async function runWorker() {
    while (idx < items.length) {
      const i = idx++;
      const r = await worker(items[i], i);
      counts[r.status] = (counts[r.status] || 0) + 1;
      done++;
      if (done % 200 === 0 || done === items.length) {
        const elapsed = ((Date.now() - tStart) / 60_000).toFixed(1);
        const rate    = (done / ((Date.now() - tStart) / 1000)).toFixed(1);
        console.log(`[sectors] ${done}/${items.length}  ok=${counts.ok}  no_sector=${counts.no_sector || 0}  err=${counts.error || 0}  ${rate}/s  (${elapsed}m elapsed)`);
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, () => runWorker()));
}

async function main() {
  await initDb();

  let symbols;
  if (SYMBOLS_CSV) {
    symbols = SYMBOLS_CSV.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  } else if (REFRESH) {
    const { rows } = await query(`SELECT symbol FROM tradable_universe ORDER BY COALESCE(adv_dollar_30d, 0) DESC`);
    symbols = rows.map(r => r.symbol);
  } else {
    const { rows } = await query(`SELECT symbol FROM tradable_universe WHERE sector IS NULL ORDER BY COALESCE(adv_dollar_30d, 0) DESC`);
    symbols = rows.map(r => r.symbol);
  }

  console.log(`[sectors] ${symbols.length} symbols to fetch`);
  if (!symbols.length) { console.log('[sectors] nothing to do'); process.exit(0); }

  await runWithConcurrency(symbols, CONCURRENCY, async (sym) => {
    const row = await fetchOne(sym);
    try { await upsert(row); } catch (e) { console.warn(`[sectors] upsert ${sym}:`, e.message); }
    return row;
  });

  // Summary
  const { rows: stats } = await query(`
    SELECT
      COUNT(*) AS total,
      COUNT(sector) AS with_sector,
      COUNT(*) FILTER (WHERE sector LIKE '\\_etf%' OR sector LIKE '\\_fund%') AS funds_etfs,
      COUNT(*) FILTER (WHERE sector IS NOT NULL AND sector NOT LIKE '\\_%') AS real_stocks
      FROM tradable_universe
  `);
  console.log('\n[sectors] final coverage:');
  console.log(`  Total:       ${stats[0].total}`);
  console.log(`  With sector: ${stats[0].with_sector}  (${(stats[0].with_sector / stats[0].total * 100).toFixed(1)}%)`);
  console.log(`  Real stocks tagged: ${stats[0].real_stocks}`);
  console.log(`  ETFs/funds tagged:  ${stats[0].funds_etfs}`);
  process.exit(0);
}

main().catch(e => { console.error('[sectors] FATAL:', e); process.exit(1); });
