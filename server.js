const express = require('express');
const app = express();
const db = require('./db');

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/v1/users', require('./routes/users'));
app.use('/api/v1/events', require('./routes/events').router);

app.listen(3000, () => console.log('API sur http://localhost:3000'));