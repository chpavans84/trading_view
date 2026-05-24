/**
 * src/web/routes/push.js
 *
 * Web-push subscription management for the mobile PWA. Used by the
 * subscribePush() chip in mobile.html.
 *
 * Routes:
 *   GET    /api/push/vapid-key   — returns public VAPID key (safe to expose)
 *   POST   /api/push/subscribe   — store/refresh user's PushSubscription
 *   DELETE /api/push/unsubscribe — remove subscription by endpoint
 */

import { query } from '../../core/db.js';

export function registerPushRoutes(app, { requireAuth }) {
  app.get('/api/push/vapid-key', (req, res) => {
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) return res.status(503).json({ error: 'VAPID not configured' });
    res.json({ vapidPublicKey: key });
  });

  app.post('/api/push/subscribe', requireAuth, async (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Missing subscription fields' });
    }
    const username = req.session.username;
    try {
      await query(
        `INSERT INTO push_subscriptions (username, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (username, endpoint) DO UPDATE SET p256dh = $3, auth = $4`,
        [username, endpoint, keys.p256dh, keys.auth]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/push/unsubscribe', requireAuth, async (req, res) => {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
    const username = req.session.username;
    try {
      await query(
        `DELETE FROM push_subscriptions WHERE username = $1 AND endpoint = $2`,
        [username, endpoint]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
