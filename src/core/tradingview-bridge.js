/**
 * TradingView bridge for the Telegram bot.
 * Wraps CDP-based chart tools with graceful fallback when TradingView
 * Desktop is not running. Falls back to Yahoo Finance for technicals.
 */

import { getState }      from './chart.js';
import { getOhlcv, getStudyValues, getPineLines, getPineLabels, getQuote } from './data.js';
import { getKLines as moomooGetKLines, getQuote as moomooGetQuote } from './moomoo-tcp.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

// ─── Availability cache (60-second TTL) ──────────────────────────────────────

let _availCache = { value: null, expiresAt: 0 };

export async function isTradingViewAvailable() {
  if (Date.now() < _availCache.expiresAt) return _availCache.value;

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 2000);
    fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`)
      .then(r => r.json())
      .then(targets => {
        clearTimeout(timer);
        const found = Array.isArray(targets) && targets.some(
          t => t.type === 'page' && /tradingview/i.test(t.url)
        );
        resolve(found);
      })
      .catch(() => { clearTimeout(timer); resolve(false); });
  });

  _availCache = { value: result, expiresAt: Date.now() + 15_000 };
  return result;
}

// ─── Fallback technicals — Moomoo KLines first, Yahoo Finance second ─────────

async function fetchFallbackTechnicals(symbol) {
  let closes, highs, lows, vols, price, dayHigh, dayLow, source;

  // Tier 1: Moomoo KLines
  try {
    const [klResult, quoteResult] = await Promise.allSettled([
      moomooGetKLines({ symbol, klType: 'day', count: 90 }),
      moomooGetQuote(symbol),
    ]);
    const kl = klResult.status === 'fulfilled' ? klResult.value : null;
    const qt = quoteResult.status === 'fulfilled' ? quoteResult.value : null;

    if (kl?.success && kl.candles?.length >= 20) {
      closes = kl.candles.map(c => c.close);
      highs  = kl.candles.map(c => c.high);
      lows   = kl.candles.map(c => c.low);
      vols   = kl.candles.map(c => c.volume ?? 0);
      price  = qt?.price ?? closes.at(-1);
      dayHigh = qt?.high ?? highs.at(-1);
      dayLow  = qt?.low  ?? lows.at(-1);
      source  = 'moomoo';
    }
  } catch { /* fall through */ }

  // Tier 2: Yahoo Finance fallback
  if (!closes) {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=90d`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(7000) }
    );
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    const d   = await r.json();
    const res = d?.chart?.result?.[0];
    if (!res) throw new Error('No data');
    const meta = res.meta ?? {};
    const q    = res.indicators?.quote?.[0] ?? {};
    closes  = (q.close  ?? []).filter(v => v != null);
    highs   = (q.high   ?? []).filter(v => v != null);
    lows    = (q.low    ?? []).filter(v => v != null);
    vols    = (q.volume ?? []).filter(v => v != null);
    price   = meta.regularMarketPrice ?? closes.at(-1);
    dayHigh = meta.regularMarketDayHigh ?? highs.at(-1);
    dayLow  = meta.regularMarketDayLow  ?? lows.at(-1);
    source  = 'yahoo';
  }

  if (closes.length < 20) throw new Error('Insufficient data');

  // EMA helper
  function ema(arr, period) {
    const k = 2 / (period + 1);
    let e = arr.slice(0, period).reduce((s, v) => s + v, 0) / period;
    const out = new Array(period - 1).fill(null);
    out.push(e);
    for (let i = period; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); }
    return out;
  }

  // RSI-14
  function rsi14(arr) {
    let gains = 0, losses = 0;
    for (let i = arr.length - 14; i < arr.length; i++) {
      const d = arr[i] - arr[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    const rs = gains / (losses || 1e-10);
    return +(100 - 100 / (1 + rs)).toFixed(2);
  }

  // Bollinger Bands-20
  function bb20(arr) {
    const slice = arr.slice(-20);
    const mid   = slice.reduce((s, v) => s + v, 0) / 20;
    const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mid) ** 2, 0) / 20);
    return { mid: +mid.toFixed(2), upper: +(mid + 2 * std).toFixed(2), lower: +(mid - 2 * std).toFixed(2) };
  }

  const ema20arr = ema(closes, 20);
  const ema50arr = ema(closes, Math.min(50, closes.length));
  const ema12arr = ema(closes, 12);
  const ema26arr = ema(closes, 26);
  const macdLine = ema12arr.map((v, i) => v != null && ema26arr[i] != null ? v - ema26arr[i] : null).filter(v => v != null);
  const signalArr = ema(macdLine, 9);
  const macdHist  = macdLine.at(-1) - (signalArr.at(-1) ?? 0);
  const { mid: bbMid, upper: bbUpper, lower: bbLower } = bb20(closes);

  const prev = closes.at(-2);

  return {
    available:     true,
    source,
    symbol:        symbol.toUpperCase(),
    current_price: price != null ? +parseFloat(price).toFixed(2) : null,
    change_pct:    prev && price ? +((price - prev) / prev * 100).toFixed(2) : null,
    rsi:           rsi14(closes),
    ema20:         ema20arr.at(-1) != null ? +ema20arr.at(-1).toFixed(2) : null,
    ema50:         ema50arr.at(-1) != null ? +ema50arr.at(-1).toFixed(2) : null,
    macd_hist:     +macdHist.toFixed(4),
    bb_upper:      bbUpper,
    bb_mid:        bbMid,
    bb_lower:      bbLower,
    day_high:      dayHigh ?? null,
    day_low:       dayLow  ?? null,
    volume:        vols.at(-1) ?? null,
    note:          `TradingView unavailable — technicals computed from ${source === 'moomoo' ? 'Moomoo real-time' : 'Yahoo Finance'} daily OHLCV`,
  };
}

