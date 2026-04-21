import { register } from '../router.js';
import * as core from '../../core/news.js';

register('news', {
  description: 'Market news, earnings, and financials tools',
  subcommands: new Map([
    ['headlines', {
      description: 'Get latest news headlines for a symbol',
      options: {
        symbol: { type: 'string', short: 's', description: 'Ticker symbol (e.g. MRVL)' },
        limit: { type: 'string', short: 'n', description: 'Number of articles (default: 10)' },
      },
      handler: (opts) => {
        if (!opts.symbol) throw new Error('--symbol is required');
        return core.getSymbolNews({ symbol: opts.symbol, limit: opts.limit ? Number(opts.limit) : 10 });
      },
    }],
    ['earnings', {
      description: 'Get earnings history and upcoming estimates for a symbol',
      options: {
        symbol: { type: 'string', short: 's', description: 'Ticker symbol (e.g. MRVL)' },
      },
      handler: (opts) => {
        if (!opts.symbol) throw new Error('--symbol is required');
        return core.getEarnings({ symbol: opts.symbol });
      },
    }],
    ['financials', {
      description: 'Get company financials: revenue, EPS, margins, analyst targets',
      options: {
        symbol: { type: 'string', short: 's', description: 'Ticker symbol (e.g. MRVL)' },
        period: { type: 'string', short: 'p', description: 'quarterly or annual (default: quarterly)' },
      },
      handler: (opts) => {
        if (!opts.symbol) throw new Error('--symbol is required');
        return core.getFinancials({ symbol: opts.symbol, period: opts.period || 'quarterly' });
      },
    }],
    ['filings', {
      description: 'Get recent SEC filings (8-K, 10-Q, 10-K)',
      options: {
        symbol: { type: 'string', short: 's', description: 'Ticker symbol (e.g. MRVL)' },
        form: { type: 'string', short: 'f', description: 'Form type: 8-K, 10-Q, 10-K (default: 8-K)' },
        limit: { type: 'string', short: 'n', description: 'Number of filings (default: 5)' },
      },
      handler: (opts) => {
        if (!opts.symbol) throw new Error('--symbol is required');
        return core.getFilings({ symbol: opts.symbol, form_type: opts.form || '8-K', limit: opts.limit ? Number(opts.limit) : 5 });
      },
    }],
    ['calendar', {
      description: 'Get earnings calendar for a date — all companies reporting that day',
      options: {
        date: { type: 'string', short: 'd', description: 'Date YYYY-MM-DD (default: today)' },
        limit: { type: 'string', short: 'n', description: 'Max results (default: 100)' },
      },
      handler: (opts) => {
        return core.getEarningsCalendar({ date: opts.date, limit: opts.limit ? Number(opts.limit) : 100 });
      },
    }],
    ['scan', {
      description: 'Scan multiple tickers for upcoming earnings within N days',
      options: {
        symbols: { type: 'string', short: 's', description: 'Comma-separated tickers: AAPL,NVDA,MRVL,TSLA' },
        days: { type: 'string', short: 'd', description: 'Look-ahead days (default: 14)' },
      },
      handler: (opts) => {
        if (!opts.symbols) throw new Error('--symbols is required (comma-separated, e.g. AAPL,NVDA,MRVL)');
        const symbols = opts.symbols.split(',').map(s => s.trim()).filter(Boolean);
        return core.scanEarnings({ symbols, days_ahead: opts.days ? Number(opts.days) : 14 });
      },
    }],
  ]),
});
