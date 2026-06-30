import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/chart.js';
import { initDb, query as dbQuery, isDbAvailable } from '../core/db.js';

let _dbReady = null;
async function _ensureDb() {
  if (_dbReady === null) _dbReady = initDb().then(() => isDbAvailable()).catch(() => false);
  return _dbReady;
}

/**
 * Exchange-qualify bare US-equity tickers (2026-06-12).
 * TradingView resolves bare symbols ambiguously — quote_get("NVDA") once returned a
 * Uniswap NVDA token instead of the stock. If the ticker exists in our own
 * tradable_universe on NASDAQ/NYSE, pin it (→ NASDAQ:NVDA). Prefixed symbols
 * (NYMEX:CL1!), futures (ES1!), crypto pairs, and non-universe symbols pass through.
 */
async function resolveEquitySymbol(symbol) {
  const s = String(symbol).trim().toUpperCase();
  if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(s)) return symbol;          // already prefixed / futures / pair
  try {
    if (!await _ensureDb()) return symbol;
    const { rows } = await dbQuery(
      `SELECT exchange FROM tradable_universe WHERE symbol = $1 LIMIT 1`, [s]);
    const ex = rows[0]?.exchange;
    if (ex === 'NASDAQ' || ex === 'NYSE') return `${ex}:${s}`;
    return symbol;                                                // ARCA/BATS ETFs resolve fine bare
  } catch { return symbol; }
}

export function registerChartTools(server) {
  server.tool('chart_get_state', 'Get current chart state (symbol, timeframe, chart type, indicators)', {}, async () => {
    try {
      const state = await core.getState();
      // Temporal honesty (2026-06-12): the "current chart" is whatever is focused at
      // THIS instant — it can change between tool calls (user clicks, async loads).
      state.as_of = new Date().toISOString();
      state.note  = 'Snapshot of the focused chart at as_of. It can differ across calls if the chart changed in between.';
      return jsonResult(state);
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_symbol', 'Change the chart symbol', {
    symbol: z.string().describe('Symbol to set (e.g., BTCUSD, AAPL, ES1!, NYMEX:CL1!)'),
  }, async ({ symbol }) => {
    try {
      const resolved = await resolveEquitySymbol(symbol);
      const result = await core.setSymbol({ symbol: resolved });
      if (resolved !== symbol) result.resolved_from = symbol;
      return jsonResult(result);
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_timeframe', 'Change the chart timeframe/resolution', {
    timeframe: z.string().describe('Timeframe (e.g., 1, 5, 15, 60, D, W, M)'),
  }, async ({ timeframe }) => {
    try { return jsonResult(await core.setTimeframe({ timeframe })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_type', 'Change chart type', {
    chart_type: z.string().describe('Chart type: Bars(0), Candles(1), Line(2), Area(3), Renko(4), Kagi(5), PointAndFigure(6), LineBreak(7), HeikinAshi(8), HollowCandles(9) — pass name or number'),
  }, async ({ chart_type }) => {
    try { return jsonResult(await core.setType({ chart_type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_manage_indicator', 'Add or remove an indicator/study on the chart', {
    action: z.enum(['add', 'remove']).describe('Action: add or remove'),
    indicator: z.string().describe('Full indicator name: "Relative Strength Index", "MACD", "Volume", "Moving Average", "Bollinger Bands", "Moving Average Exponential". Short names like RSI/EMA do NOT work.'),
    entity_id: z.string().optional().describe('Entity ID to remove (from chart_get_state). Required for remove.'),
    inputs: z.string().optional().describe('JSON string of input overrides for the indicator (e.g., \'{"length": 20}\')'),
  }, async ({ action, indicator, entity_id, inputs }) => {
    try { return jsonResult(await core.manageIndicator({ action, indicator, entity_id, inputs })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_get_visible_range', 'Get the visible date range (unix timestamps) and bars range on the chart', {}, async () => {
    try { return jsonResult(await core.getVisibleRange()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_visible_range', 'Zoom the chart to a specific date range (unix timestamps)', {
    from: z.coerce.number().describe('Start of range (unix timestamp in seconds)'),
    to: z.coerce.number().describe('End of range (unix timestamp in seconds)'),
  }, async ({ from, to }) => {
    try { return jsonResult(await core.setVisibleRange({ from, to })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_scroll_to_date', 'Jump the chart view to center on a specific date', {
    date: z.string().describe('ISO date string (e.g., "2024-01-15") or unix timestamp as a string'),
  }, async ({ date }) => {
    try { return jsonResult(await core.scrollToDate({ date })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('symbol_info', 'Get detailed metadata about the current symbol (name, exchange, type, description)', {}, async () => {
    try { return jsonResult(await core.symbolInfo()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('symbol_search', 'Search for symbols by name or keyword', {
    query: z.string().describe('Search query (e.g., "AAPL", "crude oil", "ES")'),
    type: z.string().optional().describe('Filter by type (e.g., "stock", "futures", "crypto", "forex")'),
  }, async ({ query, type }) => {
    try { return jsonResult(await core.symbolSearch({ query, type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
