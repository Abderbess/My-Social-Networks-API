const router = require('express').Router();
const db = require('../db');
const { threadAccess } = require('../lib/threadAccess');
const { AUTHOR_SQL } = require('./threads');

const COMMENT_SQL = `SELECT c.*, u.first_name AS author_first_name, u.last_name AS author_last_name
  FROM message_comments c JOIN users u ON u.id = c.author_id`;

const loadMessage = (id) => db.prepare(`${AUTHOR_SQL} WHERE m.id = ?`).get(id);
const threadOf = (message) => db.prepare('SELECT * FROM threads WHERE id = ?').get(message.thread_id);

router.get('/:id', (req, res) => {
  const message = loadMessage(req.params.id);
  if (!message) return res.status(404).json({ error: 'Message introuvable' });
  const access = threadAccess(threadOf(message), req.query.user_id);
  if (!access.exists) return res.status(404).json({ error: 'Message introuvable' });
  if (!access.visible) return res.status(403).json({ error: 'Message réservé aux membres (user_id)' });
  message.comments = db.prepare(`${COMMENT_SQL} WHERE c.message_id = ? ORDER BY c.created_at, c.id`).all(message.id);
  res.json(message);
});

router.patch('/:id', (req, res) => {
  const message = loadMessage(req.params.id);
  if (!message) return res.status(404).json({ error: 'Message introuvable' });
  const { user_id, content } = req.body;
  if (!user_id || !content) return res.status(400).json({ error: 'user_id et content sont obligatoires' });
  if (Number(user_id) !== message.author_id) return res.status(403).json({ error: 'Seul l\'auteur peut modifier son message' });
  db.prepare("UPDATE messages SET content = ?, updated_at = datetime('now') WHERE id = ?").run(content, message.id);
  res.json(loadMessage(message.id));
});

router.delete('/:id', (req, res) => {
  const message = loadMessage(req.params.id);
  if (!message) return res.status(404).json({ error: 'Message introuvable' });
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id est obligatoire (query)' });
  if (Number(user_id) !== message.author_id && !threadAccess(threadOf(message), user_id).manager) {
    return res.status(403).json({ error: 'Seul l\'auteur ou un administrateur / organisateur peut supprimer ce message' });
  }
  db.prepare('DELETE FROM messages WHERE id = ?').run(message.id);
  res.status(204).end();
});


router.get('/:id/comments', (req, res) => {
  const message = loadMessage(req.params.id);
  if (!message) return res.status(404).json({ error: 'Message introuvable' });
  const access = threadAccess(threadOf(message), req.query.user_id);
  if (!access.exists) return res.status(404).json({ error: 'Message introuvable' });
  if (!access.visible) return res.status(403).json({ error: 'Réservé aux membres (user_id)' });
  res.json(db.prepare(`${COMMENT_SQL} WHERE c.message_id = ? ORDER BY c.created_at, c.id`).all(message.id));
});

router.post('/:id/comments', (req, res) => {
  const message = loadMessage(req.params.id);
  if (!message) return res.status(404).json({ error: 'Message introuvable' });
  const { author_id, content } = req.body;
  if (!author_id || !content) return res.status(400).json({ error: 'author_id et content sont obligatoires' });
  if (!threadAccess(threadOf(message), author_id).member) {
    return res.status(403).json({ error: 'Seuls les membres / participants peuvent commenter' });
  }
  const r = db.prepare('INSERT INTO message_comments (message_id, author_id, content) VALUES (?, ?, ?)').run(message.id, author_id, content);
  res.status(201).json(db.prepare(`${COMMENT_SQL} WHERE c.id = ?`).get(r.lastInsertRowid));
});

router.patch('/:id/comments/:commentId', (req, res) => {
  const comment = db.prepare(`${COMMENT_SQL} WHERE c.id = ? AND c.message_id = ?`).get(req.params.commentId, req.params.id);
  if (!comment) return res.status(404).json({ error: 'Commentaire introuvable' });
  const { user_id, content } = req.body;
  if (!user_id || !content) return res.status(400).json({ error: 'user_id et content sont obligatoires' });
  if (Number(user_id) !== comment.author_id) return res.status(403).json({ error: 'Seul l\'auteur peut modifier son commentaire' });
  db.prepare("UPDATE message_comments SET content = ?, updated_at = datetime('now') WHERE id = ?").run(content, comment.id);
  res.json(db.prepare(`${COMMENT_SQL} WHERE c.id = ?`).get(comment.id));
});

router.delete('/:id/comments/:commentId', (req, res) => {
  const comment = db.prepare('SELECT * FROM message_comments WHERE id = ? AND message_id = ?').get(req.params.commentId, req.params.id);
  if (!comment) return res.status(404).json({ error: 'Commentaire introuvable' });
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id est obligatoire (query)' });
  const message = loadMessage(req.params.id);
  if (Number(user_id) !== comment.author_id && !threadAccess(threadOf(message), user_id).manager) {
    return res.status(403).json({ error: 'Seul l\'auteur ou un administrateur / organisateur peut supprimer ce commentaire' });
  }
  db.prepare('DELETE FROM message_comments WHERE id = ?').run(comment.id);
  res.status(204).end();
});

module.exports = router;
