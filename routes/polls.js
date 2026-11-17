const router = require('express').Router();
const db = require('../db');
const { eventRole, transaction } = require('../lib/helpers');
const { visibleEvent } = require('../lib/eventAccess');

function loadPoll(id) {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(id);
  if (!poll) return null;
  const options = db.prepare('SELECT id, label FROM poll_options WHERE question_id = ? ORDER BY id');
  poll.questions = db
    .prepare('SELECT id, label, position FROM poll_questions WHERE poll_id = ? ORDER BY position, id')
    .all(id)
    .map((q) => ({ ...q, options: options.all(q.id) }));
  poll.responses_count = db
    .prepare('SELECT COUNT(DISTINCT a.user_id) AS n FROM poll_answers a JOIN poll_questions q ON q.id = a.question_id WHERE q.poll_id = ?')
    .get(id).n;
  return poll;
}

function checkQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return { status: 400, error: 'questions doit contenir au moins 1 question' };
  }
  for (const q of questions) {
    if (!q || !q.label) return { status: 400, error: 'Chaque question doit avoir un label' };
    if (!Array.isArray(q.options) || q.options.length < 2) {
      return { status: 400, error: `La question "${q.label}" doit proposer au moins 2 réponses (options)` };
    }
    if (q.options.some((o) => !(typeof o === 'string' ? o : o?.label))) {
      return { status: 400, error: `Réponse vide dans la question "${q.label}"` };
    }
  }
  return null;
}

function insertQuestions(pollId, questions) {
  const addQ = db.prepare('INSERT INTO poll_questions (poll_id, label, position) VALUES (?, ?, ?)');
  const addO = db.prepare('INSERT INTO poll_options (question_id, label) VALUES (?, ?)');
  questions.forEach((q, i) => {
    const qid = addQ.run(pollId, q.label, i + 1).lastInsertRowid;
    q.options.forEach((o) => addO.run(qid, typeof o === 'string' ? o : o.label));
  });
}

router.post('/', (req, res) => {
  const { event_id, created_by, title, questions } = req.body;
  if (!event_id || !created_by || !title) return res.status(400).json({ error: 'event_id, created_by et title sont obligatoires' });
  const err = checkQuestions(questions);
  if (err) return res.status(err.status).json({ error: err.error });
  if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(event_id)) return res.status(404).json({ error: 'Événement introuvable' });
  if (eventRole(event_id, created_by) !== 'organizer') return res.status(403).json({ error: 'Seul un organisateur peut créer un sondage' });

  const id = transaction(() => {
    const r = db.prepare('INSERT INTO polls (event_id, created_by, title) VALUES (?, ?, ?)').run(event_id, created_by, title);
    insertQuestions(r.lastInsertRowid, questions);
    return r.lastInsertRowid;
  });
  res.status(201).json(loadPoll(id));
});

router.get('/', (req, res) => {
  const { event_id, user_id } = req.query;
  if (!event_id) return res.status(400).json({ error: 'event_id est obligatoire' });
  if (!visibleEvent(event_id, user_id)) return res.status(404).json({ error: 'Événement introuvable' });
  res.json(db.prepare('SELECT id FROM polls WHERE event_id = ? ORDER BY id').all(event_id).map((r) => loadPoll(r.id)));
});

router.get('/:id', (req, res) => {
  const poll = loadPoll(req.params.id);
  if (!poll || !visibleEvent(poll.event_id, req.query.user_id)) return res.status(404).json({ error: 'Sondage introuvable' });
  res.json(poll);
});

router.patch('/:id', (req, res) => {
  const poll = loadPoll(req.params.id);
  if (!poll) return res.status(404).json({ error: 'Sondage introuvable' });
  const { title, questions } = req.body;
  if (title === undefined && questions === undefined) return res.status(400).json({ error: 'Aucun champ à modifier : title, questions' });
  if (title !== undefined && !title) return res.status(400).json({ error: 'title ne peut pas être vide' });
  if (questions !== undefined) {
    const err = checkQuestions(questions);
    if (err) return res.status(err.status).json({ error: err.error });
    if (poll.responses_count > 0) return res.status(409).json({ error: 'Impossible de modifier les questions : des participants ont déjà répondu' });
  }
  transaction(() => {
    if (title !== undefined) db.prepare('UPDATE polls SET title = ? WHERE id = ?').run(title, poll.id);
    if (questions !== undefined) {
      db.prepare('DELETE FROM poll_questions WHERE poll_id = ?').run(poll.id);
      insertQuestions(poll.id, questions);
    }
  });
  res.json(loadPoll(poll.id));
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM polls WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Sondage introuvable' });
  res.status(204).end();
});


