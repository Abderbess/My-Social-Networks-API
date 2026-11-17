const router = require('express').Router();
const db = require('../db');

const BOOLS = ['shopping_list_enabled', 'carpool_enabled', 'ticketing_enabled', 'share_enabled'];

// Charge un événement avec ses organisateurs et ses participants
function loadEvent(id) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!event) return null;
  for (const b of BOOLS) event[b] = !!event[b];
  const members = db
    .prepare(
      `SELECT u.id, u.first_name, u.last_name, u.email, m.role
       FROM event_members m JOIN users u ON u.id = m.user_id
       WHERE m.event_id = ? ORDER BY u.id`
    )
    .all(id);
  event.organizers = members.filter((m) => m.role === 'organizer');
  event.participants = members.filter((m) => m.role === 'participant');
  return event;
}

// ÉTAPE 1 : configurer l'événement (crée un brouillon)
router.post('/', (req, res) => {
  const { name, description, start_date, end_date, location, cover_url, visibility, created_by } = req.body;
  const organizers = req.body.organizers ?? [];
  const members = req.body.members ?? [];

  if (!name || !start_date || !end_date || !location || !visibility || !created_by) {
    return res.status(400).json({
      error: 'name, start_date, end_date, location, visibility et created_by sont obligatoires',
    });
  }
  if (!['public', 'private'].includes(visibility)) {
    return res.status(400).json({ error: 'visibility doit valoir public ou private' });
  }
  const start = Date.parse(start_date);
  const end = Date.parse(end_date);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return res.status(400).json({ error: 'Dates invalides (format attendu : 2027-02-01T18:00:00Z)' });
  }
  if (end <= start) {
    return res.status(400).json({ error: 'end_date doit être après start_date' });
  }
  if (!Array.isArray(organizers) || !Array.isArray(members)) {
    return res.status(400).json({ error: 'organizers et members doivent être des tableaux d\'identifiants' });
  }

  // L'auteur est automatiquement organisateur
  const orgIds = new Set([created_by, ...organizers]);
  const memIds = new Set(members.filter((id) => !orgIds.has(id)));
  const unknown = [...orgIds, ...memIds].filter((id) => !db.prepare('SELECT 1 FROM users WHERE id = ?').get(id));
  if (unknown.length) {
    return res.status(422).json({ error: `Utilisateurs inconnus : ${unknown.join(', ')}` });
  }

  db.exec('BEGIN');
  try {
    const r = db
      .prepare(
        'INSERT INTO events (name, description, start_date, end_date, location, cover_url, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(name, description ?? null, new Date(start).toISOString(), new Date(end).toISOString(), location, cover_url ?? null, visibility);
    const add = db.prepare('INSERT INTO event_members (event_id, user_id, role) VALUES (?, ?, ?)');
    orgIds.forEach((id) => add.run(r.lastInsertRowid, id, 'organizer'));
    memIds.forEach((id) => add.run(r.lastInsertRowid, id, 'participant'));
    db.exec('COMMIT');
    res.status(201).json(loadEvent(r.lastInsertRowid));
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// Lire un événement
router.get('/:id', (req, res) => {
  const event = loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable' });
  res.json(event);
});

module.exports = { router, loadEvent };