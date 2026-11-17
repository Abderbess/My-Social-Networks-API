const db = require('../db');
const { eventRole } = require('./helpers');

// Un événement privé ou en brouillon n'est visible que de ses membres
function visibleEvent(eventId, userId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId ?? null);
  if (!event) return null;
  const isPublic = event.visibility === 'public' && event.status === 'published';
  if (!isPublic && !eventRole(event.id, userId)) return null;
  return event;
}

module.exports = { visibleEvent };
