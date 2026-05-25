/**
 * src/core/env-loader.js
 *
 * Belt-and-suspenders .env loader. Node's --env-file flag does NOT override
 * pre-existing environment variables, and PM2 captures + re-injects whatever
 * env the shell had when `pm2 start` was first run. Result: if the shell that
 * launched PM2 had `ANTHROPIC_API_KEY=` (empty), Node will see it as empty
 * even though .env has the real value.
 *
 * This loader reads .env directly and *overrides* any env var that is missing
 * or empty. Imported as the FIRST statement in src/web/server.js and
 * src/server.js so every downstream module sees the correct values.
 *
 * NOTE: We do NOT touch already-populated env vars — production deployments
 * that set vars via systemd/CI continue to win.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Project root is two levels up from src/core/
const ROOT = join(__dirname, '..', '..');

let _loaded = false;
let _overridden = [];

function parseEnvFile(content) {
  const out = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.trim().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    // Strip wrapping quotes (matching dotenv behavior)
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Strip trailing whitespace only on unquoted values
    value = value.replace(/\s+$/, '');
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Resolve which env file(s) to load. We try environment-specific files first
 * (`.env.<NODE_ENV>`), then the generic `.env`. Existing process.env values
 * already win over either — these are only fallbacks for empty/missing vars.
 *
 * Also detects --env-file=<path> in process.argv so the loader naturally
 * reads the same file Node was launched with.
 */
function getEnvPathsToTry() {
  const paths = [];

  // 1. Match the --env-file flag if PM2 launched node with one.
  //    Note: Node strips --env-file from process.argv but preserves it in
  //    process.execArgv (the actual node CLI flags).
  for (let i = 0; i < process.execArgv.length; i++) {
    const arg = process.execArgv[i];
    if (arg === '--env-file' && process.execArgv[i + 1]) {
      paths.push(process.execArgv[i + 1]);
    } else if (arg.startsWith('--env-file=')) {
      paths.push(arg.slice('--env-file='.length));
    }
  }

  // 2. NODE_ENV-specific (e.g. .env.staging, .env.production)
  const nodeEnv = (process.env.NODE_ENV || '').trim();
  if (nodeEnv && nodeEnv !== 'production') {
    paths.push(join(ROOT, `.env.${nodeEnv}`));
  }

  // 3. Generic .env (fallback)
  paths.push(join(ROOT, '.env'));

  // De-dupe + only keep paths that exist
  const seen = new Set();
  return paths
    .map(p => (p.startsWith('/') ? p : join(ROOT, p)))
    .filter(p => {
      if (seen.has(p) || !existsSync(p)) return false;
      seen.add(p);
      return true;
    });
}

export function loadEnvOverride() {
  if (_loaded) return _overridden;
  _loaded = true;

  const pathsTried = getEnvPathsToTry();
  if (pathsTried.length === 0) {
    console.warn('[env-loader] no .env files found at project root');
    return [];
  }

  // Read each path; earlier paths win (so .env.staging takes precedence over .env).
  const merged = {};
  for (const path of pathsTried) {
    try {
      const content = readFileSync(path, 'utf8');
      const parsed  = parseEnvFile(content);
      for (const [k, v] of Object.entries(parsed)) {
        if (!(k in merged)) merged[k] = v;  // first-wins (path priority)
      }
    } catch (e) {
      console.warn(`[env-loader] could not read ${path}: ${e.message}`);
    }
  }

  for (const [k, v] of Object.entries(merged)) {
    if (!process.env[k] || process.env[k].trim() === '') {
      if (v) {
        process.env[k] = v;
        _overridden.push(k);
      }
    }
  }
  if (_overridden.length) {
    const fileLabels = pathsTried.map(p => p.replace(ROOT + '/', '')).join(' + ');
    console.log(`[env-loader] override-populated ${_overridden.length} empty vars from ${fileLabels}: ${_overridden.join(', ')}`);
  }
  return _overridden;
}

// Auto-run on import so callers just need to `import './env-loader.js'`
loadEnvOverride();
