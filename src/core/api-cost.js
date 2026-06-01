/**
 * src/core/api-cost.js
 *
 * Single source of truth for Anthropic API cost math. Previously we had
 * two copies of `calcCost(inp, out)` (one in ai-chat.js, one in admin-ai.js)
 * that only counted regular input + output tokens. That underreported the
 * actual bill by ~14% because:
 *
 *   • Cache writes are billed at 1.25× input rate ($3.75 / M tokens)
 *   • Cache reads are billed at 0.10× input rate ($0.30 / M tokens)
 *
 * We were lumping all input into the $3/M bucket and ignoring writes
 * entirely. The Anthropic dashboard showed $46.60 vs our DB at $40.21 over
 * the same window. This module fixes that.
 *
 * Pricing reference (claude-sonnet-4-6, public list price as of 2026-05):
 *   Regular input : $3.00 / 1M tokens
 *   Cache write   : $3.75 / 1M tokens   (1.25× input)
 *   Cache read    : $0.30 / 1M tokens   (0.10× input)
 *   Output        : $15.00 / 1M tokens
 *
 * Usage:
 *   import { calcCost, tokensFromUsage } from './api-cost.js';
 *   const usage = tokensFromUsage(finalMsg.usage);  // normalize the SDK shape
 *   const cost  = calcCost(usage);                  // single number, USD
 */

// Per-million-token prices. Bump these whenever Anthropic changes list pricing.
export const PRICE_INPUT_PER_M       = 3.00;
export const PRICE_CACHE_WRITE_PER_M = 3.75;   // 1.25× input
export const PRICE_CACHE_READ_PER_M  = 0.30;   // 0.10× input
export const PRICE_OUTPUT_PER_M      = 15.00;

/**
 * Normalize the Anthropic SDK's `usage` object into a flat shape we can pass
 * around without worrying about SDK field-name drift.
 *
 * Anthropic returns:
 *   { input_tokens, output_tokens,
 *     cache_creation_input_tokens?, cache_read_input_tokens? }
 *
 * Returns:
 *   { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens }
 */
export function tokensFromUsage(u = {}) {
  return {
    inputTokens:         Number(u.input_tokens               || 0),
    outputTokens:        Number(u.output_tokens              || 0),
    cacheCreationTokens: Number(u.cache_creation_input_tokens || 0),
    cacheReadTokens:     Number(u.cache_read_input_tokens     || 0),
  };
}

/**
 * Cost in USD given a normalized token object. Pass either the normalized
 * shape from tokensFromUsage(), or a positional fallback (inp, out) for the
 * old 2-arg signature so existing call sites don't break.
 *
 *   calcCost({ inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens })
 *   calcCost(inp, out)   // legacy — assumes zero cache tokens
 */
export function calcCost(arg1, arg2) {
  // Legacy 2-arg form
  if (typeof arg1 === 'number') {
    const inp = arg1 || 0, out = arg2 || 0;
    return (inp / 1e6) * PRICE_INPUT_PER_M + (out / 1e6) * PRICE_OUTPUT_PER_M;
  }
  const t = arg1 || {};
  const inp   = t.inputTokens         || 0;
  const out   = t.outputTokens        || 0;
  const cwrt  = t.cacheCreationTokens || 0;
  const cread = t.cacheReadTokens     || 0;
  return (
    (inp   / 1e6) * PRICE_INPUT_PER_M       +
    (out   / 1e6) * PRICE_OUTPUT_PER_M      +
    (cwrt  / 1e6) * PRICE_CACHE_WRITE_PER_M +
    (cread / 1e6) * PRICE_CACHE_READ_PER_M
  );
}
