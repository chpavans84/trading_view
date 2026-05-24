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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// .env lives at the project root, two levels up from src/core/
const ENV_PATH = join(__dirname, '..', '..', '.env');

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

export function loadEnvOverride() {
  if (_loaded) return _overridden;
  _loaded = true;
  let content;
  try { content = readFileSync(ENV_PATH, 'utf8'); }
  catch (e) {
    console.warn(`[env-loader] could not read ${ENV_PATH}: ${e.message}`);
    return [];
  }
  const parsed = parseEnvFile(content);
  for (const [k, v] of Object.entries(parsed)) {
    if (!process.env[k] || process.env[k].trim() === '') {
      if (v) {
        process.env[k] = v;
        _overridden.push(k);
      }
    }
  }
  if (_overridden.length) {
    console.log(`[env-loader] override-populated ${_overridden.length} empty vars from .env: ${_overridden.join(', ')}`);
  }
  return _overridden;
}

// Auto-run on import so callers just need to `import './env-loader.js'`
loadEnvOverride();