function checkAnswers(poll, answers) {
  if (!Array.isArray(answers) || answers.length === 0) {
    return { status: 400, error: 'answers doit être un tableau [{ question_id, option_id }]' };
  }
  const seen = new Set();
  for (const a of answers) {
    const q = poll.questions.find((x) => x.id === a?.question_id);
    if (!q) return { status: 422, error: `La question ${a?.question_id} n'appartient pas à ce sondage` };
    if (seen.has(q.id)) return { status: 422, error: `Une seule réponse possible pour la question "${q.label}"` };
    if (!q.options.some((o) => o.id === a.option_id)) {
      return { status: 422, error: `La réponse ${a.option_id} n'est pas proposée pour la question "${q.label}"` };
    }
    seen.add(q.id);
  }
  const missing = poll.questions.filter((q) => !seen.has(q.id));
  if (missing.length) return { status: 422, error: `Questions sans réponse : ${missing.map((q) => q.label).join(', ')}` };
  return null;
}

const hasAnswered = (pollId, userId) =>
  !!db.prepare('SELECT 1 FROM poll_answers a JOIN poll_questions q ON q.id = a.question_id WHERE q.poll_id = ? AND a.user_id = ?').get(pollId, userId);

function userAnswers(pollId, userId) {
  return db
    .prepare(
      `SELECT a.user_id, a.question_id, q.label AS question, a.option_id, o.label AS answer, a.answered_at
       FROM poll_answers a JOIN poll_questions q ON q.id = a.question_id JOIN poll_options o ON o.id = a.option_id
       WHERE q.poll_id = ? AND a.user_id = ? ORDER BY q.position`
    )
    .all(pollId, userId);
}

function saveAnswers(req, res, replace) {
  const poll = loadPoll(req.params.id);
  if (!poll) return res.status(404).json({ error: 'Sondage introuvable' });
  const { user_id, answers } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id est obligatoire' });
  if (!eventRole(poll.event_id, user_id)) return res.status(403).json({ error: 'Seuls les participants de l\'événement peuvent répondre' });
  const err = checkAnswers(poll, answers);
  if (err) return res.status(err.status).json({ error: err.error });

  const answered = hasAnswered(poll.id, user_id);
  if (!replace && answered) return res.status(409).json({ error: 'Vous avez déjà répondu à ce sondage (utilisez PUT pour modifier)' });
  if (replace && !answered) return res.status(404).json({ error: 'Aucune réponse à modifier pour cet utilisateur' });

  transaction(() => {
    db.prepare('DELETE FROM poll_answers WHERE user_id = ? AND question_id IN (SELECT id FROM poll_questions WHERE poll_id = ?)').run(user_id, poll.id);
    const add = db.prepare('INSERT INTO poll_answers (question_id, option_id, user_id) VALUES (?, ?, ?)');
    answers.forEach((a) => add.run(a.question_id, a.option_id, user_id));
  });
  res.status(replace ? 200 : 201).json(userAnswers(poll.id, user_id));
}

// Répondre au sondage
router.post('/:id/answers', (req, res) => saveAnswers(req, res, false));
// Modifier ses réponses
router.put('/:id/answers', (req, res) => saveAnswers(req, res, true));

// Lister les réponses : GET /polls/:id/answers(?user_id=)
router.get('/:id/answers', (req, res) => {
  const poll = loadPoll(req.params.id);
  if (!poll) return res.status(404).json({ error: 'Sondage introuvable' });
  if (req.query.user_id) return res.json(userAnswers(poll.id, req.query.user_id));
  res.json(
    db
      .prepare(
        `SELECT a.user_id, u.first_name, u.last_name, a.question_id, a.option_id, o.label AS answer, a.answered_at
         FROM poll_answers a JOIN poll_questions q ON q.id = a.question_id
         JOIN poll_options o ON o.id = a.option_id JOIN users u ON u.id = a.user_id
         WHERE q.poll_id = ? ORDER BY a.user_id, q.position`
      )
      .all(poll.id)
  );
});

// Supprimer ses réponses
router.delete('/:id/answers/:userId', (req, res) => {
  const r = db
    .prepare('DELETE FROM poll_answers WHERE user_id = ? AND question_id IN (SELECT id FROM poll_questions WHERE poll_id = ?)')
    .run(req.params.userId, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Aucune réponse trouvée' });
  res.status(204).end();
});

// Résultats : nombre de votes et pourcentage par réponse
router.get('/:id/results', (req, res) => {
  const poll = loadPoll(req.params.id);
  if (!poll || !visibleEvent(poll.event_id, req.query.user_id)) return res.status(404).json({ error: 'Sondage introuvable' });
  const votes = db.prepare('SELECT COUNT(*) AS n FROM poll_answers WHERE option_id = ?');
  const total = poll.responses_count;
  res.json({
    poll_id: poll.id,
    title: poll.title,
    responses_count: total,
    questions: poll.questions.map((q) => ({
      id: q.id,
      label: q.label,
      options: q.options.map((o) => {
        const n = votes.get(o.id).n;
        return { id: o.id, label: o.label, votes: n, percent: total ? Math.round((n / total) * 100) : 0 };
      }),
    })),
  });
});

module.exports = router;
