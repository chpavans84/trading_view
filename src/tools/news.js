import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/news.js';

export function registerNewsTools(server) {
  server.tool(
    'news_get_symbol',
    'Get latest news headlines for a stock symbol from Yahoo Finance. Returns titles, publisher, publish time, and URL.',
    {
      symbol: z.string().describe('Stock ticker, e.g. "MRVL", "AAPL", "TSLA"'),
      limit: z.number().int().min(1).max(25).optional().describe('Number of articles to return (default: 10)'),
    },
    async ({ symbol, limit }) => {
      try { return jsonResult(await core.getSymbolNews({ symbol, limit })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'news_get_earnings',
    'Get earnings history and upcoming earnings estimates for a stock. Returns last 4 quarters of EPS actuals vs estimates, surprise %, and analyst estimates for next quarters.',
    {
      symbol: z.string().describe('Stock ticker, e.g. "MRVL", "AAPL"'),
    },
    async ({ symbol }) => {
      try { return jsonResult(await core.getEarnings({ symbol })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'news_get_financials',
    'Get company financials: revenue, EPS, profit margins, analyst price targets, growth rates, and income statements. Use period="quarterly" (default) or "annual".',
    {
      symbol: z.string().describe('Stock ticker, e.g. "MRVL", "AAPL"'),
      period: z.enum(['quarterly', 'annual']).optional().describe('quarterly or annual (default: quarterly)'),
    },
    async ({ symbol, period }) => {
      try { return jsonResult(await core.getFinancials({ symbol, period })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'news_get_filings',
    'Get recent SEC filings for a company from EDGAR. Use form_type="8-K" for earnings announcements, "10-Q" for quarterly reports, "10-K" for annual reports.',
    {
      symbol: z.string().describe('Stock ticker, e.g. "MRVL"'),
      form_type: z.enum(['8-K', '10-Q', '10-K', '4', 'SC 13G']).optional().describe('SEC form type (default: 8-K)'),
      limit: z.number().int().min(1).max(10).optional().describe('Number of filings to return (default: 5)'),
    },
    async ({ symbol, form_type, limit }) => {
      try { return jsonResult(await core.getFilings({ symbol, form_type, limit })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'news_get_earnings_calendar',
    'Get all stocks reporting earnings on a specific date from Yahoo Finance. Returns company name, symbol, EPS estimate vs actual, surprise %, and call time (BMO = before market open, AMC = after market close). Defaults to today.',
    {
      date: z.string().optional().describe('Date in YYYY-MM-DD format (default: today)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default: 100)'),
    },
    async ({ date, limit }) => {
      try { return jsonResult(await core.getEarningsCalendar({ date, limit })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'news_scan_earnings',
    'Scan a list of stock symbols for upcoming earnings in the next N days. For each symbol with an upcoming earnings event, fetches EPS history and revenue growth from SEC EDGAR. Returns results sorted by earnings date. Use this when you want to monitor a watchlist for earnings.',
    {
      symbols: z.array(z.string()).describe('List of tickers to scan, e.g. ["AAPL","NVDA","MRVL","TSLA"]'),
      days_ahead: z.number().int().min(1).max(90).optional().describe('Look-ahead window in days (default: 14)'),
    },
    async ({ symbols, days_ahead }) => {
      try { return jsonResult(await core.scanEarnings({ symbols, days_ahead })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
