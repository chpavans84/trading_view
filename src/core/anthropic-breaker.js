/**
 * src/core/anthropic-breaker.js
 *
 * Circuit breaker for the Anthropic API, shared by every call path.
 *
 * Problem it solves (2026-06-12 logging audit): after credits ran out on
 * 2026-05-27, every cron tick (notifications poll, news analysis, EOD fallback)
 * kept calling the API and logging an identical "credit balance is too low"
 * 400 — thousands of lines that drowned real errors in the PM2 error log.
 *
 * Behaviour: on a terminal account-level error (credit exhausted / bad key),
 * the breaker trips for RETRY_AFTER_MS. While tripped, callers should skip the
 * call entirely (anthropicAvailable() === false). ONE line is logged when the
 * breaker trips and one when it re-arms. Transient errors (429/5xx/network) do
 * NOT trip it.
 */

const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;   // re-test the API every 6 h

let _downUntil = 0;
let _tripReason = null;

const TERMINAL_PATTERNS = /credit balance is too low|invalid x-api-key|authentication_error|account .* disabled/i;

export function anthropicAvailable() {
  if (Date.now() >= _downUntil) {
    if (_tripReason) {
      console.error('[anthropic-breaker] re-armed — next call will test the API');
      _tripReason = null;
    }
    return true;
  }
  return false;
}

/**
 * Call from catch blocks. Returns true when the error is terminal and the
 * breaker absorbed it (caller should NOT log it again); false for ordinary
 * errors the caller still owns.
 */
export function reportAnthropicError(e, tag = '?') {
  const msg = String(e?.message ?? e);
  if (!TERMINAL_PATTERNS.test(msg)) return false;
  const firstTrip = Date.now() >= _downUntil;
  _downUntil = Date.now() + RETRY_AFTER_MS;
  _tripReason = msg.slice(0, 140);
  if (firstTrip) {
    console.error(`[anthropic-breaker] TRIPPED by [${tag}] — skipping all Anthropic calls for 6h. Cause: ${_tripReason}`);
  }
  return true;
}

export function anthropicBreakerState() {
  return { available: Date.now() >= _downUntil, downUntil: _downUntil || null, reason: _tripReason };
}
