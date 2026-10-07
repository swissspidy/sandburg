import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/api/health', (req, res) => {
  res.json({ sqlite: db.prepare('select sqlite_version() as version').get().version });
});

app.get('/api/entries', (req, res) => {
  const entries = db
    .prepare('SELECT id, name, message, created_at AS createdAt FROM entries ORDER BY id DESC')
    .all();
  res.json(entries);
});

app.post('/api/entries', (req, res) => {
  const body = req.body ?? {};
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 1000) : '';
  if (!message) {
    return res.status(400).json({ error: 'Please write a message before signing.' });
  }
  const createdAt = new Date().toISOString();
  const finalName = name || 'Anonymous';
  const { lastInsertRowid } = db
    .prepare('INSERT INTO entries (name, message, created_at) VALUES (?, ?, ?)')
    .run(finalName, message, createdAt);
  res.status(201).json({ id: Number(lastInsertRowid), name: finalName, message, createdAt });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
