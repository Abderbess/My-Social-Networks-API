const router = require('express').Router();
const db = require('../db');
const { groupRole, userExists, withBools, transaction } = require('../lib/helpers');
const { loadEvent, checkEventBody, insertEvent } = require('./events');

const TYPES = ['public', 'private', 'secret'];
const BOOLS = ['allow_member_posts', 'allow_member_events'];
const FIELDS = ['name', 'description', 'icon_url', 'cover_url', 'type', ...BOOLS];

// Charge un groupe avec ses administrateurs et ses membres
function loadGroup(id) {
  const group = withBools(db.prepare('SELECT * FROM groups WHERE id = ?').get(id), BOOLS);
  if (!group) return null;
  const members = db
    .prepare(
      `SELECT u.id, u.first_name, u.last_name, u.email, m.role
       FROM group_members m JOIN users u ON u.id = m.user_id
       WHERE m.group_id = ? ORDER BY u.id`
    )
    .all(id);
  group.admins = members.filter((m) => m.role === 'admin');
  group.members = members.filter((m) => m.role === 'member');
  group.thread_id = db.prepare('SELECT id FROM threads WHERE group_id = ? ORDER BY id LIMIT 1').get(id)?.id ?? null;
  return group;
}

// Un groupe secret n'existe pas pour ceux qui n'en sont pas membres (404)
function loadVisibleGroup(id, userId) {
  const group = loadGroup(id);
  if (!group || (group.type === 'secret' && !groupRole(id, userId))) return null;
  return group;
}

// Vérifie les paramètres d'un groupe. Renvoie { status, error } ou null
function checkGroupBody(body, { partial = false } = {}) {
  if (!partial && !body.name) return { status: 400, error: 'name est obligatoire' };
  if (partial && body.name !== undefined && !body.name) return { status: 400, error: 'name ne peut pas être vide' };
  if (body.type !== undefined && !TYPES.includes(body.type)) {
    return { status: 400, error: 'type doit valoir public, private ou secret' };
  }
  for (const f of BOOLS) {
    if (body[f] !== undefined && typeof body[f] !== 'boolean') return { status: 400, error: `${f} doit être true ou false` };
  }
  return null;
}

// Créer un groupe : le créateur devient administrateur, un fil de discussion est créé automatiquement
router.post('/', (req, res) => {
  const { name, description, icon_url, cover_url, type, allow_member_posts, allow_member_events, created_by } = req.body;
  const admins = req.body.admins ?? [];
  const members = req.body.members ?? [];

  const err = checkGroupBody(req.body);
  if (err) return res.status(err.status).json({ error: err.error });
  if (!created_by) return res.status(400).json({ error: 'created_by est obligatoire' });
  if (!Array.isArray(admins) || !Array.isArray(members)) {
    return res.status(400).json({ error: 'admins et members doivent être des tableaux d\'identifiants' });
  }

  const adminIds = new Set([created_by, ...admins]);
  const memberIds = new Set(members.filter((id) => !adminIds.has(id)));
  const unknown = [...adminIds, ...memberIds].filter((id) => !userExists(id));
  if (unknown.length) return res.status(422).json({ error: `Utilisateurs inconnus : ${unknown.join(', ')}` });

  const id = transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO groups (name, description, icon_url, cover_url, type, allow_member_posts, allow_member_events)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(name, description ?? null, icon_url ?? null, cover_url ?? null, type ?? 'public',
        allow_member_posts === false ? 0 : 1, allow_member_events ? 1 : 0);
    const add = db.prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)');
    adminIds.forEach((u) => add.run(r.lastInsertRowid, u, 'admin'));
    memberIds.forEach((u) => add.run(r.lastInsertRowid, u, 'member'));
    db.prepare('INSERT INTO threads (title, group_id) VALUES (?, ?)').run(`Discussion - ${name}`, r.lastInsertRowid);
    return r.lastInsertRowid;
  });
  res.status(201).json(loadGroup(id));
});

