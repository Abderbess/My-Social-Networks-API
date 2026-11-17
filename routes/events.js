const router = require('express').Router();
const db = require('../db');
const { eventRole, groupRole, userExists, toIso, transaction } = require('../lib/helpers');

const BOOLS = ['shopping_list_enabled', 'carpool_enabled', 'ticketing_enabled', 'share_enabled'];

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

function checkEventBody(body, { partial = false } = {}) {
  const { name, start_date, end_date, location, visibility } = body;
  if (!partial && (!name || !start_date || !end_date || !location || !visibility)) {
    return { status: 400, error: 'name, start_date, end_date, location et visibility sont obligatoires' };
  }
  for (const f of ['name', 'location']) {
    if (partial && body[f] !== undefined && !body[f]) return { status: 400, error: `${f} ne peut pas être vide` };
  }
  if (visibility !== undefined && !['public', 'private'].includes(visibility)) {
    return { status: 400, error: 'visibility doit valoir public ou private' };
  }
  for (const f of ['start_date', 'end_date']) {
    if (body[f] !== undefined && Number.isNaN(Date.parse(body[f]))) {
      return { status: 400, error: 'Dates invalides (format attendu : 2027-02-01T18:00:00Z)' };
    }
  }
  return null;
}

function insertEvent(body, orgIds, memIds, groupId = null) {
  const { name, description, start_date, end_date, location, cover_url, visibility } = body;
  return transaction(() => {
    const r = db
      .prepare(
        'INSERT INTO events (name, description, start_date, end_date, location, cover_url, visibility, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(name, description ?? null, toIso(start_date), toIso(end_date), location, cover_url ?? null, visibility, groupId);
    const add = db.prepare('INSERT INTO event_members (event_id, user_id, role) VALUES (?, ?, ?)');
    orgIds.forEach((id) => add.run(r.lastInsertRowid, id, 'organizer'));
    memIds.forEach((id) => add.run(r.lastInsertRowid, id, 'participant'));
    return r.lastInsertRowid;
  });
}

router.post('/', (req, res) => {
  const { created_by } = req.body;
  const organizers = req.body.organizers ?? [];
  const members = req.body.members ?? [];

  const err = checkEventBody(req.body);
  if (err) return res.status(err.status).json({ error: err.error });
  if (!created_by) return res.status(400).json({ error: 'created_by est obligatoire' });
  if (Date.parse(req.body.end_date) <= Date.parse(req.body.start_date)) {
    return res.status(400).json({ error: 'end_date doit être après start_date' });
  }
  if (!Array.isArray(organizers) || !Array.isArray(members)) {
    return res.status(400).json({ error: 'organizers et members doivent être des tableaux d\'identifiants' });
  }

  const orgIds = new Set([created_by, ...organizers]);
  const memIds = new Set(members.filter((id) => !orgIds.has(id)));
  const unknown = [...orgIds, ...memIds].filter((id) => !userExists(id));
  if (unknown.length) {
    return res.status(422).json({ error: `Utilisateurs inconnus : ${unknown.join(', ')}` });
  }

  const id = insertEvent(req.body, orgIds, memIds);
  res.status(201).json(loadEvent(id));
});

router.get('/', (req, res) => {
  const { q, visibility, status, user_id } = req.query;

  if (visibility && !['public', 'private'].includes(visibility)) {
    return res.status(400).json({ error: 'visibility doit valoir public ou private' });
  }
  if (status && !['draft', 'published'].includes(status)) {
    return res.status(400).json({ error: 'status doit valoir draft ou published' });
  }
  if (user_id && Number.isNaN(Number(user_id))) {
    return res.status(400).json({ error: 'user_id doit être un nombre' });
  }

  const where = [];
  const params = [];

  if (user_id) {
    where.push(
      "((e.visibility = 'public' AND e.status = 'published') OR e.id IN (SELECT event_id FROM event_members WHERE user_id = ?))"
    );
    params.push(Number(user_id));
  } else {
    where.push("e.visibility = 'public' AND e.status = 'published'");
  }
  if (q) {
    where.push('(e.name LIKE ? OR e.description LIKE ? OR e.location LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (visibility) {
    where.push('e.visibility = ?');
    params.push(visibility);
  }
  if (status) {
    where.push('e.status = ?');
    params.push(status);
  }

  const rows = db
    .prepare(`SELECT e.id FROM events e WHERE ${where.join(' AND ')} ORDER BY e.start_date, e.id`)
    .all(...params);
  res.json(rows.map((r) => loadEvent(r.id)));
});

router.get('/:id', (req, res) => {
  const event = loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable' });
  res.json(event);
});

router.patch('/:id/options', (req, res) => {
  const event = loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable' });

  const given = BOOLS.filter((f) => req.body[f] !== undefined);

  if (given.length === 0) {
    return res.status(400).json({ error: 'Au moins une option est requise : ' + BOOLS.join(', ') });
  }
  for (const f of given) {
    if (typeof req.body[f] !== 'boolean') {
      return res.status(400).json({ error: f + ' doit être true ou false' });
    }
  }
  if (req.body.ticketing_enabled === true && event.visibility !== 'public') {
    return res.status(422).json({ error: 'La billetterie est réservée aux événements publics' });
  }

  db.prepare(
    'UPDATE events SET ' + given.map((f) => f + ' = ?').join(', ') + ' WHERE id = ?'
  ).run(...given.map((f) => (req.body[f] ? 1 : 0)), event.id);

  res.json(loadEvent(event.id));
});

router.post('/:id/publish', (req, res) => {
  const event = loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable' });
  if (event.status === 'published') {
    return res.status(409).json({ error: 'Cet événement est déjà publié' });
  }

  db.prepare("UPDATE events SET status = 'published' WHERE id = ?").run(event.id);
  res.json(loadEvent(event.id));
});

router.put('/:id', (req, res) => {
  const event = loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable' });
  const err = checkEventBody(req.body);
  if (err) return res.status(err.status).json({ error: err.error });
  return saveEvent(event, { description: null, cover_url: null, ...req.body }, res);
});

router.patch('/:id', (req, res) => {
  const event = loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable' });
  const err = checkEventBody(req.body, { partial: true });
  if (err) return res.status(err.status).json({ error: err.error });
  if (!EVENT_FIELDS.some((f) => req.body[f] !== undefined)) {
    return res.status(400).json({ error: 'Aucun champ à modifier : ' + EVENT_FIELDS.join(', ') });
  }
  return saveEvent(event, req.body, res);
});

const EVENT_FIELDS = ['name', 'description', 'start_date', 'end_date', 'location', 'cover_url', 'visibility'];

function saveEvent(event, body, res) {
  const next = { ...event };
  for (const f of EVENT_FIELDS) if (body[f] !== undefined) next[f] = body[f];
  if (Date.parse(next.end_date) <= Date.parse(next.start_date)) {
    return res.status(400).json({ error: 'end_date doit être après start_date' });
  }
  if (next.visibility === 'private' && event.ticketing_enabled) {
    return res.status(422).json({ error: 'La billetterie est réservée aux événements publics : désactivez-la d\'abord' });
  }
  db.prepare(
    `UPDATE events SET name = ?, description = ?, start_date = ?, end_date = ?, location = ?, cover_url = ?, visibility = ? WHERE id = ?`
  ).run(next.name, next.description ?? null, toIso(next.start_date), toIso(next.end_date), next.location, next.cover_url ?? null, next.visibility, event.id);
  res.json(loadEvent(event.id));
}

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Événement introuvable' });
  res.status(204).end();
});


