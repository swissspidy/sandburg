import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ sqlite: db.prepare('select sqlite_version() as version').get().version });
});

app.get('/api/entries', (req, res) => {
  const rows = db
    .prepare('SELECT id, name, message, created_at AS createdAt FROM entries ORDER BY id DESC')
    .all();
  res.json(rows);
});

app.post('/api/entries', (req, res) => {
  const body = req.body ?? {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  if (!message) {
    return res.status(400).json({ error: 'Please write a message before signing.' });
  }
  if (message.length > 1000) {
    return res.status(400).json({ error: 'Message is too long (max 1000 characters).' });
  }
  const name = (rawName || 'Anonymous').slice(0, 80);
  const createdAt = Date.now();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO entries (name, message, created_at) VALUES (?, ?, ?)')
    .run(name, message, createdAt);
  res.status(201).json({ id: Number(lastInsertRowid), name, message, createdAt });
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
