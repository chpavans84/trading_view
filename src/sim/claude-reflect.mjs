/**
 * src/sim/claude-reflect.mjs — call Claude on the Max subscription for the
 * sim's nightly self-reflection. Zero API cost (uses OAuth/keychain, not the
 * exhausted API credits — same mechanism as src/core/claude-desktop-chat.js).
 *
 * One-shot `claude -p`, JSON in / JSON out, no MCP tools (all data is in the
 * prompt → fast + deterministic-ish). Returns the parsed proposal or null.
 */
import { spawn } from 'node:child_process';

const CLAUDE_BIN = '/Users/pavan/.local/bin/claude';
const TIMEOUT_MS = 90_000;

export async function askClaudeJSON(prompt, { model = 'sonnet' } = {}) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;       // force Max-sub OAuth, not paid API
  delete env.ANTHROPIC_AUTH_TOKEN;

  const args = ['-p', '--model', model, '--effort', 'medium',
                '--disallowedTools', 'Write', 'Edit', 'Bash', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

  const text = await new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} reject(new Error('claude timeout')); }, TIMEOUT_MS);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => { clearTimeout(killer); code === 0 ? resolve(out) : reject(new Error(`claude exit ${code}: ${err.slice(0,200)}`)); });
    child.stdin.write(prompt); child.stdin.end();
  });

  // pull the first {...} JSON block out of the reply
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { _raw: text.trim(), _parseError: true };
  try { return JSON.parse(m[0]); }
  catch { return { _raw: text.trim(), _parseError: true }; }
}
