// Tests de bout en bout : npm test   (base SQLite temporaire, n'affecte pas data.sqlite)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const DB_FILE = path.join(os.tmpdir(), `msn-test-${process.pid}.sqlite`);
process.env.DB_FILE = DB_FILE;
const app = require('../server');

let server;
let base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
after(() => {
  server.close();
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) fs.rmSync(f, { force: true });
});

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const ok = (r, status) => assert.equal(r.status, status, JSON.stringify(r.body));

const ids = {};

test('Utilisateurs : email unique', async () => {
  for (const [k, first] of [['alice', 'Alice'], ['bob', 'Bob'], ['carl', 'Carl'], ['dan', 'Dan']]) {
    const r = await api('POST', '/users', { email: `${k}@test.com`, first_name: first, last_name: 'Test' });
    ok(r, 201);
    ids[k] = r.body.id;
  }
  ok(await api('POST', '/users', { email: 'ALICE@test.com', first_name: 'A', last_name: 'B' }), 409);
});

test('Événements : 3 étapes, membres, modification, partage', async () => {
  let r = await api('POST', '/events', {
    name: 'Soirée', description: 'Fête', start_date: '2030-06-01T18:00:00Z', end_date: '2030-06-02T02:00:00Z',
    location: 'Lyon', visibility: 'public', created_by: ids.alice, organizers: [ids.bob], members: [ids.carl],
  });
  ok(r, 201);
  ids.event = r.body.id;
  assert.equal(r.body.organizers.length, 2);
  assert.equal(r.body.status, 'draft');

  ok(await api('PATCH', `/events/${ids.event}/options`, { shopping_list_enabled: true, carpool_enabled: true, ticketing_enabled: true, share_enabled: true }), 200);
  ok(await api('POST', `/events/${ids.event}/publish`), 200);

  ok(await api('PATCH', `/events/${ids.event}`, { end_date: '2030-05-01T00:00:00Z' }), 400); // fin avant début
  r = await api('PATCH', `/events/${ids.event}`, { location: 'Paris' });
  ok(r, 200);
  assert.equal(r.body.location, 'Paris');
  ok(await api('PATCH', `/events/${ids.event}`, { visibility: 'private' }), 422); // billetterie active

  ok(await api('POST', `/events/${ids.event}/members`, { user_id: ids.dan }), 201); // inscription libre (public publié)
  ok(await api('POST', `/events/${ids.event}/members`, { user_id: ids.dan }), 409);
  ok(await api('POST', `/events/${ids.event}/members`, { user_id: ids.dan, role: 'organizer', added_by: ids.carl }), 403);
  ok(await api('DELETE', `/events/${ids.event}/members/${ids.dan}`), 204);

  r = await api('GET', `/events/${ids.event}/share`);
  ok(r, 200);
  assert.match(r.body.links.facebook, /facebook\.com/);
});

test('Groupes : admin, secret, événement avec tous les membres invités', async () => {
  let r = await api('POST', '/groups', { name: 'Club secret', type: 'secret', created_by: ids.alice, members: [ids.bob, ids.carl], allow_member_posts: false });
  ok(r, 201);
  ids.group = r.body.id;
  ids.groupThread = r.body.thread_id;
  assert.ok(ids.groupThread, 'un fil est créé automatiquement');

  ok(await api('GET', `/groups/${ids.group}`), 404); // secret : invisible sans user_id membre
  ok(await api('GET', `/groups/${ids.group}?user_id=${ids.bob}`), 200);
  r = await api('GET', `/groups?user_id=${ids.dan}`);
  assert.equal(r.body.length, 0);

  ok(await api('POST', `/groups/${ids.group}/members`, { user_id: ids.dan }), 403); // pas de self-join en secret
  ok(await api('POST', `/groups/${ids.group}/members`, { user_id: ids.dan, added_by: ids.alice }), 201);
  ok(await api('DELETE', `/groups/${ids.group}/members/${ids.alice}`), 409); // dernier admin

  ok(await api('POST', `/groups/${ids.group}/events`, { created_by: ids.bob, name: 'X', start_date: '2030-01-01T10:00:00Z', end_date: '2030-01-01T12:00:00Z', location: 'Nice' }), 403);
  r = await api('POST', `/groups/${ids.group}/events`, { created_by: ids.alice, name: 'Réunion', start_date: '2030-01-01T10:00:00Z', end_date: '2030-01-01T12:00:00Z', location: 'Nice' });
  ok(r, 201);
  assert.equal(r.body.visibility, 'private');
  assert.equal(r.body.participants.length, 3); // bob, carl, dan invités
  assert.equal(r.body.group_id, ids.group);
});