// Lister / rechercher : GET /groups?q=&type=&user_id=
// Les groupes secrets n'apparaissent que pour leurs membres (user_id)
router.get('/', (req, res) => {
  const { q, type, user_id } = req.query;
  if (type && !TYPES.includes(type)) return res.status(400).json({ error: 'type doit valoir public, private ou secret' });

  const where = [];
  const params = [];
  if (user_id) {
    where.push("(g.type <> 'secret' OR g.id IN (SELECT group_id FROM group_members WHERE user_id = ?))");
    params.push(Number(user_id));
  } else {
    where.push("g.type <> 'secret'");
  }
  if (q) {
    where.push('(g.name LIKE ? OR g.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (type) {
    where.push('g.type = ?');
    params.push(type);
  }
  const rows = db.prepare(`SELECT g.id FROM groups g WHERE ${where.join(' AND ')} ORDER BY g.id`).all(...params);
  res.json(rows.map((r) => loadGroup(r.id)));
});

// Lire un groupe : GET /groups/:id?user_id=
router.get('/:id', (req, res) => {
  const group = loadVisibleGroup(req.params.id, req.query.user_id);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable' });
  res.json(group);
});

// Remplacer les paramètres (PUT) / modifier partiellement (PATCH)
function saveGroup(req, res, partial) {
  const group = loadGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable' });
  const err = checkGroupBody(req.body, { partial });
  if (err) return res.status(err.status).json({ error: err.error });

  const defaults = { description: null, icon_url: null, cover_url: null, type: 'public', allow_member_posts: true, allow_member_events: false };
  const next = partial ? { ...group } : { ...group, ...defaults };
  const given = FIELDS.filter((f) => req.body[f] !== undefined);
  if (partial && given.length === 0) return res.status(400).json({ error: 'Aucun champ à modifier : ' + FIELDS.join(', ') });
  given.forEach((f) => (next[f] = req.body[f]));

  db.prepare(
    `UPDATE groups SET name = ?, description = ?, icon_url = ?, cover_url = ?, type = ?, allow_member_posts = ?, allow_member_events = ? WHERE id = ?`
  ).run(next.name, next.description, next.icon_url, next.cover_url, next.type,
    next.allow_member_posts ? 1 : 0, next.allow_member_events ? 1 : 0, group.id);
  res.json(loadGroup(group.id));
}
router.put('/:id', (req, res) => saveGroup(req, res, false));
router.patch('/:id', (req, res) => saveGroup(req, res, true));

// Supprimer (membres et fil supprimés en cascade, événements détachés du groupe)
router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Groupe introuvable' });
  res.status(204).end();
});

// ---------------- Membres et administrateurs ----------------

router.get('/:id/members', (req, res) => {
  const group = loadVisibleGroup(req.params.id, req.query.user_id);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable' });
  const { role } = req.query;
  if (role && !['admin', 'member'].includes(role)) return res.status(400).json({ error: 'role doit valoir admin ou member' });
  const all = [...group.admins, ...group.members];
  res.json(role ? all.filter((m) => m.role === role) : all);
});

// Ajouter un membre. Groupe public : chacun peut rejoindre seul.
// Groupe privé / secret, ou ajout d'un admin : added_by doit être administrateur.
router.post('/:id/members', (req, res) => {
  const group = loadGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable' });
  const { user_id, added_by } = req.body;
  const role = req.body.role ?? 'member';

  if (!user_id) return res.status(400).json({ error: 'user_id est obligatoire' });
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'role doit valoir admin ou member' });
  if (!userExists(user_id)) return res.status(422).json({ error: `Utilisateur inconnu : ${user_id}` });

  const selfJoin = role === 'member' && group.type === 'public' && (added_by ?? user_id) === user_id;
  if (!selfJoin && groupRole(group.id, added_by) !== 'admin') {
    return res.status(403).json({ error: 'added_by doit être un administrateur du groupe' });
  }
  if (groupRole(group.id, user_id)) return res.status(409).json({ error: 'Cet utilisateur est déjà membre du groupe' });

  db.prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)').run(group.id, user_id, role);
  res.status(201).json(loadGroup(group.id));
});

