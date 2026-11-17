const router = require('express').Router();
const db = require('../db');

const FIELDS = ['email', 'first_name', 'last_name', 'avatar_url', 'bio'];

// Renvoie true (et répond 409) si l'erreur vient d'un email déjà utilisé
const emailTaken = (e, res) => {
  if (/UNIQUE constraint failed/.test(e.message)) {
    res.status(409).json({ error: 'Cet email est déjà utilisé' });
    return true;
  }
  return false;
};

// Créer un utilisateur
router.post('/', (req, res) => {
  const { email, first_name, last_name, avatar_url, bio } = req.body;
  if (!email || !first_name || !last_name) {
    return res.status(400).json({ error: 'email, first_name et last_name sont obligatoires' });
  }
  try {
    const r = db
      .prepare('INSERT INTO users (email, first_name, last_name, avatar_url, bio) VALUES (?, ?, ?, ?, ?)')
      .run(email.trim().toLowerCase(), first_name, last_name, avatar_url ?? null, bio ?? null);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json(user);
  } catch (e) {
    if (emailTaken(e, res)) return;
    throw e;
  }
});

// Lister / rechercher : GET /users?q=ali
router.get('/', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const users = db
    .prepare('SELECT * FROM users WHERE first_name LIKE ? OR last_name LIKE ? OR email LIKE ? ORDER BY id')
    .all(q, q, q);
  res.json(users);
});

// Lire un utilisateur
router.get('/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(user);
});


// Remplacer complètement (PUT)
router.put('/:id', (req, res) => {
  const { email, first_name, last_name, avatar_url, bio } = req.body;
  if (!email || !first_name || !last_name) {
    return res.status(400).json({ error: 'email, first_name et last_name sont obligatoires' });
  }
  try {
    const r = db
      .prepare('UPDATE users SET email = ?, first_name = ?, last_name = ?, avatar_url = ?, bio = ? WHERE id = ?')
      .run(email.trim().toLowerCase(), first_name, last_name, avatar_url ?? null, bio ?? null, req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id));
  } catch (e) {
    if (emailTaken(e, res)) return;
    throw e;
  }
});

// Modifier partiellement (PATCH)
router.patch('/:id', (req, res) => {
  const keys = FIELDS.filter((k) => req.body[k] !== undefined);
  if (keys.length === 0) return res.status(400).json({ error: 'Aucun champ à modifier' });
  const values = keys.map((k) => (k === 'email' ? String(req.body[k]).trim().toLowerCase() : req.body[k]));
  try {
    const r = db
      .prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...values, req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id));
  } catch (e) {
    if (emailTaken(e, res)) return;
    throw e;
  }
});

// Supprimer
router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.status(204).end();
});

module.exports = router;