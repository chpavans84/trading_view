/**
 * tests/repositories.test.js
 *
 * Unit tests for src/repositories/*. We intercept the query() call from
 * db.js via dynamic-mock pattern and assert the SQL + params are correct.
 * No live DB required.
 *
 * Run: node --experimental-test-module-mocks --test tests/repositories.test.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

// Use module mocks so the repo's own `import { query }` is intercepted.
let _calls = [];

beforeEach(() => {
  _calls = [];
});

mock.module('../src/core/db.js', {
  namedExports: {
    query: (sql, params = []) => {
      _calls.push({ sql, params });
      // Return whatever the most recently set mock-return is
      return _nextReturn;
    },
    isDbAvailable: () => true,
  },
});

let _nextReturn = { rows: [] };
function setNextReturn(rows) { _nextReturn = { rows }; }

const botsRepo     = await import('../src/repositories/bots-repo.js');
const decisionRepo = await import('../src/repositories/bot-decisions-repo.js');

// ─── bots-repo: reads ────────────────────────────────────────────────────────
describe('bots-repo.getScannableBots', () => {
  it('selects active + paused_today, excludes soft-deleted', async () => {
    setNextReturn([{ id: 1 }, { id: 2 }]);
    const r = await botsRepo.getScannableBots();
    assert.equal(r.length, 2);
    assert.equal(_calls.length, 1);
    assert.match(_calls[0].sql, /WHERE status IN \('active','paused_today'\)/);
    assert.match(_calls[0].sql, /deleted_at IS NULL/);
  });
});

describe('bots-repo.getActiveBots', () => {
  it('selects only status=active', async () => {
    setNextReturn([{ id: 5 }]);
    const r = await botsRepo.getActiveBots();
    assert.equal(r[0].id, 5);
    assert.match(_calls[0].sql, /status = 'active'/);
    assert.match(_calls[0].sql, /deleted_at IS NULL/);
  });
});

describe('bots-repo.getOtherBotsHeldSymbols', () => {
  it('joins bots ⨝ trades and excludes the calling bot', async () => {
    setNextReturn([{ symbol: 'NVDA' }, { symbol: 'AAPL' }]);
    const r = await botsRepo.getOtherBotsHeldSymbols(42, 7);
    assert.deepEqual(r, ['NVDA', 'AAPL']);
    assert.match(_calls[0].sql, /JOIN trades t/);
    assert.match(_calls[0].sql, /b\.id <> \$2/);
    assert.deepEqual(_calls[0].params, [42, 7]);
  });

  it('returns empty array when no other bots hold anything', async () => {
    setNextReturn([]);
    const r = await botsRepo.getOtherBotsHeldSymbols(42, 7);
    assert.deepEqual(r, []);
  });
});

// ─── bots-repo: writes ───────────────────────────────────────────────────────
describe('bots-repo.tripCircuitBreaker', () => {
  it('sets status=stopped with message + timestamp', async () => {
    await botsRepo.tripCircuitBreaker(99, 'max loss reached');
    assert.match(_calls[0].sql, /SET status='stopped'/);
    assert.match(_calls[0].sql, /status_changed_at=NOW\(\)/);
    assert.deepEqual(_calls[0].params, ['max loss reached', 99]);
  });
});

describe('bots-repo.linkTrade', () => {
  it('sets current_trade_id', async () => {
    await botsRepo.linkTrade(7, 1234);
    assert.match(_calls[0].sql, /current_trade_id=\$1/);
    assert.deepEqual(_calls[0].params, [1234, 7]);
  });
});

describe('bots-repo.unlinkTrade', () => {
  it('clears current_trade_id', async () => {
    await botsRepo.unlinkTrade(7);
    assert.match(_calls[0].sql, /current_trade_id=NULL/);
    assert.deepEqual(_calls[0].params, [7]);
  });
});

describe('bots-repo.recordTradeClose', () => {
  it('increments counters with isWin=true', async () => {
    await botsRepo.recordTradeClose(7, { pnlUsd: 42.50, isWin: true });
    assert.match(_calls[0].sql, /winning_trades\s+= COALESCE/);
    assert.match(_calls[0].sql, /cumulative_pnl_usd\s+= COALESCE/);
    assert.deepEqual(_calls[0].params, [1, 42.50, 7]);
  });

  it('does not increment winning_trades on a loss', async () => {
    await botsRepo.recordTradeClose(7, { pnlUsd: -25, isWin: false });
    assert.deepEqual(_calls[0].params, [0, -25, 7]);
  });
});

// ─── bot-decisions-repo ─────────────────────────────────────────────────────
describe('bot-decisions-repo.recordDecision', () => {
  it('inserts with all fields populated and serializes thesis object as JSON', async () => {
    await decisionRepo.recordDecision({
      botId: 7,
      action: 'buy',
      symbol: 'NVDA',
      composite: 87.3,
      factorBreakdown: { signals: { rsi: 60 } },
      notes: 'test',
      setupType: 'momentum',
      thesis: { text: 'Strong trend', uwScore: 90 },
    });
    assert.match(_calls[0].sql, /INSERT INTO bot_decisions/);
    assert.equal(_calls[0].params[0], 7);
    assert.equal(_calls[0].params[1], 'buy');
    assert.equal(_calls[0].params[2], 'NVDA');
    assert.equal(_calls[0].params[3], 87.3);
    assert.equal(_calls[0].params[4], JSON.stringify({ signals: { rsi: 60 } }));
    assert.equal(_calls[0].params[6], 'momentum');
    assert.equal(_calls[0].params[7], JSON.stringify({ text: 'Strong trend', uwScore: 90 }));
  });

  it('passes nulls for skipped fields', async () => {
    await decisionRepo.recordDecision({
      botId: 7,
      action: 'skip_no_candidate',
    });
    assert.equal(_calls[0].params[2], null);  // symbol
    assert.equal(_calls[0].params[3], null);  // composite
    assert.equal(_calls[0].params[4], null);  // factor_breakdown
    assert.equal(_calls[0].params[7], null);  // thesis
  });

  it('passes through pre-serialized string thesis without re-encoding', async () => {
    await decisionRepo.recordDecision({
      botId: 7,
      action: 'buy',
      symbol: 'NVDA',
      thesis: '{"text":"already serialized"}',
    });
    assert.equal(_calls[0].params[7], '{"text":"already serialized"}');
  });
});

describe('bot-decisions-repo.getFreshestBuyDecision', () => {
  it('returns the row when present', async () => {
    setNextReturn([{ id: 99, symbol: 'NVDA', composite_score: 87 }]);
    const r = await decisionRepo.getFreshestBuyDecision(7, 6);
    assert.equal(r.symbol, 'NVDA');
    assert.match(_calls[0].sql, /WHERE bot_id = \$1/);
    assert.match(_calls[0].sql, /AND action = 'buy'/);
    assert.match(_calls[0].sql, /ORDER BY composite_score DESC/);
    assert.deepEqual(_calls[0].params, [7, 6]);
  });

  it('returns null when no fresh decision', async () => {
    setNextReturn([]);
    const r = await decisionRepo.getFreshestBuyDecision(7, 6);
    assert.equal(r, null);
  });
});
