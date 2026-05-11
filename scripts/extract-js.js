#!/usr/bin/env node
/**
 * Extracts all bare <script>...</script> blocks (no attributes) from index.html
 * into js/dashboard.js and replaces them with a single <script src> tag before </body>.
 *
 * Safe to re-run: overwrites js/dashboard.js if it already exists.
 *
 * Usage:
 *   node scripts/extract-js.js --dry-run   # show stats only, no writes
 *   node scripts/extract-js.js             # write js/dashboard.js + patch index.html
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const HTML_FILE = path.join(ROOT, 'src/web/public/index.html');
const JS_DIR    = path.join(ROOT, 'src/web/public/js');
const JS_FILE   = path.join(JS_DIR, 'dashboard.js');
const DRY_RUN   = process.argv.includes('--dry-run');

const html = fs.readFileSync(HTML_FILE, 'utf8');

// Match only bare <script>...</script> blocks — no src=, no type=, no attributes
const scriptBlocks = [];
const scriptRegex = /<script>([\s\S]*?)<\/script>/g;
let match;
while ((match = scriptRegex.exec(html)) !== null) {
  scriptBlocks.push({ full: match[0], content: match[1] });
}

console.log(`\nFound ${scriptBlocks.length} inline <script> blocks in index.html`);
scriptBlocks.forEach((b, i) => {
  const lines = b.content.split('\n').length;
  console.log(`  Block ${i + 1}: ${lines} lines`);
});

const totalJsLines = scriptBlocks.reduce((sum, b) => sum + b.content.split('\n').length, 0);
console.log(`  Total JS lines to extract: ${totalJsLines}`);

if (DRY_RUN) {
  console.log('\nDry run — no files written.\n');
  process.exit(0);
}

// Write dashboard.js — blocks concatenated in document order
fs.mkdirSync(JS_DIR, { recursive: true });
const jsContent = scriptBlocks.map((b, i) =>
  `/* ── Block ${i + 1} ──────────────────────────────────────────────────────── */\n${b.content.trim()}`
).join('\n\n');
fs.writeFileSync(JS_FILE, jsContent, 'utf8');
console.log(`\nWrote js/dashboard.js (${jsContent.split('\n').length} lines)`);

// Patch index.html:
// 1. Remove all bare <script>...</script> blocks
// 2. Insert <script src> right before </body>
let patched = html;

scriptBlocks.forEach(b => { patched = patched.replace(b.full, ''); });

const SCRIPT_TAG = '<script src="/js/dashboard.js"></script>';
patched = patched.replace(/<\/body>/, `${SCRIPT_TAG}\n</body>`);

// Collapse 3+ blank lines to 1
patched = patched.replace(/\n{3,}/g, '\n\n');

fs.writeFileSync(HTML_FILE, patched, 'utf8');
console.log(`Patched index.html — removed ${scriptBlocks.length} inline <script> blocks, added <script src> tag`);

// Verify
const remaining = (patched.match(/<script>/g) || []).length;
if (remaining > 0) {
  console.error(`\nERROR: ${remaining} bare <script> block(s) still remain in index.html!`);
  process.exit(1);
}
if (!patched.includes(SCRIPT_TAG)) {
  console.error('\nERROR: <script src> tag not found in patched index.html!');
  process.exit(1);
}

console.log(`Verification passed — 0 inline <script> blocks remain, <script src> tag present.\n`);
