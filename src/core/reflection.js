/**
 * Reflection Agent — runs after market close, analyses closed trades,
 * writes lessons to DB so the AI can learn from past mistakes.
 */
import { getTrades, saveLesson, upsertPerformancePattern, query, isDbAvailable } from './db.js';
import { localAI } from './ollama.js';

function vixBucket(vix) {
  if (!vix)      return 'unknown';
  if (vix < 20)  return '<20';
  if (vix < 25)  return '20-25';
  if (vix < 30)  return '25-30';
  return '>30';
}

async function generateLesson(trade) {
  const outcome = (trade.pnl_usd ?? 0) >= 0 ? 'win' : 'loss';
  const pnl     = trade.pnl_usd?.toFixed(2) ?? '0';
  const regime  = trade.conviction_breakdown?.regime ?? 'unknown';
  const reason  = trade.conviction_breakdown?.reason ?? '';

  const prompt = outcome === 'loss'
    ? `A trade just closed as a LOSS. Analyse what went wrong in ONE sentence (max 25 words).
       Symbol: ${trade.symbol}
       P&L: -$${Math.abs(pnl)}
       Conviction score: ${trade.conviction_score ?? 'unknown'}/100
       Regime at entry: ${regime}
       Original thesis: ${reason}
       Stop was hit at: $${trade.stop_loss} (entry was $${trade.entry_price})
       Write one concrete lesson starting with the symbol, e.g.:
       "${trade.symbol} — avoid entries when [specific condition]; stop was too tight for the volatility."`
    : `A trade just closed as a WIN. In ONE sentence (max 20 words), identify the key factor that made it work.
       Symbol: ${trade.symbol}
       P&L: +$${pnl}
       Conviction score: ${trade.conviction_score ?? 'unknown'}/100
       Regime: ${regime}
       Write one sentence starting with the symbol.`;

  try {
    const lesson = await localAI({ prompt, system: 'You are a trading coach. Be direct and specific. No markdown.', fallbackModel: 'claude-haiku-4-5-20251001', maxTokens: 60 });
    return { outcome, regime, lesson: lesson.trim() };
  } catch {
    const fallback = outcome === 'loss'
      ? `${trade.symbol} — loss of $${Math.abs(pnl)} in ${regime} regime (conviction ${trade.conviction_score ?? '?'})`
      : `${trade.symbol} — win of $${pnl} in ${regime} regime`;
    return { outcome, regime, lesson: fallback };
  }
}

async function recomputePatterns() {
  if (!isDbAvailable()) return;
  try {
    const { rows } = await query(
      `SELECT conviction_breakdown->>'regime' AS regime,
              conviction_score, pnl_usd
       FROM trades
       WHERE status = 'closed' AND pnl_usd IS NOT NULL
         AND conviction_breakdown IS NOT NULL
         AND opened_at > NOW() - INTERVAL '90 days'`
    );

    const buckets = {};
    for (const row of rows) {
      const regime = row.regime ?? 'unknown';
      const bucket = 'all';
      const key    = `${regime}|||${bucket}`;
      if (!buckets[key]) buckets[key] = { regime, vix_bucket: bucket, trades: 0, wins: 0, total_pnl: 0 };
      buckets[key].trades++;
      if ((row.pnl_usd ?? 0) > 0) buckets[key].wins++;
      buckets[key].total_pnl += parseFloat(row.pnl_usd ?? 0);
    }

    for (const b of Object.values(buckets)) {
      await upsertPerformancePattern(b);
    }
  } catch (e) {
    console.error('[reflection] recomputePatterns error:', e.message);
  }
}

export async function runReflection() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  console.log('[reflection] Starting daily reflection for', today);

  let trades = [];
  try {
    const all = await getTrades({ status: 'closed', limit: 100 });
    trades = (all ?? []).filter(t => {
      if (!t.closed_at) return false;
      const closeDate = new Date(t.closed_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      return closeDate === today;
    });
  } catch (e) {
    console.error('[reflection] Failed to fetch trades:', e.message);
    return { lessons: [], error: e.message };
  }

  if (!trades.length) {
    console.log('[reflection] No trades closed today — nothing to learn from');
    return { lessons: [], trades_analysed: 0 };
  }

  const lessons = [];
  for (const trade of trades) {
    try {
      const { outcome, regime, lesson } = await generateLesson(trade);
      const lessonType = outcome === 'loss' ? detectLessonType(trade) : 'success';
      await saveLesson({
        date:        today,
        symbol:      trade.symbol,
        outcome,
        pnl_usd:     trade.pnl_usd,
        regime,
        vix:         null,
        lesson_type: lessonType,
        lesson,
      });
      lessons.push({ symbol: trade.symbol, outcome, pnl_usd: trade.pnl_usd, lesson });
      console.log(`[reflection] ${trade.symbol} (${outcome}): ${lesson}`);
    } catch (e) {
      console.error(`[reflection] Failed lesson for ${trade.symbol}:`, e.message);
    }
  }

  const dayOfWeek = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
  if (dayOfWeek === 'Friday') await recomputePatterns();

  console.log(`[reflection] Done — ${lessons.length} lessons written`);
  return { lessons, trades_analysed: trades.length };
}

function detectLessonType(trade) {
  const score = trade.conviction_score ?? 0;
  const breakdown = trade.conviction_breakdown?.reason ?? '';
  if (score < 55)                                        return 'entry';
  if (breakdown.toLowerCase().includes('time'))          return 'timing';
  return 'regime';
}
