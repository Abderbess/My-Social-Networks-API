const express = require('express');
const db = require('../db');
const { eventRole, transaction } = require('../lib/helpers');

const ticketTypes = express.Router();
const tickets = express.Router();

function loadTicketType(id) {
  const t = db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM tickets k WHERE k.ticket_type_id = t.id) AS sold
       FROM ticket_types t WHERE t.id = ?`
    )
    .get(id);
  if (t) t.remaining = t.quantity - t.sold;
  return t;
}

const TICKET_SQL = `SELECT k.*, t.name AS ticket_type_name, t.amount
  FROM tickets k JOIN ticket_types t ON t.id = k.ticket_type_id`;
const loadTicket = (id) => db.prepare(`${TICKET_SQL} WHERE k.id = ?`).get(id);

function ticketingError(event) {
  if (!event) return { status: 404, error: 'Événement introuvable' };
  if (event.visibility !== 'public') return { status: 422, error: 'La billetterie est réservée aux événements publics' };
  if (!event.ticketing_enabled) return { status: 422, error: 'La billetterie n\'est pas activée pour cet événement (étape 2)' };
  return null;
}
const getEvent = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id ?? null);

const validAmount = (v) => typeof v === 'number' && v >= 0;
const validQuantity = (v) => Number.isInteger(v) && v > 0;


ticketTypes.post('/', (req, res) => {
  const { event_id, created_by, name, amount, quantity } = req.body;
  if (!event_id || !created_by || !name || amount === undefined || quantity === undefined) {
    return res.status(400).json({ error: 'event_id, created_by, name, amount et quantity sont obligatoires' });
  }
  if (!validAmount(amount)) return res.status(400).json({ error: 'amount doit être un nombre positif ou nul' });
  if (!validQuantity(quantity)) return res.status(400).json({ error: 'quantity doit être un entier supérieur à 0' });
  const err = ticketingError(getEvent(event_id));
  if (err) return res.status(err.status).json({ error: err.error });
  if (eventRole(event_id, created_by) !== 'organizer') return res.status(403).json({ error: 'Seul un organisateur peut créer des types de billets' });
  try {
    const r = db.prepare('INSERT INTO ticket_types (event_id, name, amount, quantity) VALUES (?, ?, ?, ?)').run(event_id, name, amount, quantity);
    res.status(201).json(loadTicketType(r.lastInsertRowid));
  } catch (e) {
    if (/UNIQUE constraint failed/.test(e.message)) return res.status(409).json({ error: 'Ce type de billet existe déjà pour cet événement' });
    throw e;
  }
});

ticketTypes.get('/', (req, res) => {
  const { event_id } = req.query;
  if (!event_id) return res.status(400).json({ error: 'event_id est obligatoire' });
  const err = ticketingError(getEvent(event_id));
  if (err) return res.status(err.status).json({ error: err.error });
  res.json(db.prepare('SELECT id FROM ticket_types WHERE event_id = ? ORDER BY amount, id').all(event_id).map((r) => loadTicketType(r.id)));
});

ticketTypes.get('/:id', (req, res) => {
  const t = loadTicketType(req.params.id);
  if (!t) return res.status(404).json({ error: 'Type de billet introuvable' });
  res.json(t);
});

ticketTypes.patch('/:id', (req, res) => {
  const t = loadTicketType(req.params.id);
  if (!t) return res.status(404).json({ error: 'Type de billet introuvable' });
  const { name, amount, quantity } = req.body;
  if (name === undefined && amount === undefined && quantity === undefined) {
    return res.status(400).json({ error: 'Aucun champ à modifier : name, amount, quantity' });
  }
  if (name !== undefined && !name) return res.status(400).json({ error: 'name ne peut pas être vide' });
  if (amount !== undefined && !validAmount(amount)) return res.status(400).json({ error: 'amount doit être un nombre positif ou nul' });
  if (quantity !== undefined && !validQuantity(quantity)) return res.status(400).json({ error: 'quantity doit être un entier supérieur à 0' });
  if (quantity !== undefined && quantity < t.sold) {
    return res.status(409).json({ error: `Impossible : ${t.sold} billet(s) déjà vendu(s)` });
  }
  if (amount !== undefined && amount !== t.amount && t.sold > 0) {
    return res.status(409).json({ error: 'Impossible de changer le montant : des billets ont déjà été vendus' });
  }
  try {
    db.prepare('UPDATE ticket_types SET name = ?, amount = ?, quantity = ? WHERE id = ?').run(name ?? t.name, amount ?? t.amount, quantity ?? t.quantity, t.id);
  } catch (e) {
    if (/UNIQUE constraint failed/.test(e.message)) return res.status(409).json({ error: 'Ce type de billet existe déjà pour cet événement' });
    throw e;
  }
  res.json(loadTicketType(t.id));
});

ticketTypes.delete('/:id', (req, res) => {
  const t = loadTicketType(req.params.id);
  if (!t) return res.status(404).json({ error: 'Type de billet introuvable' });
  if (t.sold > 0) return res.status(409).json({ error: 'Impossible de supprimer un type de billet déjà vendu' });
  db.prepare('DELETE FROM ticket_types WHERE id = ?').run(t.id);
  res.status(204).end();
});


const BUYER = ['first_name', 'last_name', 'email', 'address', 'zip_code', 'city', 'country'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

tickets.post('/', (req, res) => {
  const { ticket_type_id } = req.body;
  const missing = ['ticket_type_id', ...BUYER].filter((f) => !req.body[f]);
  if (missing.length) return res.status(400).json({ error: `Champs obligatoires manquants : ${missing.join(', ')}` });
  if (!EMAIL_RE.test(req.body.email)) return res.status(400).json({ error: 'email invalide' });

  const type = loadTicketType(ticket_type_id);
  if (!type) return res.status(404).json({ error: 'Type de billet introuvable' });
  const event = getEvent(type.event_id);
  const err = ticketingError(event);
  if (err) return res.status(err.status).json({ error: err.error });
  if (event.status !== 'published') return res.status(422).json({ error: 'L\'événement n\'est pas encore publié' });
  if (Date.parse(event.end_date) < Date.now()) return res.status(422).json({ error: 'L\'événement est terminé' });

  const email = req.body.email.trim().toLowerCase();
  try {
    const id = transaction(() => {
      const sold = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE ticket_type_id = ?').get(type.id).n;
      if (sold >= type.quantity) return null;
      return db
        .prepare(
          `INSERT INTO tickets (ticket_type_id, event_id, first_name, last_name, email, address, zip_code, city, country)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(type.id, event.id, req.body.first_name, req.body.last_name, email, req.body.address, req.body.zip_code, req.body.city, req.body.country)
        .lastInsertRowid;
    });
    if (!id) return res.status(409).json({ error: 'Plus de billets disponibles pour ce type' });
    res.status(201).json(loadTicket(id));
  } catch (e) {
    if (/UNIQUE constraint failed/.test(e.message)) return res.status(409).json({ error: 'Cette personne a déjà un billet pour cet événement' });
    throw e;
  }
});