test('Fils de discussion : groupe XOR événement, droits de publication, commentaires', async () => {
  ok(await api('POST', '/threads', { group_id: ids.group, event_id: ids.event, created_by: ids.alice }), 400);
  let r = await api('POST', '/threads', { event_id: ids.event, title: 'Organisation', created_by: ids.alice });
  ok(r, 201);
  ids.eventThread = r.body.id;

  ok(await api('POST', `/threads/${ids.groupThread}/messages`, { author_id: ids.bob, content: 'Salut' }), 403); // posts membres interdits
  ok(await api('POST', `/threads/${ids.groupThread}/messages`, { author_id: ids.alice, content: 'Bienvenue' }), 201);

  ok(await api('POST', `/threads/${ids.eventThread}/messages`, { author_id: ids.dan, content: 'x' }), 403); // pas participant
  r = await api('POST', `/threads/${ids.eventThread}/messages`, { author_id: ids.carl, content: 'J\'arrive à 19h' });
  ok(r, 201);
  ids.message = r.body.id;

  ok(await api('POST', `/messages/${ids.message}/comments`, { author_id: ids.bob, content: 'Top' }), 201);
  r = await api('GET', `/messages/${ids.message}`);
  assert.equal(r.body.comments.length, 1);
  ok(await api('PATCH', `/messages/${ids.message}`, { user_id: ids.bob, content: 'hack' }), 403);
  ok(await api('PATCH', `/messages/${ids.message}`, { user_id: ids.carl, content: 'J\'arrive à 20h' }), 200);
});

test('Albums photo : photos et commentaires par les participants', async () => {
  let r = await api('POST', '/albums', { event_id: ids.event, name: 'Souvenirs', created_by: ids.carl });
  ok(r, 201);
  ids.album = r.body.id;
  ok(await api('POST', `/albums/${ids.album}/photos`, { author_id: ids.dan, url: 'https://img/x.jpg' }), 403);
  r = await api('POST', `/albums/${ids.album}/photos`, { author_id: ids.carl, url: 'https://img/1.jpg', caption: 'Gâteau' });
  ok(r, 201);
  ids.photo = r.body.id;
  ok(await api('POST', `/photos/${ids.photo}/comments`, { author_id: ids.bob, content: 'Miam' }), 201);
  r = await api('GET', `/photos/${ids.photo}`);
  assert.equal(r.body.comments.length, 1);
});

test('Sondages : créé par un organisateur, 1 réponse par question, résultats', async () => {
  ok(await api('POST', '/polls', { event_id: ids.event, created_by: ids.carl, title: 'X', questions: [{ label: 'Q', options: ['a', 'b'] }] }), 403);
  let r = await api('POST', '/polls', {
    event_id: ids.event, created_by: ids.alice, title: 'Menu',
    questions: [{ label: 'Plat ?', options: ['Pizza', 'Sushi'] }, { label: 'Dessert ?', options: ['Glace', 'Tarte', 'Rien'] }],
  });
  ok(r, 201);
  const poll = r.body;
  const [q1, q2] = poll.questions;

  ok(await api('POST', `/polls/${poll.id}/answers`, { user_id: ids.carl, answers: [{ question_id: q1.id, option_id: q1.options[0].id }] }), 422); // Q2 manquante
  ok(await api('POST', `/polls/${poll.id}/answers`, { user_id: ids.carl, answers: [{ question_id: q1.id, option_id: q2.options[0].id }, { question_id: q2.id, option_id: q2.options[0].id }] }), 422); // mauvaise option
  ok(await api('POST', `/polls/${poll.id}/answers`, { user_id: ids.carl, answers: [{ question_id: q1.id, option_id: q1.options[0].id }, { question_id: q1.id, option_id: q1.options[1].id }, { question_id: q2.id, option_id: q2.options[0].id }] }), 422); // 2 réponses à Q1
  const good = [{ question_id: q1.id, option_id: q1.options[1].id }, { question_id: q2.id, option_id: q2.options[2].id }];
  ok(await api('POST', `/polls/${poll.id}/answers`, { user_id: ids.dan, answers: good }), 403); // pas participant
  ok(await api('POST', `/polls/${poll.id}/answers`, { user_id: ids.carl, answers: good }), 201);
  ok(await api('POST', `/polls/${poll.id}/answers`, { user_id: ids.carl, answers: good }), 409);
  ok(await api('PUT', `/polls/${poll.id}/answers`, { user_id: ids.carl, answers: [good[0], { question_id: q2.id, option_id: q2.options[0].id }] }), 200);
  ok(await api('POST', `/polls/${poll.id}/answers`, { user_id: ids.bob, answers: good }), 201);

  r = await api('GET', `/polls/${poll.id}/results`);
  ok(r, 200);
  assert.equal(r.body.responses_count, 2);
  assert.equal(r.body.questions[0].options[1].votes, 2);
  assert.equal(r.body.questions[0].options[1].percent, 100);
  ok(await api('PATCH', `/polls/${poll.id}`, { questions: [{ label: 'Q', options: ['a', 'b'] }] }), 409);
});

