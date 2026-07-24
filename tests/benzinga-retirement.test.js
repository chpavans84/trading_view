/**
 * Regression tests for the Benzinga retirement (subscription cancelled 2026-07-14).
 *
 * THE BUG: scoring.js fetched Benzinga news/earnings and, on an HTTP error, did
 * `if (!r.ok) return null`. The caller guards with `.catch(() => getSymbolNews(...))` —
 * but a resolved null FULFILLS the promise, so the `.catch()` never runs and the Yahoo
 * fallback sat unreachable. When the subscription lapsed (HTTP 401), every scored symbol
 * silently lost its beat-streak (+25) and guidance (+15) credit. The scores were not merely
 * "less informed" — they were skewed DOWN, with a working fallback sitting right there.
 *
 * The invariant: a dead vendor must degrade to the FALLBACK, never to a silent zero.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scoringSrc = readFileSync(path.join(ROOT, 'src/core/scoring.js'), 'utf8');

// Isolate the two Benzinga wrapper bodies. Scoped deliberately: getRVOL/getWeeklyTrend also
// do `if (!r.ok) return null`, and that is CORRECT there — they have no .catch() fallback
// chain, so null simply means "no data" and the factor drops out. The bug is specific to a
// wrapper whose caller guards it with `.catch(() => <fallback>)`.
const bzBody = (name) => {
  const start = scoringSrc.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in scoring.js`);
  const next = scoringSrc.indexOf('\nasync function ', start + 1);
  return scoringSrc.slice(start, next === -1 ? undefined : next);
};

describe('vendor wrappers must THROW, not resolve null (else .catch fallbacks are dead)', () => {
  test('getBenzingaNews rejects on a non-OK response', () => {
    const body = bzBody('getBenzingaNews');
    // The exact shape of the bug. If this line ever comes back, the Yahoo fallback silently dies.
    assert.ok(
      !/if\s*\(!r\.ok\)\s*return\s+null/.test(body),
      'getBenzingaNews must not `return null` on !r.ok — it fulfils the promise and skips the .catch() fallback'
    );
    assert.ok(
      /if\s*\(!r\.ok\)\s*throw\s+new\s+Error\(`benzinga news/.test(body),
      'getBenzingaNews must throw on !r.ok so the caller falls back to Yahoo'
    );
  });

  test('getBenzingaEarnings rejects when the vendor is unauthorised', () => {
    assert.ok(
      /benzinga earnings HTTP/.test(scoringSrc),
      'getBenzingaEarnings must throw on a non-OK response, not silently return beat_streak: 0'
    );
    assert.ok(
      /histJson\.status === 'rejected' && upcomJson\.status === 'rejected'/.test(scoringSrc),
      'getBenzingaEarnings must reject when BOTH calendar fetches fail'
    );
  });

  test('scoring reads BOTH earnings-date field names (vendor vs fallback shape differ)', () => {
    // Benzinga → next_earnings_date; Yahoo/EDGAR getEarningsSurprise → earnings_date.
    // Reading only one silently makes isEarningsPlay permanently false on the fallback.
    assert.ok(
      /surprise\?\.next_earnings_date\s*\?\?\s*surprise\?\.earnings_date/.test(scoringSrc),
      'scoring.js must accept next_earnings_date OR earnings_date'
    );
  });
});

describe('health check: a retired vendor is not an outage', () => {
  test('bz_news reports ok (not fail) when no Benzinga key is configured', async () => {
    const prevKey = process.env.BENZINGA_API;
    const prevKey2 = process.env.BENZINGA_API_KEY;
    delete process.env.BENZINGA_API;
    delete process.env.BENZINGA_API_KEY;
    try {
      const { runAllChecks } = await import('../src/web/health-checks.js');
      // Minimal stub: every check gets an empty result set. Checks that need real data will
      // fail, which is fine — we only assert on bz_news.
      const query = async () => ({ rows: [{}] });
      const { checks } = await runAllChecks(query);
      const bz = checks.find(c => c.id === 'bz_news');
      assert.ok(bz, 'bz_news check should still be reported');
      assert.equal(bz.status, 'ok', 'a cancelled subscription must not show as a permanent red');
      assert.match(String(bz.title || ''), /retired/i);
    } finally {
      if (prevKey !== undefined) process.env.BENZINGA_API = prevKey;
      if (prevKey2 !== undefined) process.env.BENZINGA_API_KEY = prevKey2;
    }
  });
});

describe('SEC ticker→CIK lookup is cached to disk', () => {
  const newsSrc = readFileSync(path.join(ROOT, 'src/core/news.js'), 'utf8');

  test('a transient www.sec.gov 429 cannot zero the earnings factors', () => {
    // www.sec.gov enforces an IP rate threshold and 429s in bursts. company_tickers.json was
    // re-fetched per cold start, so a throttled window made getCIK throw → beat_streak (+25)
    // and earnings_quality (+20) both silently zeroed, even though data.sec.gov was fine.
    assert.ok(/CIK_CACHE_FILE/.test(newsSrc), 'ticker→CIK map must be cached on disk');
    assert.ok(
      /return JSON\.parse\(await fs\.readFile\(CIK_CACHE_FILE, 'utf8'\)\)/.test(newsSrc),
      'a stale cache must be used when the fetch is throttled — CIKs are effectively immutable'
    );
  });

  test('earnings surprise prefers Yahoo (no CIK, correct beat-vs-estimate semantics)', () => {
    assert.ok(
      /getEarningsSurpriseYahoo/.test(newsSrc),
      'Yahoo must be the primary earnings-surprise source — it needs no CIK and is not SEC-throttled'
    );
    // Benzinga counted quarters that BEAT THE ESTIMATE. The EDGAR path counts YoY EPS growth —
    // a different signal carrying the same +25 weight. Yahoo restores the original meaning.
    assert.ok(
      /consecutive quarters beating the analyst EPS estimate/.test(newsSrc),
      'Yahoo beat_streak must be defined as beating the analyst estimate, matching the retired Benzinga semantics'
    );
  });
});
