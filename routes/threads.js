const router = require('express').Router();
const db = require('../db');
const { eventRole, groupRole } = require('../lib/helpers');
const { threadAccess } = require('../lib/threadAccess');

const AUTHOR_SQL = `SELECT m.*, u.first_name AS author_first_name, u.last_name AS author_last_name
  FROM messages m JOIN users u ON u.id = m.author_id`;

function loadThread(id) {
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  if (!thread) return null;
  thread.messages_count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').get(id).n;
  return thread;
}

router.post('/', (req, res) => {
  const { group_id, event_id, title, created_by } = req.body;
  if (!group_id === !event_id) {
    return res.status(400).json({ error: 'Un fil doit être lié à 1 groupe (group_id) ou 1 événement (event_id), mais pas les deux' });
  }
  if (!created_by) return res.status(400).json({ error: 'created_by est obligatoire' });
  if (group_id) {
    if (!db.prepare('SELECT 1 FROM groups WHERE id = ?').get(group_id)) return res.status(404).json({ error: 'Groupe introuvable' });
    if (groupRole(group_id, created_by) !== 'admin') return res.status(403).json({ error: 'created_by doit être administrateur du groupe' });
  } else {
    if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(event_id)) return res.status(404).json({ error: 'Événement introuvable' });
    if (eventRole(event_id, created_by) !== 'organizer') return res.status(403).json({ error: 'created_by doit être organisateur de l\'événement' });
  }
  const r = db
    .prepare('INSERT INTO threads (title, group_id, event_id) VALUES (?, ?, ?)')
    .run(title || 'Discussion', group_id ?? null, event_id ?? null);
  res.status(201).json(loadThread(r.lastInsertRowid));
});

router.get('/', (req, res) => {
  const { group_id, event_id, user_id } = req.query;
  if (!group_id === !event_id) return res.status(400).json({ error: 'Précisez group_id ou event_id' });
  const exists = group_id
    ? db.prepare('SELECT 1 FROM groups WHERE id = ?').get(group_id)
    : db.prepare('SELECT 1 FROM events WHERE id = ?').get(event_id);
  if (!exists) return res.status(404).json({ error: group_id ? 'Groupe introuvable' : 'Événement introuvable' });
  const access = threadAccess({ group_id, event_id }, user_id);
  if (!access.exists) return res.status(404).json({ error: group_id ? 'Groupe introuvable' : 'Événement introuvable' });
  if (!access.visible) return res.status(403).json({ error: 'Fils réservés aux membres (user_id)' });
  const rows = group_id
    ? db.prepare('SELECT id FROM threads WHERE group_id = ? ORDER BY id').all(group_id)
    : db.prepare('SELECT id FROM threads WHERE event_id = ? ORDER BY id').all(event_id);
  res.json(rows.map((r) => loadThread(r.id)));
});

router.get('/:id', (req, res) => {
  const thread = loadThread(req.params.id);
  if (!thread || !threadAccess(thread, req.query.user_id).exists) return res.status(404).json({ error: 'Fil de discussion introuvable' });
  if (!threadAccess(thread, req.query.user_id).visible) return res.status(403).json({ error: 'Fil réservé aux membres (user_id)' });
  res.json(thread);
});

router.patch('/:id', (req, res) => {
  const thread = loadThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Fil de discussion introuvable' });
  if (!req.body.title) return res.status(400).json({ error: 'title est obligatoire' });
  db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(req.body.title, thread.id);
  res.json(loadThread(thread.id));
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM threads WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Fil de discussion introuvable' });
  res.status(204).end();
});


router.get('/:id/messages', (req, res) => {
  const thread = loadThread(req.params.id);
  if (!thread || !threadAccess(thread, req.query.user_id).exists) return res.status(404).json({ error: 'Fil de discussion introuvable' });
  if (!threadAccess(thread, req.query.user_id).visible) return res.status(403).json({ error: 'Fil réservé aux membres (user_id)' });
  const messages = db.prepare(`${AUTHOR_SQL} WHERE m.thread_id = ? ORDER BY m.created_at, m.id`).all(thread.id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM message_comments WHERE message_id = ?');
  res.json(messages.map((m) => ({ ...m, comments_count: count.get(m.id).n })));
});

router.post('/:id/messages', (req, res) => {
  const thread = loadThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Fil de discussion introuvable' });
  const { author_id, content } = req.body;
  if (!author_id || !content) return res.status(400).json({ error: 'author_id et content sont obligatoires' });
  const access = threadAccess(thread, author_id);
  if (!access.member) return res.status(403).json({ error: 'Seuls les membres du groupe / participants de l\'événement peuvent écrire' });
  if (!access.canPost) return res.status(403).json({ error: 'Les membres ne sont pas autorisés à publier dans ce groupe' });
  const r = db.prepare('INSERT INTO messages (thread_id, author_id, content) VALUES (?, ?, ?)').run(thread.id, author_id, content);
  res.status(201).json(db.prepare(`${AUTHOR_SQL} WHERE m.id = ?`).get(r.lastInsertRowid));
});

module.exports = { router, loadThread, AUTHOR_SQL };
