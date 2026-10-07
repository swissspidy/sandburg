import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/api/health', (req, res) => {
  res.json({ sqlite: db.prepare('select sqlite_version() as version').get().version });
});

const selectEntry =
  'SELECT id, name, message, created_at AS createdAt, likes FROM entries';

app.get('/api/entries', (req, res) => {
  res.json(db.prepare(`${selectEntry} ORDER BY id DESC`).all());
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
  res.status(201).json({ id: Number(lastInsertRowid), name: finalName, message, createdAt, likes: 0 });
});

app.post('/api/entries/:id/like', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid entry.' });
  const { changes } = db.prepare('UPDATE entries SET likes = likes + 1 WHERE id = ?').run(id);
  if (!changes) return res.status(404).json({ error: 'Entry not found.' });
  res.json(db.prepare(`${selectEntry} WHERE id = ?`).get(id));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
