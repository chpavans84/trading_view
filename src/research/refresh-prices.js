/**
 * src/research/refresh-prices.js — daily backtest_prices refresh via Alpaca.
 *
 * Why this exists: the bot's `gateLiquidityStale` reads `indicators.liquidity.last_date`
 * which comes from MAX(price_date) in backtest_prices. If the table isn't refreshed
 * daily, that data goes stale and the gate blocks all candidates. This module is the
 * fix.
 *
 * Why Alpaca (not Yahoo): Alpaca's /v2/stocks/bars accepts up to 50 symbols per
 * request. That makes 12K symbols ≈ 240 requests ≈ ~75 sec total (free tier:
 * 200 req/min). Yahoo would be ~100 minutes for the same job.
 *
 * Public API:
 *   refreshPrices({ daysBack? = 5, batchSize? = 50, dryRun? = false })
 *     → { processed, updated, errors, skipped, durationMs }
 *
 * Strategy:
 *   - Pull symbols from `tradable_universe` (12K rows).
 *   - Chunk into batches of 50.
 *   - For each batch: GET /v2/stocks/bars?symbols=...&timeframe=1Day&start=...
 *   - Upsert each (symbol, date) into backtest_prices ON CONFLICT.
 *   - Track per-batch failures, fire a system_alert if &lt; 80% success.
 *   - daysBack=5 by default so we catch any data the bot needs to backfill
 *     after a weekend/holiday gap, not just yesterday's close.
 *
 * Failure mode: if Alpaca creds aren't configured, returns early with an error.
 * If a batch fails (network, 429, etc.), logs the batch and continues — partial
 * refresh is better than no refresh.
 */

import { query, isDbAvailable } from '../core/db.js';
import { alert as raiseSystemAlert } from '../core/system-alerts.js';

const ALPACA_DATA_URL = 'https://data.alpaca.markets';
const REQUEST_TIMEOUT_MS = 30_000;

// Alpaca free tier: 200 req/min = 3.33 req/sec. We use a small inter-batch delay
// to stay well under that. 250ms = 4 req/sec — slightly over limit, so cap with
// promise pacing. Empirically, with 50-symbol batches, 350ms delay sustains forever.
const INTER_BATCH_DELAY_MS = 350;

const ALPACA_MAX_SYMBOLS_PER_REQUEST = 50;   // Alpaca docs cap (verify against your tier)
const MIN_SUCCESS_RATE_FOR_OK         = 0.80;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _todayUtcIso() {
  return new Date().toISOString();
}

function _isoNDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// ─── Alpaca API call ─────────────────────────────────────────────────────────

async function _fetchBarsBatch(symbols, { start, end }) {
  const apiKey    = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  if (!apiKey || !secretKey) throw new Error('ALPACA_API_KEY / ALPACA_SECRET_KEY not configured');

  const url = new URL('/v2/stocks/bars', ALPACA_DATA_URL);
  url.searchParams.set('symbols',   symbols.join(','));
  url.searchParams.set('timeframe', '1Day');
  url.searchParams.set('start',     start);
  url.searchParams.set('end',       end);
  url.searchParams.set('limit',     '10000');
  url.searchParams.set('adjustment','raw');
  // Free tier only allows feed=iex. SIP returns HTTP 403 unless you have a paid
  // Algo Trader+ subscription. IEX covers ~3% of consolidated volume but is sufficient
  // for daily-close OHLCV on liquid names (the universe the bot actually scans).
  // Override with ALPACA_DATA_FEED=sip if/when you upgrade.
  url.searchParams.set('feed', process.env.ALPACA_DATA_FEED || 'iex');

  const res = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID':     apiKey,
      'APCA-API-SECRET-KEY': secretKey,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Alpaca HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  return await res.json();   // { bars: { AAPL: [{t,o,h,l,c,v,...}], MSFT: [...] }, next_page_token? }
}

// ─── Upsert helper ───────────────────────────────────────────────────────────

async function _upsertBar(symbol, bar) {
  // Alpaca bar shape: { t: "2026-05-27T04:00:00Z", o, h, l, c, v, n, vw }
  // price_date stored as DATE (no time) — use the UTC date portion of `t`.
  const priceDate = bar.t.slice(0, 10);
  await query(
    `INSERT INTO backtest_prices (symbol, price_date, open, high, low, close, volume, adj_close)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (symbol, price_date) DO UPDATE SET
       open      = EXCLUDED.open,
       high      = EXCLUDED.high,
       low       = EXCLUDED.low,
       close     = EXCLUDED.close,
       volume    = EXCLUDED.volume,
       adj_close = EXCLUDED.adj_close`,
    [symbol, priceDate, bar.o ?? null, bar.h ?? null, bar.l ?? null, bar.c, bar.v ?? null, bar.c]
  );
}

