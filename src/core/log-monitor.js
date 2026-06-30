/**
 * src/core/log-monitor.js — shared log-monitoring backend (2026-06-12).
 *
 * One module, two surfaces (same pattern as health-checks.js):
 *   - Dashboard: 📜 Log Monitor panel on the Health tab (/api/logs/*)
 *   - MCP: log_sources / log_tail tools (src/tools/logs.js)
 *
 * Reads only from two whitelisted directories:
 *   ~/.pm2/logs/*.log         (pm2:<file>)  — process stdout/stderr
 *   ~/Library/Logs/*.log      (jobs:<file>) — launchd/batch job logs
 *
 * Tail is chunked from the END of the file (max 1 MB read) so multi-GB logs
 * can never blow up memory — that lesson cost 10.4 GB once.
 */

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const HOME = homedir();
const ROOTS = {
  pm2:  { dir: join(HOME, '.pm2', 'logs'),      label: 'PM2 process logs' },
  jobs: { dir: join(HOME, 'Library', 'Logs'),   label: 'launchd / batch job logs' },
};

const MAX_LINES      = 2000;
const MAX_READ_BYTES = 1024 * 1024;   // never read more than 1 MB per tail

const ERR_RE  = /\b(error|err\b|fail(ed|ure)?|exception|fatal|traceback|✗)\b|TRIPPED/i;
const WARN_RE = /\b(warn(ing)?|deprecated|retry(ing)?|stale|skipp?ed)\b|⚠/i;

function classify(line) {
  if (ERR_RE.test(line)) return 'error';
  if (WARN_RE.test(line)) return 'warn';
  return 'info';
}

/** "pm2:trading-dashboard-error.log" -> { root, absolute path } or throws */
function resolveSource(source) {
  const i = String(source).indexOf(':');
  if (i < 1) throw new Error(`bad source "${source}" — expected "<root>:<file.log>"`);
  const rootKey = source.slice(0, i);
  const file = source.slice(i + 1);
  const root = ROOTS[rootKey];
  if (!root) throw new Error(`unknown log root "${rootKey}" (valid: ${Object.keys(ROOTS).join(', ')})`);
  if (file.includes('/') || file.includes('\\') || file.includes('..') || !file.endsWith('.log')) {
    throw new Error('invalid log file name');
  }
  const abs = resolve(root.dir, file);
  if (!abs.startsWith(root.dir + sep)) throw new Error('path escapes log root');
  return { rootKey, file, abs };
}

/** All readable *.log files across the whitelisted roots, newest first. */
export async function listLogSources() {
  const sources = [];
  for (const [rootKey, root] of Object.entries(ROOTS)) {
    let entries = [];
    try { entries = await fsp.readdir(root.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.log')) continue;
      try {
        const st = await fsp.stat(join(root.dir, e.name));
        sources.push({
          source: `${rootKey}:${e.name}`,
          root: rootKey, file: e.name,
          size_bytes: st.size, modified_at: st.mtime.toISOString(),
        });
      } catch { /* unreadable file — skip */ }
    }
  }
  sources.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return { roots: Object.fromEntries(Object.entries(ROOTS).map(([k, v]) => [k, v.dir])), sources };
}

/**
 * Tail a log: last `lines` lines (≤2000), optional case-insensitive substring
 * filter, each line classified info/warn/error.
 */
export async function tailLog(source, { lines = 200, grep = null } = {}) {
  const { abs, file, rootKey } = resolveSource(source);
  const n = Math.min(MAX_LINES, Math.max(1, parseInt(lines, 10) || 200));
  const st = await fsp.stat(abs);

  const readBytes = Math.min(st.size, MAX_READ_BYTES);
  let text = '';
  if (readBytes > 0) {
    const fh = await fsp.open(abs, 'r');
    try {
      const buf = Buffer.alloc(readBytes);
      await fh.read(buf, 0, readBytes, st.size - readBytes);
      text = buf.toString('utf8');
      // drop the first (likely partial) line when we started mid-file
      if (readBytes < st.size) text = text.slice(text.indexOf('\n') + 1);
    } finally { await fh.close(); }
  }

  let all = text.split('\n').filter(l => l.length > 0);
  const needle = grep ? String(grep).toLowerCase() : null;
  if (needle) all = all.filter(l => l.toLowerCase().includes(needle));
  const out = all.slice(-n);

  const result = out.map(t => ({ t, lvl: classify(t) }));
  return {
    source: `${rootKey}:${file}`,
    size_bytes: st.size,
    modified_at: st.mtime.toISOString(),
    truncated_read: st.size > MAX_READ_BYTES,
    grep: grep || null,
    returned: result.length,
    errors: result.filter(l => l.lvl === 'error').length,
    warns:  result.filter(l => l.lvl === 'warn').length,
    lines: result,
  };
}
