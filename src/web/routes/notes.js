/**
 * src/web/routes/notes.js
 *
 * Personal trade-journal notes (user_notes table). Free-text per user.
 *
 * Routes:
 *   GET    /api/notes         — list current user's notes (newest first, cap 200)
 *   POST   /api/notes         — create a note { title, body, symbol? }
 *   DELETE /api/notes/:id     — delete a note (own-user enforced)
 */

import { query } from '../../core/db.js';

export function registerNotesRoutes(app, { requireAuth }) {
  app.get('/api/notes', requireAuth, async (req, res) => {
    try {
      const username = req.session.username;
      const { rows } = await query(
        `SELECT id, title, body, symbol, created_at
         FROM user_notes
         WHERE username = $1
         ORDER BY created_at DESC
         LIMIT 200`,
        [username]
      );
      res.json({ notes: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/notes', requireAuth, async (req, res) => {
    try {
      const username = req.session.username;
      const { title = '', body = '', symbol = '' } = req.body || {};
      if (!title.trim() && !body.trim()) {
        return res.status(400).json({ error: 'Note is empty' });
      }
      const { rows } = await query(
        `INSERT INTO user_notes (username, title, body, symbol)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, body, symbol, created_at`,
        [
          username,
          title.trim(),
          body.trim(),
          (symbol || '').trim().toUpperCase().slice(0, 20) || null,
        ]
      );
      res.json({ note: rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/notes/:id', requireAuth, async (req, res) => {
    try {
      const username = req.session.username;
      await query(
        `DELETE FROM user_notes WHERE id = $1 AND username = $2`,
        [parseInt(req.params.id), username]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