// ─── Public entry point ──────────────────────────────────────────────────────

export async function refreshPrices({
  daysBack = 5,
  batchSize = ALPACA_MAX_SYMBOLS_PER_REQUEST,
  dryRun = false,
  symbolFilter = null,    // optional array of symbols to limit to (for testing)
} = {}) {
  if (!isDbAvailable()) throw new Error('DB not available — call initDb() first');

  const t0 = Date.now();
  const start = _isoNDaysAgo(daysBack);
  const end   = _todayUtcIso();

  // 1. Load symbols from tradable_universe (or use the filter)
  let symbols;
  if (Array.isArray(symbolFilter) && symbolFilter.length) {
    symbols = symbolFilter.map(s => s.toUpperCase());
  } else {
    const { rows } = await query(
      // Use last_synced_at to avoid totally-dead symbols. No excluded_at column exists.
      `SELECT symbol FROM tradable_universe WHERE symbol IS NOT NULL ORDER BY symbol`
    );
    symbols = rows.map(r => r.symbol);
  }

  if (!symbols.length) return { error: 'no_symbols' };

  const batches = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    batches.push(symbols.slice(i, i + batchSize));
  }

  console.log(`[refresh-prices] ${symbols.length} symbols → ${batches.length} batches of ${batchSize} (daysBack=${daysBack}, dryRun=${dryRun})`);

  let updated = 0;     // total (symbol, date) rows upserted
  let errors  = 0;     // batches that hard-failed
  let symbolsGotData = 0;
  const failedBatches = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const data = await _fetchBarsBatch(batch, { start, end });
      const barsObj = data?.bars ?? {};
      for (const [sym, bars] of Object.entries(barsObj)) {
        if (!Array.isArray(bars) || bars.length === 0) continue;
        symbolsGotData++;
        if (dryRun) continue;
        for (const bar of bars) {
          try {
            await _upsertBar(sym, bar);
            updated++;
          } catch (e) {
            // Single-row insert failure is unusual but non-fatal; log and continue.
            console.warn(`[refresh-prices] upsert ${sym} @ ${bar.t}: ${e.message}`);
          }
        }
      }
      if (i % 10 === 0 || i === batches.length - 1) {
        console.log(`[refresh-prices] batch ${i + 1}/${batches.length} done — ${symbolsGotData} symbols updated, ${updated} rows`);
      }
    } catch (e) {
      errors++;
      failedBatches.push({ start: batch[0], end: batch[batch.length - 1], error: e.message });
      console.warn(`[refresh-prices] batch ${i + 1}/${batches.length} failed: ${e.message}`);
    }

    // Pacing — don't hammer Alpaca's 200 req/min limit
    if (i < batches.length - 1) await sleep(INTER_BATCH_DELAY_MS);
  }

  const durationMs    = Date.now() - t0;
  const skipped       = symbols.length - symbolsGotData;
  const successRate   = symbols.length > 0 ? symbolsGotData / symbols.length : 0;

  const summary = {
    processed:      symbols.length,
    batches:        batches.length,
    symbols_with_data: symbolsGotData,
    rows_upserted:  updated,
    batch_errors:   errors,
    skipped,
    success_rate:   +successRate.toFixed(3),
    duration_ms:    durationMs,
    duration_sec:   +(durationMs / 1000).toFixed(1),
    dry_run:        dryRun,
  };

  console.log(`[refresh-prices] DONE: ${JSON.stringify(summary)}`);

  // Raise alert if too few symbols got data — bot freshness gates will mis-fire otherwise.
  if (!dryRun && successRate < MIN_SUCCESS_RATE_FOR_OK) {
    try {
      await raiseSystemAlert({
        key:      'refresh_prices_low_success',
        severity: errors > batches.length * 0.5 ? 'critical' : 'warn',
        title:    `Daily price refresh: only ${(successRate * 100).toFixed(1)}% of symbols got data`,
        detail:   { summary, failed_batches_sample: failedBatches.slice(0, 5) },
        dedup_window_minutes: 60,
      });
    } catch (e) {
      console.warn('[refresh-prices] system_alert raise failed:', e.message);
    }
  }

  return summary;
}
