/**
 * ESLint flat config for tradingview-mcp.
 *
 * Philosophy: surface REAL bugs, not stylistic preferences. A 42k LOC
 * codebase with no prior linting will have thousands of warnings on a
 * strict config — most useless. Start narrow, expand later as the codebase
 * gets cleaned up.
 *
 * Rules categorised:
 *   ERROR     — almost always a bug
 *   WARN      — likely a bug, sometimes intentional
 *   OFF       — too noisy on this codebase right now
 *
 * Run:   npm run lint          (errors fail; warns print but don't fail)
 *        npm run lint:fix      (applies auto-fixable rules)
 *        npm run lint:summary  (counts by rule, useful for tracking progress)
 */

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'tests/bot-engine/**',         // legacy strategy harness, ignored intentionally
      'src/web/public/mobile-v1.html',
      'src/web/public/**/*.html',
      'src/web/public/**/*.css',
      'reports/**',
      'tmp/**',
      'screenshots/**',
      'data/**',
      'migrations/**',                // generated migration files
      'src/regime-bot/vendor/**',     // vendored 3rd-party Python (no JS linting)
    ],
  },

  js.configs.recommended,

  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      // ── ERROR: actual bugs we should never ship ───────────────────────────
      'no-undef':                  'error',
      'no-const-assign':           'error',
      'no-dupe-keys':              'error',
      'no-dupe-class-members':     'error',
      'no-duplicate-case':         'error',
      'no-func-assign':            'error',
      'no-unreachable':            'error',
      'no-fallthrough':            'error',
      'no-self-assign':            'error',
      'no-self-compare':           'error',
      'use-isnan':                 'error',
      'valid-typeof':              'error',
      'no-cond-assign':            ['error', 'except-parens'],
      'no-misleading-character-class': 'error',
      'no-prototype-builtins':     'error',
      'no-unsafe-finally':         'error',
      'no-unsafe-negation':        'error',
      'no-import-assign':          'error',
      'no-async-promise-executor': 'error',
      'no-compare-neg-zero':       'error',

      // ── WARN: likely bug, sometimes intentional. Visible in CI without failing build.
      'no-unused-vars': ['warn', {
        args: 'none',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
      }],
      'no-empty':                  ['warn', { allowEmptyCatch: true }],
      'no-constant-condition':     ['warn', { checkLoops: false }],
      'no-useless-catch':          'warn',
      'no-useless-escape':         'warn',
      'no-undef-init':             'warn',
      'no-irregular-whitespace':   'warn',

      // ── OFF: too noisy right now. Revisit after cleanup ────────────────────
      // (None of these enforce correctness — leaving disabled until codebase
      // is split + smaller files make stylistic rules tractable.)
      'no-case-declarations':      'off',   // we use `case 'x': const y = ...` heavily
      'no-inner-declarations':     'off',
      'no-control-regex':          'off',   // pattern in markdown stripper is intentional
    },
  },

  // ── Browser-side scripts (frontend files inside server.js's <script> tags
  //    are embedded HTML — config above already excludes .html so this is
  //    just for any future split-out client JS).
  {
    files: ['src/web/public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },

  // ── Service worker (different globals: self, caches, clients, indexedDB)
  {
    files: ['src/web/public/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },

  // ── CDP-bridge modules: contain template strings sent to TradingView via
  //    Runtime.evaluate. The `evaluate`, `getChartApi`, etc. globals exist in
  //    the BROWSER side, not Node. ESLint can't tell the difference.
  //    Disable no-undef for these files specifically.
  {
    files: [
      'src/core/pine.js',
      'src/core/data.js',
      'src/core/pane.js',
      'src/core/replay.js',
      'src/core/chart.js',
      'src/core/drawing.js',
      'src/agents/error-monitor.js',
      'src/agents/**/*.js',
    ],
    rules: {
      'no-undef': 'off',
    },
  },

  // ── Test files: allow unused args & describe/it globals from node:test
  {
    files: ['tests/**/*.js'],
    rules: {
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
