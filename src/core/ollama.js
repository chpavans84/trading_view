/**
 * Local AI client — tries Ollama first, falls back to Anthropic.
 * Use for narrative/summary tasks that don't need real-time data.
 */

const OLLAMA_URL     = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const OLLAMA_TIMEOUT = 15000;

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

export async function localAI({ prompt, system = '', fallbackModel = 'claude-haiku-4-5-20251001', maxTokens = 500 }) {
  if (await isOllamaAvailable()) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:   OLLAMA_MODEL,
          prompt:  system ? `${system}\n\n${prompt}` : prompt,
          stream:  false,
          options: { num_predict: maxTokens, temperature: 0.3 },
        }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT),
      });
      if (res.ok) {
        const data = await res.json();
        return { text: data.response?.trim(), source: 'ollama', model: OLLAMA_MODEL };
      }
    } catch (err) {
      console.warn('[ollama] Failed, falling back to Anthropic:', err.message);
    }
  }

  // Fallback to Anthropic
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model:      fallbackModel,
    max_tokens: maxTokens,
    system:     system || undefined,
    messages:   [{ role: 'user', content: prompt }],
  });
  return { text: res.content[0]?.text?.trim(), source: 'anthropic', model: fallbackModel };
}