router.get('/:id/members', (req, res) => {
  const event = loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable' });
  const { role } = req.query;
  if (role && !['organizer', 'participant'].includes(role)) {
    return res.status(400).json({ error: 'role doit valoir organizer ou participant' });
  }
  const all = [...event.organizers, ...event.participants];
  res.json(role ? all.filter((m) => m.role === role) : all);
});

router.post('/:id/members', (req, res) => {
  const event = loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable' });
  const { user_id, added_by } = req.body;
  const role = req.body.role ?? 'participant';

  if (!user_id) return res.status(400).json({ error: 'user_id est obligatoire' });
  if (!['organizer', 'participant'].includes(role)) {
    return res.status(400).json({ error: 'role doit valoir organizer ou participant' });
  }
  if (!userExists(user_id)) return res.status(422).json({ error: `Utilisateur inconnu : ${user_id}` });

  const selfJoin = role === 'participant' && event.visibility === 'public' && event.status === 'published' && (added_by ?? user_id) === user_id;
  if (!selfJoin && eventRole(event.id, added_by) !== 'organizer') {
    return res.status(403).json({ error: 'added_by doit être un organisateur de l\'événement' });
  }
  if (eventRole(event.id, user_id)) {
    return res.status(409).json({ error: 'Cet utilisateur est déjà membre de l\'événement' });
  }
  db.prepare('INSERT INTO event_members (event_id, user_id, role) VALUES (?, ?, ?)').run(event.id, user_id, role);
  res.status(201).json(loadEvent(event.id));
});

