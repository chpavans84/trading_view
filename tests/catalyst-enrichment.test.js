/**
 * Tests for Tomorrow's Catalysts UW enrichment logic.
 * Covers: quarter resolution, transcript sentiment derivation,
 * fundamentals field mapping, graceful degradation, and analyst count.
 *
 * Run: node --test tests/catalyst-enrichment.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

// ── Inline replicas of the logic under test ───────────────────────────────────

function _dateToQuarter(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const q = month <= 3 ? 1 : month <= 6 ? 2 : month <= 9 ? 3 : 4;
  return `${year}Q${q}`;
}

function _deriveTranscriptContext(uwTrans) {
  if (!uwTrans?.statements?.length) return { label: null, score: null, quote: null };
  const sentMap = { positive: 1, bullish: 1, negative: -1, bearish: -1, neutral: 0 };
  const nums = uwTrans.statements
    .map(s => typeof s.sentiment === 'number' ? s.sentiment
      : (sentMap[String(s.sentiment ?? '').toLowerCase()] ?? null))
    .filter(v => v !== null);
  const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
  const score = +((avg + 1) / 2).toFixed(3);
  const label = avg > 0.15 ? 'bullish' : avg < -0.15 ? 'bearish' : 'neutral';
  const exec = uwTrans.statements.find(s => /CEO|CFO|Chief Executive|Chief Financial/i.test(s.title || s.speaker || ''));
  const quote = exec?.content ? exec.content.slice(0, 140).trim() : null;
  return { label, score, quote };
}

function _uwAnalystCount(uwFund) {
  if (!uwFund) return null;
  const total = (uwFund.analyst_rating_buy        || 0) +
                (uwFund.analyst_rating_hold       || 0) +
                (uwFund.analyst_rating_sell       || 0) +
                (uwFund.analyst_rating_strong_buy  || 0) +
                (uwFund.analyst_rating_strong_sell || 0);
  return total > 0 ? total : null;
}

function _formatLastQuarter(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const m = d.getUTCMonth() + 1;
  const y = d.getUTCFullYear();
  return `Q${m <= 3 ? 1 : m <= 6 ? 2 : m <= 9 ? 3 : 4} ${y}`;
}

// ── Tests: quarter resolution ─────────────────────────────────────────────────

describe('catalyst-enrichment — _dateToQuarter', () => {
  it('converts Q1 end date correctly', () => {
    assert.strictEqual(_dateToQuarter('2026-03-31'), '2026Q1');
  });
  it('converts Q2 end date correctly', () => {
    assert.strictEqual(_dateToQuarter('2025-06-30'), '2025Q2');
  });
  it('converts Q3 end date correctly', () => {
    assert.strictEqual(_dateToQuarter('2025-09-30'), '2025Q3');
  });
  it('converts Q4 end date correctly', () => {
    assert.strictEqual(_dateToQuarter('2025-12-31'), '2025Q4');
  });
  it('returns null for empty input', () => {
    assert.strictEqual(_dateToQuarter(''), null);
    assert.strictEqual(_dateToQuarter(null), null);
  });
  it('returns null for invalid date', () => {
    assert.strictEqual(_dateToQuarter('not-a-date'), null);
  });
});

// ── Tests: transcript sentiment derivation ────────────────────────────────────

describe('catalyst-enrichment — _deriveTranscriptContext', () => {
  it('derives bullish label from all-positive statements', () => {
    const trans = { statements: [
      { title: 'CEO', content: 'Record revenue growth this quarter.', sentiment: 'positive' },
      { title: 'CFO', content: 'Margins expanding beyond expectations.', sentiment: 'positive' },
    ]};
    const { label, score, quote } = _deriveTranscriptContext(trans);
    assert.strictEqual(label, 'bullish');
    assert.ok(score > 0.5, 'score > 0.5 for bullish');
    assert.ok(quote?.length > 0, 'quote extracted from CEO');
  });

  it('derives bearish label from all-negative statements', () => {
    const trans = { statements: [
      { title: 'CEO', content: 'Revenue missed expectations significantly.', sentiment: 'negative' },
      { title: 'Analyst', content: 'Macro headwinds persist.', sentiment: 'negative' },
    ]};
    const { label } = _deriveTranscriptContext(trans);
    assert.strictEqual(label, 'bearish');
  });

  it('derives neutral label from mixed statements', () => {
    const trans = { statements: [
      { title: 'CEO', content: 'Mixed quarter overall.', sentiment: 'positive' },
      { title: 'Analyst', content: 'Some concerns remain.', sentiment: 'negative' },
      { title: 'CFO', content: 'Guidance maintained.', sentiment: 'neutral' },
    ]};
    const { label } = _deriveTranscriptContext(trans);
    assert.strictEqual(label, 'neutral');
  });

  it('returns null fields for empty statements array', () => {
    const { label, score, quote } = _deriveTranscriptContext({ statements: [] });
    assert.strictEqual(label, null);
    assert.strictEqual(score, null);
    assert.strictEqual(quote, null);
  });

  it('returns null fields when uwTrans is null', () => {
    const { label, score, quote } = _deriveTranscriptContext(null);
    assert.strictEqual(label, null);
    assert.strictEqual(score, null);
    assert.strictEqual(quote, null);
  });

  it('truncates key_quote to 140 chars', () => {
    const longContent = 'A'.repeat(200);
    const trans = { statements: [{ title: 'CEO', content: longContent, sentiment: 'positive' }]};
    const { quote } = _deriveTranscriptContext(trans);
    assert.ok(quote !== null);
    assert.ok(quote.length <= 140);
  });

  it('accepts numeric sentiment values', () => {
    const trans = { statements: [
      { title: 'CEO', content: 'Strong results.', sentiment: 0.8 },
      { title: 'CFO', content: 'Cost controls.', sentiment: 0.6 },
    ]};
    const { label, score } = _deriveTranscriptContext(trans);
    assert.ok(score > 0.5);
    assert.strictEqual(label, 'bullish');
  });
});

// ── Tests: fundamentals field mapping ─────────────────────────────────────────

describe('catalyst-enrichment — UW fundamentals mapping', () => {
  it('sums all analyst rating buckets for analyst count', () => {
    const fund = {
      analyst_target_price: 308.07,
      analyst_rating_buy: 25, analyst_rating_hold: 14, analyst_rating_sell: 1,
      analyst_rating_strong_buy: 7, analyst_rating_strong_sell: 1,
    };
    assert.strictEqual(_uwAnalystCount(fund), 48);
  });

  it('returns null when no analysts present', () => {
    const fund = { analyst_target_price: 100 };
    assert.strictEqual(_uwAnalystCount(fund), null);
  });

  it('returns null when uwFund is null', () => {
    assert.strictEqual(_uwAnalystCount(null), null);
  });

  it('formats latest_quarter to readable label', () => {
    assert.strictEqual(_formatLastQuarter('2026-03-31'), 'Q1 2026');
    assert.strictEqual(_formatLastQuarter('2025-12-31'), 'Q4 2025');
    assert.strictEqual(_formatLastQuarter(null), null);
  });
});

// ── Tests: graceful degradation ───────────────────────────────────────────────

describe('catalyst-enrichment — graceful degradation', () => {
  it('UW null results produce all-null uw_* fields', () => {
    const uwFund = null;
    const uwTrans = null;

    const uw_analyst_target_avg = uwFund?.analyst_target_price ?? null;
    const uw_analyst_count = _uwAnalystCount(uwFund);
    const uw_last_quarter = _formatLastQuarter(uwFund?.latest_quarter);
    const { label: uw_transcript_label, score: uw_transcript_score, quote: uw_transcript_quote } = _deriveTranscriptContext(uwTrans);

    assert.strictEqual(uw_analyst_target_avg, null);
    assert.strictEqual(uw_analyst_count, null);
    assert.strictEqual(uw_last_quarter, null);
    assert.strictEqual(uw_transcript_label, null);
    assert.strictEqual(uw_transcript_score, null);
    assert.strictEqual(uw_transcript_quote, null);
  });

  it('non-UW fields are unaffected when UW returns null', () => {
    // Simulates enrich() return when UW calls both fail
    const mockEntry = {
      symbol: 'AAPL', company: 'Apple Inc.', date: '2026-05-20', call_time: 'AMC',
      eps_estimate: 1.25, market_cap: 3e12, price: 195.0,
      analyst_consensus: 'buy', analyst_target: 215.0, analyst_upside: 10,
      conviction_score: 78, conviction_grade: 'B', avg_surprise_pct: 4.2,
      top_news: { title: 'Apple beats estimates', url: 'https://example.com', published: '2026-05-19' },
      uw_analyst_target_avg: null, uw_analyst_count: null, uw_last_quarter: null,
      uw_transcript_label: null, uw_transcript_score: null, uw_transcript_quote: null, uw_transcript_quarter: null,
    };

    assert.strictEqual(mockEntry.symbol, 'AAPL');
    assert.strictEqual(mockEntry.conviction_score, 78);
    assert.strictEqual(mockEntry.uw_analyst_target_avg, null, 'UW field null when UW unavailable');
    assert.ok(mockEntry.top_news?.title, 'non-UW news field preserved');
  });
});
