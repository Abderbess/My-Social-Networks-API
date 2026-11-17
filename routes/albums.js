const router = require('express').Router();
const db = require('../db');
const { eventRole } = require('../lib/helpers');
const { visibleEvent } = require('../lib/eventAccess');

const PHOTO_SQL = `SELECT p.*, u.first_name AS author_first_name, u.last_name AS author_last_name
  FROM photos p JOIN users u ON u.id = p.author_id`;

function loadAlbum(id) {
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(id);
  if (!album) return null;
  album.photos_count = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE album_id = ?').get(id).n;
  return album;
}

router.post('/', (req, res) => {
  const { event_id, name, description, created_by } = req.body;
  if (!event_id || !name || !created_by) return res.status(400).json({ error: 'event_id, name et created_by sont obligatoires' });
  if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(event_id)) return res.status(404).json({ error: 'Événement introuvable' });
  if (!eventRole(event_id, created_by)) return res.status(403).json({ error: 'created_by doit participer à l\'événement' });
  const r = db.prepare('INSERT INTO albums (event_id, name, description, created_by) VALUES (?, ?, ?, ?)').run(event_id, name, description ?? null, created_by);
  res.status(201).json(loadAlbum(r.lastInsertRowid));
});

router.get('/', (req, res) => {
  const { event_id, user_id } = req.query;
  if (!event_id) return res.status(400).json({ error: 'event_id est obligatoire' });
  if (!visibleEvent(event_id, user_id)) return res.status(404).json({ error: 'Événement introuvable' });
  const rows = db.prepare('SELECT id FROM albums WHERE event_id = ? ORDER BY id').all(event_id);
  res.json(rows.map((r) => loadAlbum(r.id)));
});

router.get('/:id', (req, res) => {
  const album = loadAlbum(req.params.id);
  if (!album || !visibleEvent(album.event_id, req.query.user_id)) return res.status(404).json({ error: 'Album introuvable' });
  album.photos = db.prepare(`${PHOTO_SQL} WHERE p.album_id = ? ORDER BY p.id`).all(album.id);
  res.json(album);
});

router.patch('/:id', (req, res) => {
  const album = loadAlbum(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album introuvable' });
  const { name, description } = req.body;
  if (name === undefined && description === undefined) return res.status(400).json({ error: 'Aucun champ à modifier : name, description' });
  if (name !== undefined && !name) return res.status(400).json({ error: 'name ne peut pas être vide' });
  db.prepare('UPDATE albums SET name = ?, description = ? WHERE id = ?').run(name ?? album.name, description !== undefined ? description : album.description, album.id);
  res.json(loadAlbum(album.id));
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM albums WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Album introuvable' });
  res.status(204).end();
});


router.get('/:id/photos', (req, res) => {
  const album = loadAlbum(req.params.id);
  if (!album || !visibleEvent(album.event_id, req.query.user_id)) return res.status(404).json({ error: 'Album introuvable' });
  res.json(db.prepare(`${PHOTO_SQL} WHERE p.album_id = ? ORDER BY p.id`).all(album.id));
});

router.post('/:id/photos', (req, res) => {
  const album = loadAlbum(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album introuvable' });
  const { author_id, url, caption } = req.body;
  if (!author_id || !url) return res.status(400).json({ error: 'author_id et url sont obligatoires' });
  if (!eventRole(album.event_id, author_id)) return res.status(403).json({ error: 'Seuls les participants de l\'événement peuvent poster des photos' });
  const r = db.prepare('INSERT INTO photos (album_id, author_id, url, caption) VALUES (?, ?, ?, ?)').run(album.id, author_id, url, caption ?? null);
  res.status(201).json(db.prepare(`${PHOTO_SQL} WHERE p.id = ?`).get(r.lastInsertRowid));
});

module.exports = { router, PHOTO_SQL };
