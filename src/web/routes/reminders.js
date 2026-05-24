/**
 * src/web/routes/reminders.js
 *
 * Personal reminders (user_reminders table). The AI can also create
 * reminders via the `set_reminder` tool in ai-chat.js.
 *
 * Routes:
 *   GET    /api/reminders        — list current user's reminders (sorted by remind_at asc)
 *   POST   /api/reminders        — create { title, remind_at }
 *   PATCH  /api/reminders/:id    — toggle dismissed { dismissed: true|false }
 *   DELETE /api/reminders/:id    — delete a reminder (own-user enforced)
 */

import { query } from '../../core/db.js';

export function registerRemindersRoutes(app, { requireAuth }) {
  app.get('/api/reminders', requireAuth, async (req, res) => {
    try {
      const username = req.session.username;
      const { rows } = await query(
        `SELECT id, title, remind_at, dismissed, created_at
         FROM user_reminders
         WHERE username = $1
         ORDER BY remind_at ASC`,
        [username]
      );
      res.json({ reminders: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/reminders', requireAuth, async (req, res) => {
    try {
      const username = req.session.username;
      const { title, remind_at } = req.body || {};
      if (!title || !remind_at) return res.status(400).json({ error: 'title and remind_at required' });
      const dt = new Date(remind_at);
      if (isNaN(dt.getTime())) return res.status(400).json({ error: 'Invalid remind_at date' });

      const { rows } = await query(
        `INSERT INTO user_reminders (username, title, remind_at)
         VALUES ($1, $2, $3)
         RETURNING id, title, remind_at, dismissed, created_at`,
        [username, title.trim(), dt.toISOString()]
      );
      res.json({ reminder: rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/reminders/:id', requireAuth, async (req, res) => {
    try {
      const username = req.session.username;
      const { dismissed } = req.body || {};
      await query(
        `UPDATE user_reminders SET dismissed = $1 WHERE id = $2 AND username = $3`,
        [!!dismissed, parseInt(req.params.id), username]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/reminders/:id', requireAuth, async (req, res) => {
    try {
      const username = req.session.username;
      await query(
        `DELETE FROM user_reminders WHERE id = $1 AND username = $2`,
        [parseInt(req.params.id), username]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
