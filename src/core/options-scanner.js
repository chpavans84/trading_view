/**
 * Unusual options activity scanner via yahoo-finance2.
 *
 * Flags a contract as unusual when:
 *   volume > openInterest * 2  AND  volume > 500
 *
 * Flags as a large bet when:
 *   impliedVolatility > 0.60  (60%+)
 *
 * Fetches the 4 nearest expiries in parallel so the put/call ratio
 * reflects near-term sentiment, not just the front-week chain.
 */

import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

const VOL_THRESHOLD = 500;
const RATIO_THRESHOLD = 2;      // vol / OI must exceed this
const IV_LARGE_BET   = 0.60;    // 60% IV = elevated risk, large directional bet
const EXPIRY_CHAINS  = 4;       // number of expiry dates to scan

function _fmtDate(d) {
  if (!d) return null;
  try {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toISOString().split('T')[0];
  } catch { return null; }
}

function _mapContract(raw, type) {
  const vol = raw.volume        ?? 0;
  const oi  = raw.openInterest  ?? 0;
  const iv  = raw.impliedVolatility ?? 0;
  return {
    contractSymbol:    raw.contractSymbol,
    type,                                            // 'call' | 'put'
    strike:            raw.strike,
    expiry:            _fmtDate(raw.expiration),
    volume:            vol,
    openInterest:      oi,
    ratio:             oi > 0 ? +(vol / oi).toFixed(2) : null,
    impliedVolatility: +iv.toFixed(4),
    largeBet:          iv > IV_LARGE_BET,
    lastPrice:         raw.lastPrice,
    inTheMoney:        raw.inTheMoney ?? false,
  };
}

/**
 * Scan options chains for unusual activity on a single ticker.
 *
 * @param {string} ticker  Stock symbol (e.g. 'AAPL')
 * @returns {Promise<{
 *   unusual_contracts: object[],
 *   put_call_ratio: number|null,
 *   summary: 'Bullish'|'Bearish'|'Neutral',
 *   total_call_volume: number,
 *   total_put_volume: number,
 *   chains_scanned: number,
 * }>}
 */
export async function checkUnusualOptions(ticker) {
  const sym = ticker.toUpperCase().replace(/^(NASDAQ:|NYSE:|AMEX:)/, '');

  // ── Step 1: fetch nearest expiry + get expirationDates list ─────────────────
  let base;
  try {
    base = await yf.options(sym, {}, { validateResult: false });
  } catch (e) {
    throw new Error(`yahoo-finance2 options(${sym}) failed: ${e.message}`);
  }

  const expDates = (base.expirationDates ?? []).slice(0, EXPIRY_CHAINS);

  // ── Step 2: fetch remaining expiries in parallel ──────────────────────────
  const extraResults = await Promise.allSettled(
    expDates.slice(1).map(d => yf.options(sym, { date: d }, { validateResult: false }))
  );

  const allChains = [
    base,
    ...extraResults.filter(r => r.status === 'fulfilled').map(r => r.value),
  ];

  // ── Step 3: scan contracts across all fetched chains ─────────────────────
  let totalCallVol = 0;
  let totalPutVol  = 0;
  const unusual    = [];

  for (const chain of allChains) {
    const contracts = chain.options?.[0];
    if (!contracts) continue;

    for (const raw of contracts.calls ?? []) {
      const vol = raw.volume ?? 0;
      const oi  = raw.openInterest ?? 0;
      totalCallVol += vol;
      if (vol > oi * RATIO_THRESHOLD && vol > VOL_THRESHOLD) {
        unusual.push(_mapContract(raw, 'call'));
      }
    }

    for (const raw of contracts.puts ?? []) {
      const vol = raw.volume ?? 0;
      const oi  = raw.openInterest ?? 0;
      totalPutVol += vol;
      if (vol > oi * RATIO_THRESHOLD && vol > VOL_THRESHOLD) {
        unusual.push(_mapContract(raw, 'put'));
      }
    }
  }

  // ── Step 4: rank + slice ─────────────────────────────────────────────────
  const unusual_contracts = unusual
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))
    .slice(0, 5);

  const put_call_ratio = totalCallVol > 0
    ? +(totalPutVol / totalCallVol).toFixed(2)
    : null;

  const summary =
    put_call_ratio == null  ? 'Neutral' :
    put_call_ratio >   1.3  ? 'Bearish' :
    put_call_ratio <   0.7  ? 'Bullish' :
    'Neutral';

  console.log(`[options] ${sym}: ${unusual_contracts.length} unusual contract(s) | P/C=${put_call_ratio} | ${summary} | chains=${allChains.length}`);

  return {
    unusual_contracts,
    put_call_ratio,
    summary,
    total_call_volume: totalCallVol,
    total_put_volume:  totalPutVol,
    chains_scanned:    allChains.length,
  };
}
