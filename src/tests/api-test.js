/**
 * API Test Suite — Trading Bot Dashboard
 *
 * Tests every endpoint for both Alpaca (paper) and Moomoo (real) sources.
 * Run: node --env-file=.env src/tests/api-test.js
 *
 * The test runner authenticates once, then exercises every route and
 * asserts correctness of shape, types, and source-isolation.
 */

const BASE = `http://localhost:${process.env.DASHBOARD_PORT || 3000}`;
const PASS = process.env.DASHBOARD_PASSWORD || 'admin';

// ─── Mini test framework ──────────────────────────────────────────────────────

let _passed = 0, _failed = 0, _skipped = 0;
const results = [];

function pass(label) {
  _passed++;
  results.push({ status: 'PASS', label });
  process.stdout.write(`  ✅ ${label}\n`);
}
function fail(label, reason) {
  _failed++;
  results.push({ status: 'FAIL', label, reason });
  process.stdout.write(`  ❌ ${label}\n     → ${reason}\n`);
}
function skip(label, reason) {
  _skipped++;
  results.push({ status: 'SKIP', label, reason });
  process.stdout.write(`  ⚠️  ${label} (skipped: ${reason})\n`);
}
function section(title) {
  process.stdout.write(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}\n`);
}

function assert(condition, label, reason) {
  condition ? pass(label) : fail(label, reason || 'assertion failed');
}
function assertType(val, type, label) {
  assert(typeof val === type, label, `expected ${type}, got ${typeof val} (${JSON.stringify(val)?.slice(0,60)})`);
}
function assertArray(val, label) {
  assert(Array.isArray(val), label, `expected array, got ${typeof val}`);
}
function assertRange(val, min, max, label) {
  assert(typeof val === 'number' && val >= min && val <= max, label,
    `expected number in [${min}, ${max}], got ${val}`);
}
function assertOneOf(val, options, label) {
  assert(options.includes(val), label, `expected one of ${JSON.stringify(options)}, got ${JSON.stringify(val)}`);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

let _cookie = '';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: _cookie },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) _cookie = setCookie.split(';')[0];
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

const GET  = (path)       => request('GET',  path);
const POST = (path, body) => request('POST', path, body);

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function login() {
  const { status, data } = await POST('/auth/login', { password: PASS });
  if (status !== 200 || !data?.ok) throw new Error(`Login failed: ${status} ${JSON.stringify(data)}`);
}

// ─── Individual test groups ───────────────────────────────────────────────────

async function testAuth() {
  section('Authentication');

  // Correct password
  const good = await POST('/auth/login', { password: PASS });
  assert(good.status === 200 && good.data?.ok === true, 'POST /auth/login correct password → 200 ok');

  // Wrong password
  const bad = await POST('/auth/login', { password: 'wrongpassword_xyz' });
  assert(bad.status === 401, 'POST /auth/login wrong password → 401');

  // Protected route without auth
  const tmpCookie = _cookie;
  _cookie = '';
  const unauth = await GET('/api/home');
  assert(unauth.status === 401, 'GET /api/home without auth → 401');
  _cookie = tmpCookie;

  // Re-login so remaining tests work
  await login();
  pass('Re-login for remaining tests');
}

async function testHome() {
  section('Home Tab  (/api/home)');
  const { status, data } = await GET('/api/home');
  assert(status === 200, 'GET /api/home → 200');
  if (!data) { fail('response body present', 'null response'); return; }

  assertArray(data.news,     'news is array');
  assertArray(data.earnings, 'earnings is array');

  if (data.news.length > 0) {
    const a = data.news[0];
    assertType(a.title,     'string', 'news[0].title is string');
    assertType(a.source,    'string', 'news[0].source is string');
    assertType(a.published, 'string', 'news[0].published is string');
    assertType(a.category,  'string', 'news[0].category is string');
    const validCats = ['geopolitical','earnings','macro','energy','tech','crypto','markets'];
    assertOneOf(a.category, validCats, `news[0].category "${a.category}" is valid`);
    assert(!isNaN(new Date(a.published)), 'news[0].published is valid date');
  } else {
    skip('news item field validation', 'news array is empty');
  }

  if (data.earnings.length > 0) {
    const e = data.earnings[0];
    assertType(e.symbol, 'string', 'earnings[0].symbol is string');
    assertType(e.company, 'string', 'earnings[0].company is string');
    assert(e.call_time !== undefined, 'earnings[0].call_time field present');
  } else {
    skip('earnings item field validation', 'no earnings today (weekend/holiday)');
  }
}

async function testMarketStatus() {
  section('Market Status  (/api/market-status)');
  const { status, data } = await GET('/api/market-status');
  assert(status === 200, 'GET /api/market-status → 200');
  if (!data) { fail('response body present', 'null response'); return; }
  assertType(data.is_open, 'boolean', 'is_open is boolean');
  assert(data.next_open  !== undefined, 'next_open field present');
  assert(data.next_close !== undefined, 'next_close field present');
}

async function testMarket() {
  section('Market Tab  (/api/market)');
  const { status, data } = await GET('/api/market');
  assert(status === 200, 'GET /api/market → 200');
  if (!data) { fail('response body present', 'null response'); return; }

  // Sentiment
  if (data.sentiment) {
    const s = data.sentiment;
    assert(s.vix !== undefined,      'sentiment.vix present');
    assert(s.indices !== undefined,  'sentiment.indices present');
    if (s.vix?.value != null)
      assertRange(s.vix.value, 0, 200, `VIX value ${s.vix.value} in plausible range`);
  } else {
    skip('sentiment field validation', 'sentiment unavailable');
  }

  // Sectors
  if (data.sectors?.sectors?.length > 0) {
    const sec = data.sectors.sectors[0];
    assert(sec.sector !== undefined, 'sector.sector name present');
    assert(sec.chg_pct !== undefined, 'sector.chg_pct present');
    assertRange(sec.chg_pct, -30, 30, `sector chg_pct ${sec.chg_pct} in plausible range`);
  } else {
    skip('sector field validation', 'sectors unavailable');
  }

  // Movers
  if (data.movers?.gainers?.length > 0) {
    const m = data.movers.gainers[0];
    assertType(m.symbol, 'string', 'mover.symbol is string');
    assert(m.price > 0, `mover.price ${m.price} > 0`);
  } else {
    skip('movers field validation', 'no movers data');
  }
}

async function testDashboardAlpaca() {
  section('Dashboard Tab — Alpaca  (/api/dashboard?source=alpaca)');
  const { status, data } = await GET('/api/dashboard?source=alpaca');
  assert(status === 200, 'GET /api/dashboard?source=alpaca → 200');
  if (!data) { fail('response body present', 'null response'); return; }

  assertOneOf(data.source, ['alpaca'], 'response.source === "alpaca"');
  assertArray(data.positions, 'positions is array');
  assertArray(data.recent_trades, 'recent_trades is array');

  if (data.account) {
    assert(data.account.portfolio_value > 0, `portfolio_value ${data.account.portfolio_value} > 0`);
    assertRange(data.account.portfolio_value, 100, 10_000_000, 'portfolio_value in plausible range');
    assert(data.account.buying_power >= 0, `buying_power ${data.account.buying_power} >= 0`);
    assertOneOf(data.account.source, ['alpaca'], 'account.source === "alpaca"');
  } else {
    fail('account object present', 'account is null — Alpaca connection failed');
  }

  // Alpaca should have daily P&L
  if (data.pnl) {
    assertType(data.pnl.pnl, 'number', 'pnl.pnl is number');
    assertRange(data.pnl.pnl, -100_000, 100_000, 'pnl.pnl in plausible range');
  } else {
    skip('Alpaca P&L validation', 'pnl null (market may be closed)');
  }

  // recent_trades must NOT have moomoo source
  const moomooLeakage = data.recent_trades.filter(t => t.source === 'moomoo');
  assert(moomooLeakage.length === 0, 'Alpaca recent_trades contain no Moomoo data (no cross-contamination)');

  // positions shape
  if (data.positions.length > 0) {
    const p = data.positions[0];
    assertType(p.symbol, 'string', 'position.symbol is string');
    assert(p.qty > 0, `position.qty ${p.qty} > 0`);
    assert(p.current_price > 0, `position.current_price ${p.current_price} > 0`);
  }
}

async function testDashboardMoomoo() {
  section('Dashboard Tab — Moomoo  (/api/dashboard?source=moomoo)');
  const { status, data } = await GET('/api/dashboard?source=moomoo');

  if (status !== 200) {
    skip('Moomoo dashboard tests', `HTTP ${status} — OpenD may be offline`);
    return;
  }
  if (!data) { fail('response body present', 'null response'); return; }

  assertOneOf(data.source, ['moomoo'], 'response.source === "moomoo"');
  assertArray(data.positions, 'positions is array');
  assertArray(data.recent_trades, 'recent_trades is array');

  if (data.account) {
    assertOneOf(data.account.source, ['moomoo'], 'account.source === "moomoo"');
    assert(data.account.portfolio_value > 0, `portfolio_value ${data.account.portfolio_value} > 0`);
    // Sanity: Moomoo portfolio should be in USD now (not HKD inflated)
    assertRange(data.account.portfolio_value, 1_000, 500_000,
      `portfolio_value ${data.account.portfolio_value} in USD range (not HKD-inflated)`);
    assert(data.account.buying_power >= 0, `buying_power ${data.account.buying_power} >= 0`);
  } else {
    fail('account object present', 'account is null — Moomoo connection failed');
  }

  // CRITICAL: Moomoo P&L should be null (we don't track Alpaca paper P&L for Moomoo)
  assert(data.pnl === null, 'Moomoo pnl is null (Alpaca P&L must NOT bleed into Moomoo view)');

  // CRITICAL: recent_trades must be Moomoo orders, not Alpaca paper trades
  const alpacaLeakage = data.recent_trades.filter(t =>
    t.source === 'db' || t.atr_pct !== undefined || t.conviction_score !== undefined
  );
  assert(alpacaLeakage.length === 0, 'Moomoo recent_trades contain no Alpaca paper trade fields');

  if (data.recent_trades.length > 0) {
    const t = data.recent_trades[0];
    assertType(t.symbol,  'string', 'moomoo trade.symbol is string');
    assertOneOf(t.side, ['buy','sell'], `moomoo trade.side "${t.side}" is buy or sell`);
    assert(t.source === 'moomoo', 'moomoo trade.source === "moomoo"');
  }

  // Moomoo positions shape
  if (data.positions.length > 0) {
    const p = data.positions[0];
    assertType(p.symbol, 'string', 'moomoo position.symbol is string');
    assert(p.qty > 0, `moomoo position.qty ${p.qty} > 0`);
    assert(p.current_price > 0, `moomoo position.current_price ${p.current_price} > 0`);
    assert(p.unrealized_pl !== undefined, 'moomoo position.unrealized_pl present');
  }
}

async function testTradesAlpaca() {
  section('Trades Tab — Alpaca  (/api/trades?source=alpaca)');
  const { status, data } = await GET('/api/trades?source=alpaca');
  assert(status === 200, 'GET /api/trades?source=alpaca → 200');
  if (!data) { fail('response body present', 'null response'); return; }

  assertArray(data.trades, 'trades is array');
  assertOneOf(data.source, ['db','alpaca_live'], 'source is db or alpaca_live (not moomoo)');

  if (data.trades.length > 0) {
    const t = data.trades[0];
    assertType(t.symbol, 'string', 'trade.symbol is string');
    assertOneOf(t.side, ['buy','sell'], `trade.side "${t.side}" is valid`);
    assert(t.source !== 'moomoo', 'Alpaca trades do not contain Moomoo entries');
  }
}

async function testTradesMoomoo() {
  section('Trades Tab — Moomoo  (/api/trades?source=moomoo)');
  const { status, data } = await GET('/api/trades?source=moomoo');

  if (status !== 200) {
    skip('Moomoo trades tests', `HTTP ${status} — OpenD may be offline`);
    return;
  }
  if (!data) { fail('response body present', 'null response'); return; }

  assertOneOf(data.source, ['moomoo'], 'source === "moomoo"');
  assertArray(data.trades, 'trades is array');

  // CRITICAL: must not contain Alpaca paper trade fields
  if (data.trades.length > 0) {
    const t = data.trades[0];
    assertType(t.symbol, 'string', 'moomoo trade.symbol is string');
    assertOneOf(t.side, ['buy','sell'], `moomoo trade.side "${t.side}" is valid`);
    assert(t.atr_pct === null || t.atr_pct === undefined,
      'Moomoo trades do not have atr_pct (Alpaca paper field)');
    assert(t.conviction_grade === null || t.conviction_grade === undefined,
      'Moomoo trades do not have conviction_grade (Alpaca paper field)');
    assertOneOf(t.source, ['moomoo'], 'trade.source === "moomoo"');
  } else {
    skip('Moomoo trade field validation', 'no order history returned');
  }
}

async function testPositions() {
  section('Positions  (/api/positions)');

  // Alpaca
  const alp = await GET('/api/positions?source=alpaca');
  assert(alp.status === 200, 'GET /api/positions?source=alpaca → 200');
  assertOneOf(alp.data?.source, ['alpaca'], 'alpaca positions source correct');
  assertArray(alp.data?.positions, 'alpaca positions is array');

  // Moomoo
  const moo = await GET('/api/positions?source=moomoo');
  if (moo.status !== 200) {
    skip('Moomoo positions tests', `HTTP ${moo.status} — OpenD may be offline`);
  } else {
    assertOneOf(moo.data?.source, ['moomoo'], 'moomoo positions source correct');
    assertArray(moo.data?.positions, 'moomoo positions is array');

    // CRITICAL: same symbol must not appear twice (deduplication)
    const syms = moo.data.positions.map(p => p.symbol);
    const unique = new Set(syms);
    assert(syms.length === unique.size,
      `No duplicate symbols in Moomoo positions (found ${syms.length} entries, ${unique.size} unique)`);
  }
}

async function testScores() {
  section('Scores Tab  (/api/scores)');
  const { status, data } = await GET('/api/scores');
  assert(status === 200, 'GET /api/scores → 200');
  if (!data) { fail('response body present', 'null response'); return; }

  assertArray(data.scores, 'scores is array');

  if (data.scores.length > 0) {
    const s = data.scores[0];
    assertType(s.symbol, 'string', 'score.symbol is string');
    assertRange(s.score, 0, 100, `score.score ${s.score} in 0-100 range`);
    assertOneOf(s.grade, ['A','B','C','F'], `score.grade "${s.grade}" is valid`);

    // Grade must match score
    const expectedGrade =
      s.score >= 75 ? 'A' : s.score >= 55 ? 'B' : s.score >= 35 ? 'C' : 'F';
    assert(s.grade === expectedGrade,
      `Grade "${s.grade}" consistent with score ${s.score} (expected "${expectedGrade}")`);

    // No duplicate symbols
    const syms = data.scores.map(x => x.symbol);
    const unique = new Set(syms);
    assert(syms.length === unique.size,
      `No duplicate symbols in scores (${syms.length} rows, ${unique.size} unique)`);
  } else {
    skip('scores field validation', 'no scores in DB — run a scan first');
  }
}

async function testStats() {
  section('Stats Tab  (/api/stats/detail)');
  const { status, data } = await GET('/api/stats/detail');
  assert(status === 200, 'GET /api/stats/detail → 200');
  if (!data) { fail('response body present', 'null response'); return; }

  assert(data.summary !== undefined || data.detail !== undefined, 'stats response has summary or detail');
}

async function testEarningsTrend() {
  section('Earnings Trend  (/api/earnings-trend)');

  // Empty symbols
  const empty = await GET('/api/earnings-trend?symbols=');
  assert(empty.status === 200, 'GET /api/earnings-trend?symbols= → 200 (empty returns {})');

  // Single known symbol
  const { status, data } = await GET('/api/earnings-trend?symbols=AAPL');
  assert(status === 200, 'GET /api/earnings-trend?symbols=AAPL → 200');
  if (data?.AAPL) {
    assertArray(data.AAPL, 'AAPL trend is array');
    if (data.AAPL.length > 0) {
      const q = data.AAPL[0];
      assertType(q.period, 'string', 'trend quarter.period is string');
      assert(q.beat === true || q.beat === false || q.beat === null,
        `trend quarter.beat is boolean or null (got ${q.beat})`);
    }
  } else {
    skip('AAPL trend field validation', 'EDGAR may be slow or unavailable');
  }
}

async function testDataIsolation() {
  section('Cross-Source Data Isolation (Critical)');

  // Fetch both dashboard responses simultaneously
  const [alpRes, mooRes] = await Promise.all([
    GET('/api/dashboard?source=alpaca'),
    GET('/api/dashboard?source=moomoo'),
  ]);

  if (alpRes.status === 200 && mooRes.status === 200) {
    const alpAcc = alpRes.data?.account;
    const mooAcc = mooRes.data?.account;

    // Portfolio values must differ (different accounts)
    if (alpAcc && mooAcc) {
      assert(alpAcc.portfolio_value !== mooAcc.portfolio_value,
        `Alpaca ($${alpAcc.portfolio_value}) and Moomoo ($${mooAcc.portfolio_value}) portfolio values differ`);
    }

    // Positions must not be identical lists
    const alpSyms = new Set((alpRes.data?.positions || []).map(p => p.symbol));
    const mooSyms = new Set((mooRes.data?.positions || []).map(p => p.symbol));
    // They MIGHT overlap (same stock in both), but sources must differ
    assert(alpRes.data?.source !== mooRes.data?.source, 'Source field differs between accounts');

    // Moomoo must NOT return Alpaca pnl
    assert(mooRes.data?.pnl === null,
      `Moomoo response.pnl is null, not Alpaca P&L (got: ${JSON.stringify(mooRes.data?.pnl)})`);
  } else {
    skip('cross-source isolation', `Alpaca: ${alpRes.status}, Moomoo: ${mooRes.status}`);
  }
}

async function testCurrencyIntegrity() {
  section('Currency Integrity (Moomoo must be USD not HKD)');
  const { status, data } = await GET('/api/dashboard?source=moomoo');
  if (status !== 200) { skip('Currency check', 'Moomoo offline'); return; }

  if (data?.account?.portfolio_value) {
    const val = data.account.portfolio_value;
    // If value > 200K it's almost certainly HKD (the bug we fixed)
    assert(val < 200_000,
      `Portfolio value $${val.toFixed(2)} < $200K — not HKD-inflated (bug check)`);
    // Sanity lower bound
    assert(val > 500,
      `Portfolio value $${val.toFixed(2)} > $500 — not zero or negative`);
  } else {
    skip('Currency integrity', 'No account data');
  }
}

// ─── Main runner ──────────────────────────────────────────────────────────────

async function run() {
  console.log('═'.repeat(64));
  console.log(' Trading Bot Dashboard — API Test Suite');
  console.log(` Server: ${BASE}`);
  console.log(' Time:  ', new Date().toISOString());
  console.log('═'.repeat(64));

  await login();

  await testAuth();
  await testHome();
  await testMarketStatus();
  await testMarket();
  await testDashboardAlpaca();
  await testDashboardMoomoo();
  await testTradesAlpaca();
  await testTradesMoomoo();
  await testPositions();
  await testScores();
  await testStats();
  await testEarningsTrend();
  await testDataIsolation();
  await testCurrencyIntegrity();

  // ── Summary ────────────────────────────────────────────
  const total = _passed + _failed + _skipped;
  console.log('\n' + '═'.repeat(64));
  console.log(` Results: ${total} tests`);
  console.log(`   ✅ Passed:  ${_passed}`);
  if (_failed  > 0) console.log(`   ❌ Failed:  ${_failed}`);
  if (_skipped > 0) console.log(`   ⚠️  Skipped: ${_skipped}`);
  console.log('═'.repeat(64));

  if (_failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ❌ ${r.label}\n     → ${r.reason}`);
    });
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed.\n');
    process.exit(0);
  }
}

run().catch(err => {
  console.error('\n💥 Test runner crashed:', err.message);
  process.exit(2);
});