// Changer le rôle (member <-> admin)
router.patch('/:id/members/:userId', (req, res) => {
  const group = loadGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable' });
  const { role } = req.body;
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'role doit valoir admin ou member' });
  const current = groupRole(group.id, req.params.userId);
  if (!current) return res.status(404).json({ error: 'Cet utilisateur n\'est pas membre du groupe' });
  if (current === 'admin' && role === 'member' && group.admins.length === 1) {
    return res.status(409).json({ error: 'Un groupe doit garder au moins 1 administrateur' });
  }
  db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?').run(role, group.id, req.params.userId);
  res.json(loadGroup(group.id));
});

// Retirer un membre (ou quitter le groupe)
router.delete('/:id/members/:userId', (req, res) => {
  const group = loadGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable' });
  const current = groupRole(group.id, req.params.userId);
  if (!current) return res.status(404).json({ error: 'Cet utilisateur n\'est pas membre du groupe' });
  if (current === 'admin' && group.admins.length === 1) {
    return res.status(409).json({ error: 'Impossible de retirer le dernier administrateur' });
  }
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(group.id, req.params.userId);
  res.status(204).end();
});

// ---------------- Événements du groupe ----------------

router.get('/:id/events', (req, res) => {
  const group = loadVisibleGroup(req.params.id, req.query.user_id);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable' });
  if (group.type !== 'public' && !groupRole(group.id, req.query.user_id)) {
    return res.status(403).json({ error: 'Réservé aux membres du groupe (user_id)' });
  }
  const rows = db.prepare('SELECT id FROM events WHERE group_id = ? ORDER BY start_date, id').all(group.id);
  res.json(rows.map((r) => loadEvent(r.id)));
});

// Créer un événement dans le groupe : tous les membres sont invités en 1 clic.
// Mêmes champs que l'étape 1 de POST /events (+ invite_all_members, true par défaut).
router.post('/:id/events', (req, res) => {
  const group = loadGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable' });
  const { created_by } = req.body;
  if (!created_by) return res.status(400).json({ error: 'created_by est obligatoire' });

  const role = groupRole(group.id, created_by);
  if (!role) return res.status(403).json({ error: 'Seuls les membres du groupe peuvent y créer un événement' });
  if (role !== 'admin' && !group.allow_member_events) {
    return res.status(403).json({ error: 'Les membres ne sont pas autorisés à créer des événements dans ce groupe' });
  }

  // Par défaut, l'événement d'un groupe privé / secret est privé
  const body = { ...req.body, visibility: req.body.visibility ?? (group.type === 'public' ? 'public' : 'private') };
  const err = checkEventBody(body);
  if (err) return res.status(err.status).json({ error: err.error });
  if (Date.parse(body.end_date) <= Date.parse(body.start_date)) {
    return res.status(400).json({ error: 'end_date doit être après start_date' });
  }

  const allMembers = [...group.admins, ...group.members].map((m) => m.id);
  const organizers = body.organizers ?? [];
  if (!Array.isArray(organizers) || organizers.some((o) => !allMembers.includes(o))) {
    return res.status(422).json({ error: 'organizers doit contenir des membres du groupe' });
  }
  const orgIds = new Set([created_by, ...organizers]);
  const invited = body.invite_all_members === false ? (body.members ?? []) : allMembers;
  if (!Array.isArray(invited) || invited.some((m) => !allMembers.includes(m))) {
    return res.status(422).json({ error: 'members doit contenir des membres du groupe' });
  }
  const memIds = new Set(invited.filter((u) => !orgIds.has(u)));

  const id = insertEvent(body, orgIds, memIds, group.id);
  res.status(201).json(loadEvent(id));
});

module.exports = { router, loadGroup };
