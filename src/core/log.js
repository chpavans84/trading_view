/**
 * src/core/log.js — minimal shared logger (2026-06-12 logging audit).
 *
 * Usage:   import { makeLog } from './log.js';
 *          const log = makeLog('benzinga');
 *          log.info('fetched 12 articles');     // 2026-06-12T12:00:01.123Z INFO  [benzinga] fetched 12 articles
 *          log.error('HTTP 500', err);
 *
 * Rules (see GOTCHAS.md "Logging"):
 *  - New code uses makeLog instead of bare console.* — every line gets a
 *    timestamp + level + module tag so the PM2 logs are greppable.
 *  - DEBUG lines only print when LOG_DEBUG=1 (keeps prod logs lean).
 *  - Never log secrets/tokens/full URLs with credentials — redact first.
 */

const ts = () => new Date().toISOString();

export function makeLog(tag) {
  const p = (lvl) => `${ts()} ${lvl.padEnd(5)} [${tag}]`;
  return {
    debug: (...a) => { if (process.env.LOG_DEBUG === '1') console.log(p('DEBUG'), ...a); },
    info:  (...a) => console.log(p('INFO'), ...a),
    warn:  (...a) => console.warn(p('WARN'), ...a),
    error: (...a) => console.error(p('ERROR'), ...a),
  };
}
