const db = require('../db');

// Rôle d'un utilisateur dans un événement : 'organizer', 'participant' ou null
const eventRole = (eventId, userId) =>
  db.prepare('SELECT role FROM event_members WHERE event_id = ? AND user_id = ?').get(eventId, userId ?? null)?.role ?? null;

// Rôle d'un utilisateur dans un groupe : 'admin', 'member' ou null
const groupRole = (groupId, userId) =>
  db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId ?? null)?.role ?? null;

const userExists = (id) => !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id ?? null);

// Entier strictement positif (identifiants, quantités...)
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

// Date ISO valide -> chaîne ISO normalisée, sinon null
const toIso = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

// Convertit les colonnes INTEGER 0/1 en vrais booléens dans la réponse JSON
const withBools = (row, fields) => {
  if (row) for (const f of fields) row[f] = !!row[f];
  return row;
};

// Exécute fn dans une transaction (BEGIN / COMMIT / ROLLBACK)
const transaction = (fn) => {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};

module.exports = { eventRole, groupRole, userExists, isPositiveInt, toIso, withBools, transaction };