test('Billetterie : quantité limitée, 1 billet par personne', async () => {
  ok(await api('POST', '/ticket-types', { event_id: ids.event, created_by: ids.carl, name: 'VIP', amount: 50, quantity: 2 }), 403);
  let r = await api('POST', '/ticket-types', { event_id: ids.event, created_by: ids.alice, name: 'VIP', amount: 50, quantity: 2 });
  ok(r, 201);
  const type = r.body;
  const buyer = (email) => ({ ticket_type_id: type.id, first_name: 'Ext', last_name: 'Erieur', email, address: '1 rue de Paris', zip_code: '75001', city: 'Paris', country: 'France' });

  ok(await api('POST', '/tickets', { ticket_type_id: type.id, first_name: 'X' }), 400);
  r = await api('POST', '/tickets', buyer('ext1@mail.com'));
  ok(r, 201);
  assert.ok(r.body.purchased_at);
  ok(await api('POST', '/tickets', buyer('EXT1@mail.com')), 409); // 1 seul billet par personne
  ok(await api('POST', '/tickets', buyer('ext2@mail.com')), 201);
  ok(await api('POST', '/tickets', buyer('ext3@mail.com')), 409); // stock épuisé

  r = await api('GET', `/ticket-types/${type.id}`);
  assert.equal(r.body.sold, 2);
  assert.equal(r.body.remaining, 0);
  ok(await api('PATCH', `/ticket-types/${type.id}`, { quantity: 1 }), 409);
  ok(await api('DELETE', `/ticket-types/${type.id}`), 409);
});

test('Shopping list : élément unique par événement', async () => {
  const item = { event_id: ids.event, user_id: ids.carl, name: 'Chips', quantity: 3, arrival_time: '2030-06-01T19:00:00Z' };
  let r = await api('POST', '/shopping-items', item);
  ok(r, 201);
  ok(await api('POST', '/shopping-items', { ...item, user_id: ids.bob, name: ' chips ' }), 409);
  ok(await api('POST', '/shopping-items', { ...item, name: 'Coca', arrival_time: '2031-01-01T00:00:00Z' }), 400);
  ok(await api('POST', '/shopping-items', { ...item, name: 'Coca', user_id: ids.dan }), 403);
  r = await api('GET', `/shopping-items?event_id=${ids.event}`);
  assert.equal(r.body.length, 1);
});

test('Covoiturage (bonus) : places limitées', async () => {
  let r = await api('POST', '/carpools', { event_id: ids.event, driver_id: ids.bob, departure_place: 'Lyon', departure_time: '2030-06-01T15:30:00Z', price: 10, seats: 1, max_detour_minutes: 30 });
  ok(r, 201);
  const cp = r.body;
  ok(await api('POST', `/carpools/${cp.id}/passengers`, { user_id: ids.bob }), 422);
  r = await api('POST', `/carpools/${cp.id}/passengers`, { user_id: ids.carl });
  ok(r, 201);
  assert.equal(r.body.available_seats, 0);
  ok(await api('POST', `/carpools/${cp.id}/passengers`, { user_id: ids.alice }), 409);
  ok(await api('PATCH', `/carpools/${cp.id}`, { seats: 0 }), 400);
});

test('Suppression en cascade d\'un événement', async () => {
  ok(await api('DELETE', `/events/${ids.event}`), 204);
  ok(await api('GET', `/threads/${ids.eventThread}`), 404);
  ok(await api('GET', `/albums/${ids.album}`), 404);
  ok(await api('GET', '/nimporte-quoi'), 404);
});