tickets.get('/', (req, res) => {
  const { event_id, ticket_type_id } = req.query;
  if (!event_id) return res.status(400).json({ error: 'event_id est obligatoire' });
  if (!getEvent(event_id)) return res.status(404).json({ error: 'Événement introuvable' });
  const rows = ticket_type_id
    ? db.prepare(`${TICKET_SQL} WHERE k.event_id = ? AND k.ticket_type_id = ? ORDER BY k.id`).all(event_id, ticket_type_id)
    : db.prepare(`${TICKET_SQL} WHERE k.event_id = ? ORDER BY k.id`).all(event_id);
  res.json(rows);
});

tickets.get('/:id', (req, res) => {
  const t = loadTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Billet introuvable' });
  res.json(t);
});

tickets.patch('/:id', (req, res) => {
  const t = loadTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Billet introuvable' });
  const keys = BUYER.filter((k) => req.body[k] !== undefined);
  if (keys.length === 0) return res.status(400).json({ error: 'Aucun champ à modifier : ' + BUYER.join(', ') });
  if (keys.some((k) => !req.body[k])) return res.status(400).json({ error: 'Les champs ne peuvent pas être vides' });
  if (req.body.email !== undefined && !EMAIL_RE.test(req.body.email)) return res.status(400).json({ error: 'email invalide' });
  const values = keys.map((k) => (k === 'email' ? req.body.email.trim().toLowerCase() : req.body[k]));
  try {
    db.prepare(`UPDATE tickets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...values, t.id);
  } catch (e) {
    if (/UNIQUE constraint failed/.test(e.message)) return res.status(409).json({ error: 'Cette personne a déjà un billet pour cet événement' });
    throw e;
  }
  res.json(loadTicket(t.id));
});

tickets.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM tickets WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Billet introuvable' });
  res.status(204).end();
});

module.exports = { ticketTypes, tickets };
