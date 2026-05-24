/**
 * src/web/routes/sentinel.js
 *
 * Read-only Sentinel run inspection routes (used by the dashboard's
 * Sentinel Activity widget). The manual-trigger POST lives in admin
 * routes since it requires admin privileges.
 *
 * Routes:
 *   GET /api/sentinel/recent?limit=20    — last N sentinel runs
 *   GET /api/sentinel/runs/:id           — full JSON detail of one run
 */

import { query, isDbAvailable } from '../../core/db.js';

export function registerSentinelRoutes(app, { requireAuth }) {
  app.get('/api/sentinel/recent', requireAuth, async (req, res) => {
    if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
    try {
      const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
      const { rows } = await query(
        `SELECT id, mode, as_of, email_sent, error,
                jsonb_array_length(COALESCE(risks_json, '[]'::jsonb))     AS risk_count,
                jsonb_array_length(COALESCE(proposals_json, '[]'::jsonb)) AS proposal_count
         FROM sentinel_runs
         ORDER BY as_of DESC
         LIMIT $1`,
        [limit]
      );
      res.json({ runs: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/sentinel/runs/:id', requireAuth, async (req, res) => {
    if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
    try {
      const { rows } = await query(
        `SELECT * FROM sentinel_runs WHERE id = $1`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      res.json(rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