// ─── Chart Technicals ─────────────────────────────────────────────────────────

export async function getChartTechnicals({ symbol } = {}) {
  if (!await isTradingViewAvailable()) {
    if (!symbol) return { available: false, reason: 'TradingView unavailable and no symbol provided for fallback' };
    try { return await fetchFallbackTechnicals(symbol); } catch (e) {
      return { available: false, reason: `TradingView unavailable; fallback failed: ${e.message}` };
    }
  }

  try {
    const [stateResult, studyResult, quoteResult] = await Promise.allSettled([
      getState(),
      getStudyValues(),
      getQuote({}),
    ]);

    const state = stateResult.status === 'fulfilled' ? stateResult.value : null;
    const studies = studyResult.status === 'fulfilled' ? studyResult.value?.studies || [] : [];
    const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : null;

    const chartSymbol = state?.symbol ?? null;
    const symbolMismatch = symbol && chartSymbol &&
      !chartSymbol.toUpperCase().includes(symbol.toUpperCase());

    // Flatten all study values into one map for easy lookup
    const flat = {};
    for (const s of studies) {
      for (const [key, val] of Object.entries(s.values || {})) {
        flat[`${s.name}::${key}`] = val;
      }
    }

    function findValue(...keys) {
      for (const k of keys) {
        for (const [flatKey, val] of Object.entries(flat)) {
          if (flatKey.toLowerCase().includes(k.toLowerCase())) {
            const num = parseFloat(String(val).replace(/[^0-9.\-]/g, ''));
            if (!isNaN(num)) return num;
          }
        }
      }
      return null;
    }

    return {
      available:       true,
      symbol:          chartSymbol,
      timeframe:       state?.resolution ?? null,
      symbol_mismatch: symbolMismatch || false,
      current_price:   quote?.price ?? null,
      rsi:             findValue('RSI', 'rsi'),
      macd_hist:       findValue('Hist', 'histogram', 'MACD Hist'),
      ema20:           findValue('EMA20', 'EMA 20', '20 EMA'),
      ema50:           findValue('EMA50', 'EMA 50', '50 EMA'),
      bb_upper:        findValue('Upper', 'BB Upper', 'Bollinger Upper'),
      bb_lower:        findValue('Lower', 'BB Lower', 'Bollinger Lower'),
      bb_mid:          findValue('Basis', 'BB Mid', 'Bollinger Mid'),
      raw_studies:     studies,
    };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

// ─── Price Levels ─────────────────────────────────────────────────────────────

export async function getPriceLevels({ symbol, study_filter } = {}) {
  if (!await isTradingViewAvailable()) {
    return { available: false, reason: 'TradingView Desktop not running' };
  }

  try {
    const [linesResult, labelsResult, quoteResult] = await Promise.allSettled([
      getPineLines({ study_filter }),
      getPineLabels({ study_filter }),
      getQuote({}),
    ]);

    const linesData  = linesResult.status  === 'fulfilled' ? linesResult.value  : null;
    const labelsData = labelsResult.status === 'fulfilled' ? labelsResult.value : null;
    const quote      = quoteResult.status  === 'fulfilled' ? quoteResult.value  : null;
    const price      = quote?.price ?? null;

    // Collect all numeric price levels from lines
    const levelSet = new Map();
    for (const study of linesData?.studies || []) {
      for (const lvl of study.horizontal_levels || []) {
        levelSet.set(lvl, { price: lvl, label: study.name, type: 'level' });
      }
    }
    // Add labeled levels from pine labels
    for (const study of labelsData?.studies || []) {
      for (const lbl of study.labels || []) {
        if (lbl.price != null) {
          const text = lbl.text?.toLowerCase() || '';
          const type = text.includes('support') || text.includes('sup') ? 'support'
            : text.includes('resist') || text.includes('res')           ? 'resistance'
            : 'level';
          levelSet.set(lbl.price, { price: lbl.price, label: lbl.text || study.name, type });
        }
      }
    }

    const levels = [...levelSet.values()].sort((a, b) => b.price - a.price);

    let nearest_support = null;
    let nearest_resistance = null;

    if (price != null) {
      nearest_support    = levels.filter(l => l.price < price).at(0)  ?? null;
      nearest_resistance = levels.filter(l => l.price > price).at(-1) ?? null;
    }

    const distance_to_support_pct = price && nearest_support
      ? +((price - nearest_support.price) / price * 100).toFixed(2) : null;
    const distance_to_resistance_pct = price && nearest_resistance
      ? +((nearest_resistance.price - price) / price * 100).toFixed(2) : null;

    return {
      available: true,
      current_price:               price,
      level_count:                 levels.length,
      levels,
      nearest_support,
      nearest_resistance,
      distance_to_support_pct,
      distance_to_resistance_pct,
    };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

// ─── OHLCV Summary ────────────────────────────────────────────────────────────

export async function getOHLCVSummary({ symbol } = {}) {
  if (!await isTradingViewAvailable()) {
    if (!symbol) return { available: false, reason: 'TradingView unavailable and no symbol provided for fallback' };
    try { return await fetchFallbackTechnicals(symbol); } catch (e) {
      return { available: false, reason: `TradingView unavailable; fallback failed: ${e.message}` };
    }
  }

  try {
    const result = await getOhlcv({ count: 20, summary: true });
    return { available: true, ...result };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}
