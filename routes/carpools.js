const router = require('express').Router();
const db = require('../db');
const { eventRole, toIso } = require('../lib/helpers');
const { visibleEvent } = require('../lib/eventAccess');

const FIELDS = ['departure_place', 'departure_time', 'price', 'seats', 'max_detour_minutes'];
const getEvent = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id ?? null);

// Covoiturage avec conducteur, passagers et places restantes
function loadCarpool(id) {
  const c = db
    .prepare(
      `SELECT c.*, u.first_name AS driver_first_name, u.last_name AS driver_last_name
       FROM carpools c JOIN users u ON u.id = c.driver_id WHERE c.id = ?`
    )
    .get(id);
  if (!c) return null;
  c.passengers = db
    .prepare('SELECT u.id, u.first_name, u.last_name, u.email FROM carpool_passengers p JOIN users u ON u.id = p.user_id WHERE p.carpool_id = ? ORDER BY u.id')
    .all(id);
  c.available_seats = c.seats - c.passengers.length;
  return c;
}

// Vérifie les champs. Renvoie un message d'erreur ou null
function checkCarpool(body, event) {
  const { departure_time, price, seats, max_detour_minutes } = body;
  if (departure_time !== undefined) {
    const iso = toIso(departure_time);
    if (!iso) return 'departure_time invalide (format attendu : 2027-02-01T16:30:00Z)';
    if (iso > toIso(event.end_date)) return 'Le départ doit avoir lieu avant la fin de l\'événement';
  }
  if (body.departure_place !== undefined && !body.departure_place) return 'departure_place ne peut pas être vide';
  if (price !== undefined && (typeof price !== 'number' || price < 0)) return 'price doit être un nombre positif ou nul';
  if (seats !== undefined && (!Number.isInteger(seats) || seats <= 0)) return 'seats doit être un entier supérieur à 0';
  if (max_detour_minutes !== undefined && (!Number.isInteger(max_detour_minutes) || max_detour_minutes < 0)) {
    return 'max_detour_minutes doit être un entier positif (en minutes)';
  }
  return null;
}

// Proposer un covoiturage (driver_id doit participer, covoiturage activé)
router.post('/', (req, res) => {
  const { event_id, driver_id } = req.body;
  const missing = ['event_id', 'driver_id', ...FIELDS].filter((f) => req.body[f] === undefined || req.body[f] === '');
  if (missing.length) return res.status(400).json({ error: `Champs obligatoires manquants : ${missing.join(', ')}` });
  const event = getEvent(event_id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable' });
  if (!event.carpool_enabled) return res.status(422).json({ error: 'Le covoiturage n\'est pas activé pour cet événement (étape 2)' });
  if (!eventRole(event.id, driver_id)) return res.status(403).json({ error: 'driver_id doit participer à l\'événement' });
  const err = checkCarpool(req.body, event);
  if (err) return res.status(400).json({ error: err });
  try {
    const { departure_place, departure_time, price, seats, max_detour_minutes } = req.body;
    const r = db
      .prepare(
        `INSERT INTO carpools (event_id, driver_id, departure_place, departure_time, price, seats, max_detour_minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(event.id, driver_id, departure_place, toIso(departure_time), price, seats, max_detour_minutes);
    res.status(201).json(loadCarpool(r.lastInsertRowid));
  } catch (e) {
    if (/UNIQUE constraint failed/.test(e.message)) return res.status(409).json({ error: 'Ce conducteur propose déjà un covoiturage pour cet événement' });
    throw e;
  }
});

// Lister : GET /carpools?event_id=2(&available=true)(&user_id=)
router.get('/', (req, res) => {
  const { event_id, available, user_id } = req.query;
  if (!event_id) return res.status(400).json({ error: 'event_id est obligatoire' });
  if (!visibleEvent(event_id, user_id)) return res.status(404).json({ error: 'Événement introuvable' });
  let list = db.prepare('SELECT id FROM carpools WHERE event_id = ? ORDER BY departure_time, id').all(event_id).map((r) => loadCarpool(r.id));
  if (available === 'true') list = list.filter((c) => c.available_seats > 0);
  res.json(list);
});

router.get('/:id', (req, res) => {
  const c = loadCarpool(req.params.id);
  if (!c) return res.status(404).json({ error: 'Covoiturage introuvable' });
  res.json(c);
});

router.patch('/:id', (req, res) => {
  const c = loadCarpool(req.params.id);
  if (!c) return res.status(404).json({ error: 'Covoiturage introuvable' });
  const keys = FIELDS.filter((f) => req.body[f] !== undefined);
  if (keys.length === 0) return res.status(400).json({ error: 'Aucun champ à modifier : ' + FIELDS.join(', ') });
  const err = checkCarpool(req.body, getEvent(c.event_id));
  if (err) return res.status(400).json({ error: err });
  if (req.body.seats !== undefined && req.body.seats < c.passengers.length) {
    return res.status(409).json({ error: `Impossible : ${c.passengers.length} passager(s) déjà inscrit(s)` });
  }
  const values = keys.map((k) => (k === 'departure_time' ? toIso(req.body[k]) : req.body[k]));
  db.prepare(`UPDATE carpools SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...values, c.id);
  res.json(loadCarpool(c.id));
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM carpools WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Covoiturage introuvable' });
  res.status(204).end();
});

// ---------------- Passagers ----------------

// Réserver une place
router.post('/:id/passengers', (req, res) => {
  const c = loadCarpool(req.params.id);
  if (!c) return res.status(404).json({ error: 'Covoiturage introuvable' });
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id est obligatoire' });
  if (!eventRole(c.event_id, user_id)) return res.status(403).json({ error: 'user_id doit participer à l\'événement' });
  if (Number(user_id) === c.driver_id) return res.status(422).json({ error: 'Le conducteur ne peut pas être passager' });
  if (c.passengers.some((p) => p.id === Number(user_id))) return res.status(409).json({ error: 'Déjà passager de ce covoiturage' });
  if (c.available_seats <= 0) return res.status(409).json({ error: 'Plus de place disponible' });
  db.prepare('INSERT INTO carpool_passengers (carpool_id, user_id) VALUES (?, ?)').run(c.id, user_id);
  res.status(201).json(loadCarpool(c.id));
});

// Annuler une réservation
router.delete('/:id/passengers/:userId', (req, res) => {
  const r = db.prepare('DELETE FROM carpool_passengers WHERE carpool_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
  if (r.changes === 0) return res.status(404).json({ error: 'Passager introuvable' });
  res.status(204).end();
});

module.exports = router;
