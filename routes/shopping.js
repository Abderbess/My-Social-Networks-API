const router = require('express').Router();
const db = require('../db');
const { eventRole, toIso } = require('../lib/helpers');
const { visibleEvent } = require('../lib/eventAccess');

const ITEM_SQL = `SELECT s.*, u.first_name AS user_first_name, u.last_name AS user_last_name
  FROM shopping_items s JOIN users u ON u.id = s.user_id`;
const loadItem = (id) => db.prepare(`${ITEM_SQL} WHERE s.id = ?`).get(id);
const getEvent = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id ?? null);

function arrivalError(event, arrival_time) {
  const iso = toIso(arrival_time);
  if (!iso) return 'arrival_time invalide (format attendu : 2027-02-01T19:00:00Z)';
  if (iso < toIso(event.start_date) || iso > toIso(event.end_date)) return 'arrival_time doit être comprise entre le début et la fin de l\'événement';
  return null;
}

const duplicate = (e, res) => {
  if (/UNIQUE constraint failed/.test(e.message)) {
    res.status(409).json({ error: 'Quelqu\'un apporte déjà cet élément pour cet événement' });
    return true;
  }
  return false;
};

router.post('/', (req, res) => {
  const { event_id, user_id, name, quantity, arrival_time } = req.body;
  if (!event_id || !user_id || !name || quantity === undefined || !arrival_time) {
    return res.status(400).json({ error: 'event_id, user_id, name, quantity et arrival_time sont obligatoires' });
  }
  if (!Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ error: 'quantity doit être un entier supérieur à 0' });
  const event = getEvent(event_id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable' });
  if (!event.shopping_list_enabled) return res.status(422).json({ error: 'La shopping list n\'est pas activée pour cet événement (étape 2)' });
  if (!eventRole(event.id, user_id)) return res.status(403).json({ error: 'user_id doit participer à l\'événement' });
  const err = arrivalError(event, arrival_time);
  if (err) return res.status(400).json({ error: err });
  try {
    const r = db
      .prepare('INSERT INTO shopping_items (event_id, user_id, name, quantity, arrival_time) VALUES (?, ?, ?, ?, ?)')
      .run(event.id, user_id, name.trim(), quantity, toIso(arrival_time));
    res.status(201).json(loadItem(r.lastInsertRowid));
  } catch (e) {
    if (duplicate(e, res)) return;
    throw e;
  }
});

router.get('/', (req, res) => {
  const { event_id, user_id } = req.query;
  if (!event_id) return res.status(400).json({ error: 'event_id est obligatoire' });
  if (!visibleEvent(event_id, user_id)) return res.status(404).json({ error: 'Événement introuvable' });
  res.json(db.prepare(`${ITEM_SQL} WHERE s.event_id = ? ORDER BY s.arrival_time, s.id`).all(event_id));
});

router.get('/:id', (req, res) => {
  const item = loadItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Élément introuvable' });
  res.json(item);
});

router.patch('/:id', (req, res) => {
  const item = loadItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Élément introuvable' });
  const { name, quantity, arrival_time } = req.body;
  if (name === undefined && quantity === undefined && arrival_time === undefined) {
    return res.status(400).json({ error: 'Aucun champ à modifier : name, quantity, arrival_time' });
  }
  if (name !== undefined && !name) return res.status(400).json({ error: 'name ne peut pas être vide' });
  if (quantity !== undefined && (!Number.isInteger(quantity) || quantity <= 0)) return res.status(400).json({ error: 'quantity doit être un entier supérieur à 0' });
  if (arrival_time !== undefined) {
    const err = arrivalError(getEvent(item.event_id), arrival_time);
    if (err) return res.status(400).json({ error: err });
  }
  try {
    db.prepare('UPDATE shopping_items SET name = ?, quantity = ?, arrival_time = ? WHERE id = ?').run(
      name !== undefined ? name.trim() : item.name, quantity ?? item.quantity, arrival_time ? toIso(arrival_time) : item.arrival_time, item.id
    );
  } catch (e) {
    if (duplicate(e, res)) return;
    throw e;
  }
  res.json(loadItem(item.id));
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM shopping_items WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Élément introuvable' });
  res.status(204).end();
});

module.exports = router;
