/**
 * TradingView bridge for the Telegram bot.
 * Wraps CDP-based chart tools with graceful fallback when TradingView
 * Desktop is not running. All functions return { available: false } instead
 * of throwing when CDP is unreachable.
 */

import { getState }      from './chart.js';
import { getOhlcv, getStudyValues, getPineLines, getPineLabels, getQuote } from './data.js';

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

  _availCache = { value: result, expiresAt: Date.now() + 60_000 };
  return result;
}

// ─── Chart Technicals ─────────────────────────────────────────────────────────

export async function getChartTechnicals({ symbol } = {}) {
  if (!await isTradingViewAvailable()) {
    return { available: false, reason: 'TradingView Desktop not running' };
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
    return { available: false, reason: 'TradingView Desktop not running' };
  }

  try {
    const result = await getOhlcv({ count: 20, summary: true });
    return { available: true, ...result };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}
