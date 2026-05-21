/**
 * regime-bot/config.js
 *
 * Central config for the Markov-gated SMA crossover bot. NO logic here —
 * just constants, basket definitions, and tunable parameters. Imported by
 * engine, cron, backtest, and tests so all share one source of truth.
 *
 * Per durable rule: every value here is defensible. Citations / rationale
 * in comments next to each block.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Basket ─────────────────────────────────────────────────────────────────
// Large-cap stocks (S&P 100 ⊂ S&P 500) verified present in backtest_prices.
// 101 stocks + 15 ETFs = 116 instruments.
//
// List current as of 2026-05-21. The S&P 100 is rebalanced quarterly by
// S&P Dow Jones Indices. Refresh: https://www.spglobal.com/spdji/en/indices/equity/sp-100/
//
// Excluded (not in backtest_prices today — re-run research:download to add):
//   MO, LOW, SLB, MMM, MMC, FDX, UPS

export const SP100 = [
  // Mega-cap technology
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'GOOG', 'AMZN', 'META', 'AVGO', 'ORCL', 'NFLX',
  // Berkshire + financials
  'BRK-B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'MS', 'GS', 'AXP', 'BLK',
  // Health care
  'LLY', 'UNH', 'JNJ', 'ABBV', 'MRK', 'TMO', 'ABT', 'PFE', 'AMGN', 'GILD',
  'BMY', 'DHR', 'MDT', 'CI', 'CVS', 'ELV', 'HCA', 'SYK',
  // Consumer staples + discretionary
  'WMT', 'PG', 'HD', 'COST', 'PEP', 'KO', 'MCD', 'PM', 'MDLZ',
  'TGT', 'SBUX', 'NKE', 'BKNG', 'TJX',
  // Energy + industrials
  'XOM', 'CVX', 'COP', 'EOG', 'PSX', 'OXY',
  'CAT', 'DE', 'BA', 'GE', 'HON', 'UNP', 'RTX', 'LMT', 'GD', 'EMR',
  // Software / cloud / chips
  'CRM', 'ADBE', 'AMD', 'INTC', 'QCOM', 'TXN', 'IBM', 'CSCO', 'NOW', 'AMAT',
  'LRCX', 'MU', 'INTU',
  // Real estate, utilities, communication
  'NEE', 'SO', 'DUK', 'AMT', 'PLD', 'EQIX',
  'T', 'VZ', 'DIS', 'CMCSA',
  // Other (broad coverage)
  'LIN', 'ACN', 'SPGI', 'PYPL', 'SCHW', 'ICE', 'CB', 'AON',
  'F', 'GM',
];

// 4 index ETFs + 11 SPDR Sector ETFs. Source-of-truth list also lives in
// src/research/download-etfs.js (the downloader uses it too) — keep these
// two in sync if either changes.
export const ETFS = [
  // Index ETFs
  'SPY', 'QQQ', 'IWM', 'DIA',
  // SPDR Sector ETFs (11 GICS sectors)
  'XLF', 'XLE', 'XLU', 'XLK', 'XLV',
  'XLI', 'XLB', 'XLP', 'XLY', 'XLRE', 'XLC',
];

export const TICKER_BASKET = [...SP100, ...ETFS];

// ─── Primary signal — SMA crossover ─────────────────────────────────────────
// 50/200 SMA crossover, long-only. Faber's "A Quantitative Approach to Tactical
// Asset Allocation" (2007) is the canonical reference. Used as primary because:
//   - well-understood, easy to debug
//   - infrequent flips → keeps Markov gate the dominant variable in measurement
//   - documented baseline Sharpe ~0.5-0.7 on SPY pre-costs over 50yr

export const PRIMARY_SIGNAL = {
  fast_sma_days:  50,
  slow_sma_days: 200,
  long_only:    true,           // no shorting in v1
};

// ─── Markov gate — invocation ───────────────────────────────────────────────
// We feed our DB-extracted price CSV to the vendored script via --csv.
// Window/threshold/min_train default to the script's defaults to keep
// regime classification consistent with the upstream paper's results.

export const MARKOV = {
  script_path: path.join(__dirname, 'vendor/markov/markov_regime.py'),
  uv_args:     ['run'],
  // Script-level params (passed through to markov_regime.py CLI)
  window_days:    20,
  threshold:      0.05,
  min_train_days: 252,
  // Subprocess controls
  timeout_ms:     60_000,
  max_retries:    1,
  // CSV staging
  csv_dir:        path.join(__dirname, '../../tmp/regime-prices'),
};

// ─── Gate logic ─────────────────────────────────────────────────────────────
// Binary gate. Bull → permit, anything else → block. Fail-closed.
// Rationale: the source repo's published walk-forward Sharpe is computed
// under Bull-only positioning; we mirror that policy.

export const GATE = {
  allowed_regimes: ['Bull'],       // case-sensitive (matches script output)
  fail_closed: true,               // unknown regime / subprocess error → BLOCK
  log_blocked: true,               // every block writes a regime_bot_decisions row
};

// ─── Execution / sizing ─────────────────────────────────────────────────────
// Top-N concurrent positions, fixed-$ per position. Avoids interference
// with B-3.7 positions on the same Alpaca paper account.
//
// $10K per position × 10 = $100K notional, matches default Alpaca paper buying power.

export const EXECUTION = {
  broker:                 'alpaca_paper',  // canonical account_source tag — matches existing convention
  max_concurrent:         10,              // top-N filter applied after gate pass
  position_size_usd:      10_000,
  signal_strength_metric: 'markov_signal_times_persistence',  // ranks gate-passing names
  cost_per_trade_bps:     5,               // round-trip; for backtest reproducibility
};

// ─── Cron schedules (America/New_York timezone) ─────────────────────────────
// All times ET. Cron runs in-process via node-cron.

export const CRON = {
  timezone: 'America/New_York',
  // Daily 4:05 PM ET — after close, prices settled. Refresh regime_cache for all 115 tickers.
  regime_refresh: '5 16 * * 1-5',
  // Daily 9:31 AM ET — primary signal + gate evaluation + trade execution.
  decision: '31 9 * * 1-5',
};

// ─── Backtest harness ───────────────────────────────────────────────────────
// Walk-forward across the full available history per instrument.
// ETFs have 5y, stocks have 3y. Backtest reports both.

export const BACKTEST = {
  // Start dates per data availability
  default_start_date: '2021-05-21',   // earliest in backtest_prices for ETFs
  stocks_start_date:  '2023-04-24',   // earliest for stocks
  cost_per_trade_bps: 5,
  initial_capital_usd: 100_000,
  // For Option A (top-N concurrent), backtest must enforce same constraint
  enforce_top_n_concurrent: true,
};

// ─── Failure / alerting ─────────────────────────────────────────────────────
// If Markov subprocess fails N consecutive times for the same ticker, emit
// an [ALERT]-tagged stderr line (visible in pm2 logs).

export const ALERTING = {
  consecutive_failure_threshold: 3,
  alert_log_path: path.join(__dirname, '../../data/regime-bot/alerts.jsonl'),
};

// ─── Sanity check — verify everything imported in same module style ─────────
export const VERSION = '0.1.0';

// Self-test on import: report any duplicate symbols or empty basket
const seen = new Set();
const dupes = [];
for (const sym of TICKER_BASKET) {
  if (seen.has(sym)) dupes.push(sym);
  seen.add(sym);
}
if (dupes.length) {
  console.warn(`[regime-bot/config] duplicate tickers in basket: ${dupes.join(', ')}`);
}
if (TICKER_BASKET.length < 100) {
  throw new Error(`[regime-bot/config] basket has only ${TICKER_BASKET.length} tickers, expected ≥100`);
}
