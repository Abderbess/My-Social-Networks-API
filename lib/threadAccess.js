const db = require('../db');
const { eventRole, groupRole } = require('./helpers');

/**
 * Droits d'un utilisateur sur un fil de discussion.
 *  - visible : le fil peut être lu (groupe public / événement public publié, ou membre)
 *  - member  : membre du groupe / participant ou organisateur de l'événement
 *  - manager : administrateur du groupe / organisateur de l'événement
 *  - canPost : peut publier un message
 */
function threadAccess(thread, userId) {
  if (thread.group_id) {
    const group = db.prepare('SELECT type, allow_member_posts FROM groups WHERE id = ?').get(thread.group_id);
    const role = groupRole(thread.group_id, userId);
    return {
      visible: group.type === 'public' || !!role,
      exists: group.type !== 'secret' || !!role, // un groupe secret est invisible
      member: !!role,
      manager: role === 'admin',
      canPost: role === 'admin' || (role === 'member' && !!group.allow_member_posts),
    };
  }
  const event = db.prepare('SELECT visibility, status FROM events WHERE id = ?').get(thread.event_id);
  const role = eventRole(thread.event_id, userId);
  const isPublic = event.visibility === 'public' && event.status === 'published';
  return {
    visible: isPublic || !!role,
    exists: isPublic || !!role,
    member: !!role,
    manager: role === 'organizer',
    canPost: !!role,
  };
}

module.exports = { threadAccess };
