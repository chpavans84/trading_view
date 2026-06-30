// MUST be first — populates ANTHROPIC_API_KEY from .env if shell shadowed it as empty
import './env-loader.js';
/**
 * Local AI client — tries Ollama first (primary model, then a small always-warm
 * local fallback), and only then the Anthropic API. Anthropic failures (e.g.
 * exhausted credits — the user runs no-API-spend) degrade gracefully to
 * { text: null, source: 'unavailable' } instead of throwing, so cron jobs that
 * narrate (EOD summary, briefings) skip their save rather than die.
 */

const OLLAMA_URL     = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL || 'llama3.1:8b';
// 15s was too short for a cold 20GB model (trading-coach) — the first generate
// after idle loads the whole model. That timeout silently pushed EVERY localAI
// call to the Anthropic fallback, which had been failing on exhausted credits
// since 2026-05-27 (daily_briefings + api_calls froze that day). 90s default.
const OLLAMA_TIMEOUT = Number(process.env.OLLAMA_TIMEOUT_MS) || 90000;
// Small always-warm local fallback — tried BEFORE any paid API call.
const OLLAMA_FALLBACK_MODEL = process.env.OLLAMA_FALLBACK_MODEL || 'llama3.2:3b';

let _ollamaAvailable = null;
let _ollamaCheckTs   = 0;

export async function isOllamaAvailable() {
  if (_ollamaAvailable !== null && Date.now() - _ollamaCheckTs < 60000) {
    return _ollamaAvailable;
  }
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    _ollamaAvailable = res.ok;
  } catch {
    _ollamaAvailable = false;
  }
  _ollamaCheckTs = Date.now();
  return _ollamaAvailable;
}

async function _ollamaGenerate(model, system, prompt, maxTokens) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt:  system ? `${system}\n\n${prompt}` : prompt,
      stream:  false,
      options: { num_predict: maxTokens, temperature: 0.3 },
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT),
  });
  if (!res.ok) throw new Error(`ollama ${model} HTTP ${res.status}`);
  const data = await res.json();
  const text = data.response?.trim();
  if (!text) throw new Error(`ollama ${model} empty response`);
  return text;
}

export async function localAI({ prompt, system = '', fallbackModel = 'claude-haiku-4-5-20251001', maxTokens = 500 }) {
  if (await isOllamaAvailable()) {
    // primary local model, then the small warm one — both free
    for (const model of [OLLAMA_MODEL, OLLAMA_FALLBACK_MODEL]) {
      try {
        const text = await _ollamaGenerate(model, system, prompt, maxTokens);
        return { text, source: 'ollama', model };
      } catch (err) {
        console.warn(`[ollama] ${model} failed (${err.message})` +
          (model === OLLAMA_MODEL ? ` — trying ${OLLAMA_FALLBACK_MODEL}` : ' — trying Anthropic'));
      }
    }
  }

  // Last resort: Anthropic API. NEVER throw to the caller — credits may be
  // exhausted (no-API-spend setup); callers must handle text:null by skipping.
  // Gated behind the shared circuit breaker so a dead account logs ONE line
  // per 6h instead of one per call (2026-06-12 logging audit).
  try {
    const { anthropicAvailable, reportAnthropicError } = await import('./anthropic-breaker.js');
    if (!anthropicAvailable()) {
      return { text: null, source: 'unavailable', model: null, error: 'anthropic breaker open' };
    }
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const res = await client.messages.create({
        model:      fallbackModel,
        max_tokens: maxTokens,
        system:     system || undefined,
        messages:   [{ role: 'user', content: prompt }],
      });
      return { text: res.content[0]?.text?.trim(), source: 'anthropic', model: fallbackModel };
    } catch (err) {
      if (!reportAnthropicError(err, 'localAI')) {
        console.warn('[localAI] all backends failed (anthropic:', err.message?.slice(0, 120), ') — returning unavailable');
      }
      return { text: null, source: 'unavailable', model: null, error: err.message };
    }
  } catch (err) {
    return { text: null, source: 'unavailable', model: null, error: err.message };
  }
}
