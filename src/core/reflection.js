/**
 * Reflection Agent — runs nightly after market close.
 * Analyses closed trades per user, writes lessons to DB.
 * Uses Ollama (free) with Claude Haiku fallback — never touches ai-chat.js.
 */
import { getTrades, saveLesson, upsertPerformancePattern,
         query, isDbAvailable, listDbUsers } from './db.js';
import { localAI } from './ollama.js';

function vixBucket(vix) {
  if (!vix || vix < 20)  return '<20';
  if (vix < 25)          return '20-25';
  if (vix < 30)          return '25-30';
  return '>30';
}

async function generateLesson(trade) {
  const outcome  = (trade.pnl_usd ?? 0) >= 0 ? 'win' : 'loss';
  const pnlAbs   = Math.abs(trade.pnl_usd ?? 0).toFixed(2);
  const regime   = trade.conviction_breakdown?.regime ?? 'unknown';
  const reason   = trade.conviction_breakdown?.reason ?? 'no thesis recorded';
  const score    = trade.conviction_score ?? 'unknown';

  const prompt = outcome === 'loss'
    ? `A trade closed at a LOSS. Write ONE sentence (max 25 words) on what to avoid next time.
Symbol: ${trade.symbol} | Loss: $${pnlAbs} | Conviction: ${score}/100
Regime: ${regime} | Entry: $${trade.entry_price} | Stop hit: $${trade.stop_loss}
Thesis at entry: ${reason}
Start with the symbol. Be specific. Example: "${trade.symbol} — avoid entries when RSI > 70 in volatile regime; momentum was exhausted."`
    : `A trade closed as a WIN. Write ONE sentence (max 20 words) on what made it work.
Symbol: ${trade.symbol} | Profit: $${pnlAbs} | Conviction: ${score}/100
Regime: ${regime} | Thesis: ${reason}
Start with the symbol.`;

  // localAI returns { text, source, model } — always access .text
  const result = await localAI({
    system: 'You are a trading coach. One sentence only. No markdown. No bullet points.',
    prompt,
    fallbackModel: 'claude-haiku-4-5-20251001',
    maxTokens: 60,
  });

  const lesson = result.text?.trim()
    ?? `${trade.symbol} — ${outcome} $${pnlAbs} in ${regime} regime (conviction ${score})`;

  return { outcome, regime, lesson, ai_source: result.source };
}

function detectLessonType(trade) {
  const score  = trade.conviction_score ?? 0;
  const reason = (trade.conviction_breakdown?.reason ?? '').toLowerCase();
  if (score < 55)                                          return 'low_conviction';
  if (reason.includes('time') || reason.includes('midday')) return 'timing';
  if (reason.includes('vix'))                              return 'regime';
  return 'entry';
}

async function recomputePatterns(username) {
  if (!isDbAvailable()) return;
  try {
    const { rows } = await query(
      `SELECT conviction_breakdown->>'regime' AS regime,
              pnl_usd
       FROM trades
       WHERE status = 'closed'
         AND pnl_usd IS NOT NULL
         AND conviction_breakdown IS NOT NULL
         AND opened_at > NOW() - INTERVAL '90 days'
         AND username = $1`,
      [username]
    );

    const buckets = {};
    for (const row of rows) {
      const regime = row.regime ?? 'unknown';
      const key    = `${regime}|||all`;
      if (!buckets[key]) buckets[key] = { regime, vix_bucket: 'all', trades: 0, wins: 0, total_pnl: 0 };
      buckets[key].trades++;
      if ((parseFloat(row.pnl_usd) ?? 0) > 0) buckets[key].wins++;
      buckets[key].total_pnl += parseFloat(row.pnl_usd ?? 0);
    }

    for (const b of Object.values(buckets)) {
      await upsertPerformancePattern({ ...b, username });
    }
    console.log(`[reflection] ${username}: Recomputed ${Object.keys(buckets).length} performance pattern(s)`);
  } catch (e) {
    console.error(`[reflection] recomputePatterns error for ${username}:`, e.message);
  }
}

async function _reflectForUser(username) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  let trades = [];
  try {
    const all = await getTrades({ status: 'closed', username, limit: 100 });
    trades = (all ?? []).filter(t => {
      if (!t.closed_at) return false;
      const d = new Date(t.closed_at)
        .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      return d === today;
    });
  } catch (e) {
    console.error(`[reflection] Failed to load trades for ${username}:`, e.message);
    return { username, lessons: [], error: e.message };
  }

  if (!trades.length) {
    console.log(`[reflection] No trades closed today for ${username}`);
    return { username, lessons: [], trades_analysed: 0 };
  }

  const lessons = [];
  for (const trade of trades) {
    try {
      const { outcome, regime, lesson, ai_source } = await generateLesson(trade);
      await saveLesson({
        date:        today,
        symbol:      trade.symbol,
        outcome,
        pnl_usd:     trade.pnl_usd,
        regime,
        vix:         null,
        lesson_type: outcome === 'loss' ? detectLessonType(trade) : 'success',
        lesson,
        ai_source,
        username,
      });
      lessons.push({ symbol: trade.symbol, outcome, pnl_usd: trade.pnl_usd, lesson, ai_source });
      console.log(`[reflection] ${username} ${outcome.toUpperCase()} ${trade.symbol} (${ai_source}): ${lesson}`);
    } catch (e) {
      console.error(`[reflection] Lesson failed for ${username}/${trade.symbol}:`, e.message);
    }
  }

  return { username, lessons, trades_analysed: trades.length };
}

export async function runReflection() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  console.log('[reflection] Running for', today);

  const dow = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
  const isFriday = dow === 'Friday';

  let users = [];
  try {
    const all = await listDbUsers();
    users = (all ?? []).filter(u => !u.suspended);
  } catch (e) {
    console.error('[reflection] Failed to list users:', e.message);
    // Fall back to system-level reflection with no username
    const result = await _reflectForUser('system');
    return { results: [result] };
  }

  if (!users.length) {
    console.log('[reflection] No active users found');
    return { results: [] };
  }

  const results = [];
  for (const u of users) {
    const result = await _reflectForUser(u.username);
    results.push(result);
    if (isFriday) await recomputePatterns(u.username);
  }

  return { results };
}
