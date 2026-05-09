#!/usr/bin/env node
/**
 * Extracts all <style>...</style> blocks from index.html into css/dashboard.css
 * and replaces them with a single <link> tag in the <head>.
 *
 * Safe to re-run: if dashboard.css already exists, it overwrites it.
 * Does NOT modify index.html until extraction is verified.
 *
 * Usage:
 *   node scripts/extract-css.js --dry-run   # show stats only, no writes
 *   node scripts/extract-css.js             # write css/dashboard.css + patch index.html
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const HTML_FILE = path.join(ROOT, 'src/web/public/index.html');
const CSS_DIR   = path.join(ROOT, 'src/web/public/css');
const CSS_FILE  = path.join(CSS_DIR, 'dashboard.css');
const DRY_RUN   = process.argv.includes('--dry-run');

const html = fs.readFileSync(HTML_FILE, 'utf8');

// Extract all <style>...</style> blocks (including content between tags)
const styleBlocks = [];
const styleRegex = /<style>([\s\S]*?)<\/style>/g;
let match;
while ((match = styleRegex.exec(html)) !== null) {
  styleBlocks.push({ full: match[0], content: match[1] });
}

console.log(`\nFound ${styleBlocks.length} <style> blocks in index.html`);
styleBlocks.forEach((b, i) => {
  const lines = b.content.split('\n').length;
  console.log(`  Block ${i + 1}: ${lines} lines`);
});

const totalCssLines = styleBlocks.reduce((sum, b) => sum + b.content.split('\n').length, 0);
console.log(`  Total CSS lines to extract: ${totalCssLines}`);

if (DRY_RUN) {
  console.log('\nDry run — no files written.\n');
  process.exit(0);
}

// Write dashboard.css — blocks concatenated in document order
fs.mkdirSync(CSS_DIR, { recursive: true });
const cssContent = styleBlocks.map((b, i) =>
  `/* ── Block ${i + 1} ──────────────────────────────────────────────────────── */\n${b.content.trim()}`
).join('\n\n');
fs.writeFileSync(CSS_FILE, cssContent, 'utf8');
console.log(`\nWrote css/dashboard.css (${cssContent.split('\n').length} lines)`);

// Patch index.html:
// 1. Remove all <style>...</style> blocks
// 2. Insert <link> in <head> after the first <meta> tag
let patched = html;

// Remove all style blocks
styleBlocks.forEach(b => { patched = patched.replace(b.full, ''); });

// Insert link tag right after <head>
const LINK_TAG = '<link rel="stylesheet" href="/css/dashboard.css">';
patched = patched.replace(/<head>/, `<head>\n${LINK_TAG}`);

// Clean up blank lines left by removed style blocks (collapse 3+ blank lines to 1)
patched = patched.replace(/\n{3,}/g, '\n\n');

fs.writeFileSync(HTML_FILE, patched, 'utf8');
console.log(`Patched index.html — removed ${styleBlocks.length} <style> blocks, added <link> tag`);

// Verify: no <style> blocks should remain
const remaining = (patched.match(/<style>/g) || []).length;
if (remaining > 0) {
  console.error(`\nERROR: ${remaining} <style> block(s) still remain in index.html!`);
  process.exit(1);
}
// Verify: link tag is present
if (!patched.includes(LINK_TAG)) {
  console.error('\nERROR: <link> tag not found in patched index.html!');
  process.exit(1);
}

console.log(`Verification passed — 0 <style> blocks remain, <link> tag present.\n`);
