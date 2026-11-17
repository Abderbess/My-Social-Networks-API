const express = require('express');
const app = express();
const db = require('./db');

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const { ticketTypes, tickets } = require('./routes/ticketing');

app.use('/api/v1/users', require('./routes/users'));
app.use('/api/v1/events', require('./routes/events').router);
app.use('/api/v1/groups', require('./routes/groups').router);
app.use('/api/v1/threads', require('./routes/threads').router);
app.use('/api/v1/messages', require('./routes/messages'));
app.use('/api/v1/albums', require('./routes/albums').router);
app.use('/api/v1/photos', require('./routes/photos'));
app.use('/api/v1/polls', require('./routes/polls'));
app.use('/api/v1/ticket-types', ticketTypes);
app.use('/api/v1/tickets', tickets);
app.use('/api/v1/shopping-items', require('./routes/shopping'));
app.use('/api/v1/carpools', require('./routes/carpools'));

// Route inconnue
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} introuvable` });
});

// Gestion des erreurs (Express 5 transmet automatiquement les exceptions ici)
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide' });
  if (/FOREIGN KEY constraint failed/.test(err.message)) return res.status(422).json({ error: 'Référence vers une ressource inexistante' });
  if (/CHECK constraint failed/.test(err.message)) return res.status(400).json({ error: 'Valeur invalide' });
  if (/UNIQUE constraint failed/.test(err.message)) return res.status(409).json({ error: 'Ressource déjà existante' });
  console.error(err);
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

if (require.main === module) {
  app.listen(3000, () => console.log('API sur http://localhost:3000'));
}

module.exports = app;
