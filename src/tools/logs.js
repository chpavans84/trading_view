/**
 * src/tools/logs.js
 *
 * MCP tools for log monitoring — same backend (src/core/log-monitor.js) as the
 * 📜 Log Monitor panel on the dashboard's Health tab, so behaviour matches.
 *
 * Use when diagnosing "why is X broken": list the sources, then tail the
 * relevant log with a grep filter instead of guessing.
 *
 * Added 2026-06-12 (logging-overhaul session).
 */

import { z } from 'zod';
import { jsonResult } from './_format.js';
import { listLogSources, tailLog } from '../core/log-monitor.js';

export function registerLogTools(server) {

  server.tool(
    'log_sources',
    'List every application/job log file the platform writes: PM2 process logs (~/.pm2/logs) and launchd/batch job logs (~/Library/Logs), with size and last-modified time, newest first. Use this first to find the right log, then read it with log_tail.',
    {},
    async () => jsonResult(await listLogSources()),
  );

  server.tool(
    'log_tail',
    'Tail a log file (last N lines, default 200, max 2000) with optional case-insensitive substring filter. Each line is classified info/warn/error and the response includes error/warn counts. Source format "<root>:<file.log>" from log_sources, e.g. "pm2:trading-dashboard-error.log" or "jobs:com.pavan.polygon-daily.log". Reads at most 1 MB from the end of the file, so it is safe on huge logs.',
    {
      source: z.string().describe('Log source id from log_sources, e.g. "pm2:trading-dashboard-error.log"'),
      lines:  z.number().int().min(1).max(2000).optional().describe('How many trailing lines (default 200)'),
      grep:   z.string().optional().describe('Case-insensitive substring filter applied before the line cap'),
    },
    async ({ source, lines, grep }) => jsonResult(await tailLog(source, { lines, grep })),
  );
}
