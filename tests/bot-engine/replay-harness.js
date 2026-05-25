/**
 * tests/bot-engine/replay-harness.js
 *
 * CLI entry for the replay harness.
 *
 * Run:
 *   node --env-file=.env tests/bot-engine/replay-harness.js \
 *     --strategy sma-cross --from 2023-04-01 --to 2026-05-22 \
 *     --symbols SPY,QQQ,AAPL,NVDA,MSFT
 *
 * Strategies:
 *   - buy-and-hold       — long SPY whole window
 *   - sma-cross          — 50/200 SMA cross long-only
 *   - sma-cross-20-100   — faster trend (passes opts to factory)
 *
 * Output:
 *   - stdout: top-line stats
 *   - reports/replay-<strategy>-<timestamp>.md  — full report with trade ledger
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBacktest } from './replay-engine.js';
import { summarize } from './analytics/metrics.js';
import { buyAndHoldStrategy, resetBuyAndHold } from './strategies/buy-and-hold.js';
import { smaCrossStrategy, makeSmaCrossStrategy } from './strategies/sma-cross.js';
import { b37MomentumStrategy } from './strategies/b37-momentum.js';
import { b37MeanReversionStrategy } from './strategies/b37-mean-reversion.js';
import { regimeGatedStrategy } from './strategies/regime-gated.js';
import { b37MomentumV2Strategy } from './strategies/b37-momentum-v2.js';
import { b37MeanReversionV2Strategy } from './strategies/b37-mean-reversion-v2.js';
import { regimeGatedSoftStrategy } from './strategies/regime-gated-soft.js';
import { b37MomentumProdAlignedStrategy } from './strategies/b37-momentum-prod-aligned.js';
import { dayTradeStrategy, makeDayTradeStrategy } from './strategies/day-trade.js';
import { priceBreakoutStrategy, makePriceBreakoutStrategy } from './strategies/price-breakout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_BASKET = [
  // Index ETFs
  'SPY', 'QQQ', 'IWM', 'DIA',
  // Sector ETFs
  'XLF', 'XLE', 'XLU', 'XLK', 'XLV', 'XLI', 'XLB', 'XLP', 'XLY', 'XLRE', 'XLC',
  // SP100 large-caps
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'GOOG', 'AMZN', 'META', 'AVGO', 'ORCL', 'NFLX',
  'BRK-B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'MS', 'GS', 'AXP', 'BLK',
  'LLY', 'UNH', 'JNJ', 'ABBV', 'MRK', 'TMO', 'ABT', 'PFE', 'AMGN', 'GILD',
  'BMY', 'DHR', 'MDT', 'CI', 'CVS', 'ELV', 'HCA', 'SYK',
  'WMT', 'PG', 'HD', 'COST', 'PEP', 'KO', 'MCD', 'PM', 'MDLZ',
  'TGT', 'SBUX', 'NKE', 'BKNG', 'TJX',
  'XOM', 'CVX', 'COP', 'EOG', 'PSX', 'OXY',
  'CAT', 'DE', 'BA', 'GE', 'HON', 'UNP', 'RTX', 'LMT', 'GD', 'EMR',
  'CRM', 'ADBE', 'AMD', 'INTC', 'QCOM', 'TXN', 'IBM', 'CSCO', 'NOW', 'AMAT',
  'LRCX', 'MU', 'INTU',
  'NEE', 'SO', 'DUK', 'AMT', 'PLD', 'EQIX',
  'T', 'VZ', 'DIS', 'CMCSA',
  'LIN', 'ACN', 'SPGI', 'PYPL', 'SCHW', 'ICE', 'CB', 'AON',
  'F', 'GM',
];

// ─── CLI parsing ────────────────────────────────────────────────────────────
function parseArgs() {
  const args = { strategy: 'sma-cross', from: null, to: null, symbols: null,
                  maxPositions: 10, positionSizeUsd: 10_000, slippageBps: 5,
                  initialCapital: 100_000, verbose: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strategy')         args.strategy = argv[++i];
    else if (a === '--from')        args.from = argv[++i];
    else if (a === '--to')          args.to = argv[++i];
    else if (a === '--symbols')     args.symbols = argv[++i].split(',').map(s => s.trim().toUpperCase());
    else if (a === '--max-pos')     args.maxPositions = +argv[++i];
    else if (a === '--size')        args.positionSizeUsd = +argv[++i];
    else if (a === '--slippage')    args.slippageBps = +argv[++i];
    else if (a === '--capital')     args.initialCapital = +argv[++i];
    else if (a === '--verbose')     args.verbose = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  if (!args.from || !args.to) {
    console.error('ERROR: --from and --to are required');
    printHelp();
    process.exit(1);
  }
  return args;
}

function printHelp() {
  console.log(`
Backtest replay harness

Usage:
  node --env-file=.env tests/bot-engine/replay-harness.js [options]

Required:
  --from YYYY-MM-DD     Start date (inclusive)
  --to YYYY-MM-DD       End date (inclusive)

Optional:
  --strategy NAME       'buy-and-hold' | 'sma-cross' | 'sma-cross-20-100' (default sma-cross)
  --symbols S1,S2,...   Comma-separated tickers (default: SP100 + 15 ETFs)
  --max-pos N           Max concurrent positions (default 10)
  --size USD            \$ per position (default 10000)
  --slippage BPS        Slippage per leg (default 5)
  --capital USD         Initial capital (default 100000)
  --verbose             Print progress
  --help                This message

Outputs a markdown report to reports/replay-<strategy>-<timestamp>.md
`);
}

// ─── Strategy registry ──────────────────────────────────────────────────────
function getStrategy(name) {
  if (name === 'buy-and-hold')        { resetBuyAndHold(); return buyAndHoldStrategy; }
  if (name === 'sma-cross')           return smaCrossStrategy;
  if (name === 'sma-cross-20-100')    return makeSmaCrossStrategy({ fast: 20, slow: 100 });
  if (name === 'b37-momentum')        return b37MomentumStrategy;
  if (name === 'b37-mean-reversion')  return b37MeanReversionStrategy;
  if (name === 'regime-gated')        return regimeGatedStrategy;
  if (name === 'b37-momentum-v2')      return b37MomentumV2Strategy;
  if (name === 'b37-mean-reversion-v2') return b37MeanReversionV2Strategy;
  if (name === 'regime-gated-soft')    return regimeGatedSoftStrategy;
  if (name === 'b37-momentum-prod-aligned') return b37MomentumProdAlignedStrategy;
  if (name === 'day-trade')                 return dayTradeStrategy;
  if (name === 'day-trade-tight')           return makeDayTradeStrategy({ tpPct: 0.02, slPct: 0.015 });
  if (name === 'day-trade-loose')           return makeDayTradeStrategy({ tpPct: 0.05, slPct: 0.03 });
  if (name === 'price-breakout')            return priceBreakoutStrategy;
  if (name === 'price-breakout-tight')      return makePriceBreakoutStrategy({ entry5dReturn: 0.08, stopPct: -0.06 });
  if (name === 'price-breakout-loose')      return makePriceBreakoutStrategy({ entry5dReturn: 0.03, stopPct: -0.10 });
  throw new Error(`unknown strategy: ${name}`);
}

// ─── Report writer ──────────────────────────────────────────────────────────
function fmtPct(x) { return (x * 100).toFixed(2) + '%'; }
function fmtUsd(x) { return '$' + Number(x).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}); }

async function writeReport(strategyName, args, summary, result) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `replay-${strategyName}-${ts}.md`;
  const outPath = path.join(PROJECT_ROOT, 'reports', fileName);

  const md = [];
  md.push(`# Backtest Replay — ${strategyName}`);
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push('');

  md.push('## Configuration');
  md.push('');
  md.push(`- Window: **${summary.period.start} → ${summary.period.end}** (${summary.period.years} years)`);
  md.push(`- Universe: ${result.config.universe_size} symbols`);
  md.push(`- Initial capital: ${fmtUsd(summary.returns.initial_capital_usd)}`);
  md.push(`- Max concurrent positions: ${result.config.max_positions}`);
  md.push(`- Position size: ${fmtUsd(result.config.position_size_usd)}`);
  md.push(`- Slippage: ${result.config.slippage_bps} bps per leg`);
  md.push('');

  md.push('## Headline');
  md.push('');
  md.push('| Metric | Value |');
  md.push('|---|---|');
  md.push(`| Total return | **${summary.returns.total_return_pct}%** |`);
  md.push(`| Final value | ${fmtUsd(summary.returns.final_value_usd)} |`);
  md.push(`| CAGR | ${summary.returns.cagr_pct}% |`);
  md.push(`| Sharpe (rf=0) | **${summary.risk.sharpe}** |`);
  md.push(`| Max drawdown | ${summary.risk.max_drawdown_pct}% |`);
  md.push(`| Calmar | ${summary.risk.calmar} |`);
  md.push(`| Total trades | ${summary.trades.total_trades} |`);
  md.push(`| Win rate | **${fmtPct(summary.trades.win_rate)}** |`);
  md.push(`| Profit factor | ${summary.trades.profit_factor === Infinity ? '∞' : summary.trades.profit_factor.toFixed(2)} |`);
  md.push(`| Avg hold | ${summary.trades.avg_hold_days.toFixed(1)} days |`);
  md.push(`| Avg winner | ${fmtUsd(summary.trades.avg_winner)} |`);
  md.push(`| Avg loser | ${fmtUsd(summary.trades.avg_loser)} |`);
  md.push(`| Best trade | ${fmtUsd(summary.trades.best_trade)} |`);
  md.push(`| Worst trade | ${fmtUsd(summary.trades.worst_trade)} |`);
  md.push('');

  // Trade ledger
  md.push('## Trade ledger (most recent 30)');
  md.push('');
  if (!result.trades.length) {
    md.push('_No trades executed._');
  } else {
    md.push('| Symbol | Side | Qty | Entry | Exit | Hold (days) | PnL ($) | PnL (%) | Reason |');
    md.push('|---|---|---|---|---|---|---|---|---|');
    const recent = result.trades.slice(-30);
    for (const t of recent) {
      md.push(`| ${t.symbol} | long | ${t.qty} | $${t.entry_price.toFixed(2)} | $${t.exit_price.toFixed(2)} | ${t.hold_days.toFixed(1)} | ${t.pnl_usd >= 0 ? '+' : ''}${t.pnl_usd.toFixed(2)} | ${(t.pnl_pct * 100).toFixed(2)}% | ${t.exit_reason} |`);
    }
  }
  md.push('');

  // Equity curve sample
  md.push('## Equity curve (sampled)');
  md.push('');
  const eq = result.equityCurve;
  const sampleN = Math.min(30, eq.length);
  const stride = Math.max(1, Math.floor(eq.length / sampleN));
  md.push('```');
  for (let i = 0; i < eq.length; i += stride) {
    const v = eq[i];
    const bar = '█'.repeat(Math.round((v / summary.returns.initial_capital_usd) * 30));
    md.push(`${String(i).padStart(4)}: ${fmtUsd(v).padStart(14)} ${bar}`);
  }
  md.push('```');

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, md.join('\n') + '\n');

  // Write a JSON sidecar so the dashboard's /api/backtests can serve runs
  // without re-parsing markdown. Filename matches the .md (same stem).
  const jsonPath = outPath.replace(/\.md$/, '.json');
  const jsonDoc = {
    id:           path.basename(outPath, '.md'),
    strategy:     strategyName,
    generated_at: new Date().toISOString(),
    args: {
      from:               args.from,
      to:                 args.to,
      symbols:            args.symbols,
      max_positions:      args.maxPositions,
      position_size_usd:  args.positionSizeUsd,
      slippage_bps:       args.slippageBps,
      initial_capital:    args.initialCapital,
    },
    config:       result.config,
    summary,
    trades:       result.trades,
    equity_curve: result.equityCurve,
  };
  await fs.writeFile(jsonPath, JSON.stringify(jsonDoc));
  return outPath;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs();
  const strategy = getStrategy(args.strategy);
  const universe = args.symbols ?? DEFAULT_BASKET;

  console.log(`[harness] strategy=${args.strategy}  universe=${universe.length}  ${args.from} → ${args.to}`);

  const result = await runBacktest({
    startDate: args.from, endDate: args.to,
    universe, strategy,
    initialCapital: args.initialCapital,
    maxPositions: args.maxPositions,
    positionSizeUsd: args.positionSizeUsd,
    slippageBps: args.slippageBps,
    verbose: args.verbose,
  });

  const summary = summarize(result);

  // Stdout headline
  console.log('');
  console.log(`Period:       ${summary.period.start} → ${summary.period.end}  (${summary.period.years}y)`);
  console.log(`Total return: ${summary.returns.total_return_pct}%`);
  console.log(`CAGR:         ${summary.returns.cagr_pct}%`);
  console.log(`Sharpe:       ${summary.risk.sharpe}`);
  console.log(`Max DD:       ${summary.risk.max_drawdown_pct}%`);
  console.log(`Trades:       ${summary.trades.total_trades}  (WR ${(summary.trades.win_rate * 100).toFixed(1)}%)`);

  const reportPath = await writeReport(args.strategy, args, summary, result);
  console.log(`\nFull report: ${reportPath}`);
}

main().catch(err => {
  console.error('[harness fatal]', err);
  process.exit(1);
});
