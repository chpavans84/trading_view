/**
 * src/web/routes/system-alerts.js
 *
 * Read-only inspection of the system_alerts table (used by the dashboard's
 * Alerts widget) + admin-only synthetic-alert injection for testing.
 *
 * Routes:
 *   GET  /api/system-alerts/recent      — last N alerts (limit ≤ 200)
 *   GET  /api/system-alerts/:id         — full alert detail
 *   POST /api/system-alerts/test        — admin only — fires a synthetic alert
 */

import { query, isDbAvailable } from '../../core/db.js';
import { alert as sysAlert } from '../../core/system-alerts.js';

export function registerSystemAlertsRoutes(app, { requireAuth, requireAdmin }) {
  app.get('/api/system-alerts/recent', requireAuth, async (req, res) => {
    if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
    try {
      const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
      const r = await query(
        `SELECT id, key, severity, title, email_sent, email_suppressed, email_error, created_at
         FROM system_alerts
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      res.json({ alerts: r.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/system-alerts/:id', requireAuth, async (req, res) => {
    if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
    try {
      const r = await query(`SELECT * FROM system_alerts WHERE id = $1`, [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      res.json(r.rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/system-alerts/test', requireAuth, requireAdmin, async (req, res) => {
    const { severity = 'warn', title = 'Test alert' } = req.body || {};
    try {
      const row = await sysAlert({
        key: 'system/test',
        severity,
        title,
        detail: { triggered_by: req.session?.username },
      });
      res.json({ ok: true, row });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
