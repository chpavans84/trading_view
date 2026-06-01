/**
 * Tradable Universe Sync — daily refresh at 8 AM ET Mon–Fri.
 *
 * Phase 1: Pull Alpaca /v2/assets → filter NYSE/NASDAQ tradable equities → UPSERT.
 * Phase 2: Enrich with Yahoo Finance market cap, ADV, price, sector (concurrency 20).
 *
 * Guard: if >50% of rows were synced in the last 24 h, fast-return unless force=true.
 */

import YahooFinance from 'yahoo-finance2';
import { query, isDbAvailable } from './db.js';
import { getAlpacaAssets } from '../brokers/alpaca.js';

const yf = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

// Added 'ARCA' + 'BATS' (2026-05-27): the original {NYSE,NASDAQ}-only filter
// silently excluded *every* major sector + leveraged ETF that trades on NYSE
// Arca — SOXL, SPY, XLK, XLF, IWM, GLD, EWZ, etc. These are exactly the names
// users ask "why didn't the bot catch the semis pop?" about. ARCA-listed
// products are tradable on Alpaca/Tiger like any other equity.
const ALLOWED_EXCHANGES = new Set(['NYSE', 'NASDAQ', 'ARCA', 'BATS']);
const YAHOO_CONCURRENCY = 20;

// ── concurrency-limited batch helper ─────────────────────────────────────────

async function _runBatched(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(chunk.map(fn));
    results.push(...settled);
  }
  return results;
}

// ── main export ───────────────────────────────────────────────────────────────

export async function syncTradableUniverse({ force = false } = {}) {
  if (!isDbAvailable()) return { skipped: true, reason: 'no_db' };

  const t0 = Date.now();

  // Guard: skip if most rows are fresh and force not requested
  if (!force) {
    try {
      const { rows: counts } = await query(`
        SELECT
          COUNT(*)::int                                                      AS total,
          COUNT(*) FILTER (WHERE last_synced_at > NOW() - INTERVAL '24 hours')::int AS recent
        FROM tradable_universe
      `);
      const { total, recent } = counts[0];
      if (total > 0 && recent > total * 0.5) {
        console.log(`[universe-sync] skipped — ${recent}/${total} rows synced <24 h ago (use ?force=true to override)`);
        return { skipped: true, reason: 'recently_synced', total, recent };
      }
    } catch (e) {
      console.warn('[universe-sync] guard query failed, proceeding:', e.message);
    }
  }

  // ── Phase 1: Alpaca assets ─────────────────────────────────────────────────
  console.log('[universe-sync] Phase 1 — fetching Alpaca assets…');
  let assets;
  try {
    assets = await getAlpacaAssets();
  } catch (e) {
    console.error('[universe-sync] Alpaca fetch failed:', e.message);
    return { error: e.message };
  }

  const filtered = assets.filter(
    a => a.tradable && ALLOWED_EXCHANGES.has(a.exchange)
  );
  console.log(`[universe-sync] Alpaca: ${assets.length} total → ${filtered.length} NYSE/NASDAQ tradable`);

  // UPSERT Phase 1 rows (exchange/broker metadata)
  let upserted = 0;
  for (const a of filtered) {
    try {
      await query(
        `INSERT INTO tradable_universe
           (symbol, exchange, asset_class, fractionable, marginable, shortable, easy_to_borrow, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (symbol) DO UPDATE SET
           exchange       = EXCLUDED.exchange,
           asset_class    = EXCLUDED.asset_class,
           fractionable   = EXCLUDED.fractionable,
           marginable     = EXCLUDED.marginable,
           shortable      = EXCLUDED.shortable,
           easy_to_borrow = EXCLUDED.easy_to_borrow,
           last_synced_at = NOW()`,
        [a.symbol, a.exchange, a.asset_class,
         a.fractionable ?? false, a.marginable ?? false,
         a.shortable ?? false, a.easy_to_borrow ?? false]
      );
      upserted++;
    } catch (e) {
      console.warn(`[universe-sync] upsert failed for ${a.symbol}:`, e.message);
    }
  }
  console.log(`[universe-sync] Phase 1 done — ${upserted} rows upserted`);

  // ── Phase 2: Yahoo enrichment ─────────────────────────────────────────────
  console.log(`[universe-sync] Phase 2 — enriching ${filtered.length} symbols via Yahoo (concurrency ${YAHOO_CONCURRENCY})…`);

  let enriched = 0;
  let skipped  = 0;

  const symbols = filtered.map(a => a.symbol);

  await _runBatched(symbols, YAHOO_CONCURRENCY, async sym => {
    try {
      const q = await yf.quote(sym, {}, { validateResult: false });
      if (!q) { skipped++; return; }

      const marketCapUsd = q.marketCap          ?? null;
      const avgVol30d    = q.averageDailyVolume3Month ?? q.averageVolume10days ?? null;
      const lastPrice    = q.regularMarketPrice  ?? null;
      const sector       = q.sector              ?? null;
      const advDollar    = (avgVol30d != null && lastPrice != null)
        ? avgVol30d * lastPrice
        : null;

      await query(
        `UPDATE tradable_universe
         SET market_cap_usd = $1,
             avg_volume_30d  = $2,
             adv_dollar_30d  = $3,
             last_price      = $4,
             sector          = $5,
             last_synced_at  = NOW()
         WHERE symbol = $6`,
        [marketCapUsd, avgVol30d, advDollar, lastPrice, sector, sym]
      );
      enriched++;
    } catch (e) {
      console.warn(`[universe-sync] Yahoo enrichment failed for ${sym}:`, e.message);
      skipped++;
    }
  });

  const durationMs = Date.now() - t0;
  console.log(`[universe-sync] done — fetched=${filtered.length} enriched=${enriched} skipped=${skipped} duration=${durationMs}ms`);
  return { fetched: filtered.length, enriched, skipped, durationMs };
}