router.patch('/:id/members/:userId', (req, res) => {
  const event = loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable' });
  const { role } = req.body;
  if (!['organizer', 'participant'].includes(role)) {
    return res.status(400).json({ error: 'role doit valoir organizer ou participant' });
  }
  const current = eventRole(event.id, req.params.userId);
  if (!current) return res.status(404).json({ error: 'Cet utilisateur n\'est pas membre de l\'événement' });
  if (current === 'organizer' && role === 'participant' && event.organizers.length === 1) {
    return res.status(409).json({ error: 'Un événement doit garder au moins 1 organisateur' });
  }
  db.prepare('UPDATE event_members SET role = ? WHERE event_id = ? AND user_id = ?').run(role, event.id, req.params.userId);
  res.json(loadEvent(event.id));
});

router.delete('/:id/members/:userId', (req, res) => {
  const event = loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable' });
  const current = eventRole(event.id, req.params.userId);
  if (!current) return res.status(404).json({ error: 'Cet utilisateur n\'est pas membre de l\'événement' });
  if (current === 'organizer' && event.organizers.length === 1) {
    return res.status(409).json({ error: 'Impossible de retirer le dernier organisateur' });
  }
  db.prepare('DELETE FROM event_members WHERE event_id = ? AND user_id = ?').run(event.id, req.params.userId);
  res.status(204).end();
});

router.get('/:id/share', (req, res) => {
  const event = loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable' });
  if (!event.share_enabled) return res.status(422).json({ error: 'Le partage n\'est pas activé pour cet événement (étape 2)' });
  if (event.visibility !== 'public' || event.status !== 'published') {
    return res.status(422).json({ error: 'Seul un événement public et publié peut être partagé' });
  }
  if (event.group_id) {
    const group = db.prepare('SELECT type FROM groups WHERE id = ?').get(event.group_id);
    if (group && group.type !== 'public') {
      return res.status(422).json({ error: 'Seuls les événements d\'un groupe public peuvent être partagés' });
    }
  }
  const url = `${req.protocol}://${req.get('host')}/api/v1/events/${event.id}`;
  const u = encodeURIComponent(url);
  const text = encodeURIComponent(event.name);
  res.json({
    url,
    links: {
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
      x: `https://x.com/intent/tweet?url=${u}&text=${text}`,
      linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
      whatsapp: `https://wa.me/?text=${text}%20${u}`,
    },
  });
});

module.exports = { router, loadEvent, checkEventBody, insertEvent };
