const router = require('express').Router();
const db = require('../db');
const { eventRole } = require('../lib/helpers');
const { visibleEvent } = require('../lib/eventAccess');
const { PHOTO_SQL } = require('./albums');

const COMMENT_SQL = `SELECT c.*, u.first_name AS author_first_name, u.last_name AS author_last_name
  FROM photo_comments c JOIN users u ON u.id = c.author_id`;

const loadPhoto = (id) =>
  db.prepare(`${PHOTO_SQL.replace('FROM photos p', ', a.event_id FROM photos p JOIN albums a ON a.id = p.album_id')} WHERE p.id = ?`).get(id);

// Lire une photo avec ses commentaires
router.get('/:id', (req, res) => {
  const photo = loadPhoto(req.params.id);
  if (!photo || !visibleEvent(photo.event_id, req.query.user_id)) return res.status(404).json({ error: 'Photo introuvable' });
  photo.comments = db.prepare(`${COMMENT_SQL} WHERE c.photo_id = ? ORDER BY c.created_at, c.id`).all(photo.id);
  res.json(photo);
});

router.patch('/:id', (req, res) => {
  const photo = loadPhoto(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo introuvable' });
  const { user_id, url, caption } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id est obligatoire' });
  if (url === undefined && caption === undefined) return res.status(400).json({ error: 'Aucun champ à modifier : url, caption' });
  if (Number(user_id) !== photo.author_id) return res.status(403).json({ error: 'Seul l\'auteur peut modifier sa photo' });
  db.prepare('UPDATE photos SET url = ?, caption = ? WHERE id = ?').run(url || photo.url, caption !== undefined ? caption : photo.caption, photo.id);
  res.json(loadPhoto(photo.id));
});

router.delete('/:id', (req, res) => {
  const photo = loadPhoto(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo introuvable' });
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id est obligatoire (query)' });
  if (Number(user_id) !== photo.author_id && eventRole(photo.event_id, user_id) !== 'organizer') {
    return res.status(403).json({ error: 'Seul l\'auteur ou un organisateur peut supprimer cette photo' });
  }
  db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  res.status(204).end();
});


router.get('/:id/comments', (req, res) => {
  const photo = loadPhoto(req.params.id);
  if (!photo || !visibleEvent(photo.event_id, req.query.user_id)) return res.status(404).json({ error: 'Photo introuvable' });
  res.json(db.prepare(`${COMMENT_SQL} WHERE c.photo_id = ? ORDER BY c.created_at, c.id`).all(photo.id));
});

router.post('/:id/comments', (req, res) => {
  const photo = loadPhoto(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo introuvable' });
  const { author_id, content } = req.body;
  if (!author_id || !content) return res.status(400).json({ error: 'author_id et content sont obligatoires' });
  if (!eventRole(photo.event_id, author_id)) return res.status(403).json({ error: 'Seuls les participants de l\'événement peuvent commenter' });
  const r = db.prepare('INSERT INTO photo_comments (photo_id, author_id, content) VALUES (?, ?, ?)').run(photo.id, author_id, content);
  res.status(201).json(db.prepare(`${COMMENT_SQL} WHERE c.id = ?`).get(r.lastInsertRowid));
});

router.patch('/:id/comments/:commentId', (req, res) => {
  const comment = db.prepare('SELECT * FROM photo_comments WHERE id = ? AND photo_id = ?').get(req.params.commentId, req.params.id);
  if (!comment) return res.status(404).json({ error: 'Commentaire introuvable' });
  const { user_id, content } = req.body;
  if (!user_id || !content) return res.status(400).json({ error: 'user_id et content sont obligatoires' });
  if (Number(user_id) !== comment.author_id) return res.status(403).json({ error: 'Seul l\'auteur peut modifier son commentaire' });
  db.prepare("UPDATE photo_comments SET content = ?, updated_at = datetime('now') WHERE id = ?").run(content, comment.id);
  res.json(db.prepare(`${COMMENT_SQL} WHERE c.id = ?`).get(comment.id));
});

router.delete('/:id/comments/:commentId', (req, res) => {
  const comment = db.prepare('SELECT * FROM photo_comments WHERE id = ? AND photo_id = ?').get(req.params.commentId, req.params.id);
  if (!comment) return res.status(404).json({ error: 'Commentaire introuvable' });
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id est obligatoire (query)' });
  const photo = loadPhoto(req.params.id);
  if (Number(user_id) !== comment.author_id && eventRole(photo.event_id, user_id) !== 'organizer') {
    return res.status(403).json({ error: 'Seul l\'auteur ou un organisateur peut supprimer ce commentaire' });
  }
  db.prepare('DELETE FROM photo_comments WHERE id = ?').run(comment.id);
  res.status(204).end();
});

module.exports = router;
