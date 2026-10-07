import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());

const SELECT_ENTRY = 'SELECT id, name, message, likes, created_at AS createdAt FROM entries';

app.get('/api/health', (req, res) => {
  res.json({ sqlite: db.prepare('select sqlite_version() as version').get().version });
});

app.get('/api/entries', (req, res) => {
  res.json(db.prepare(`${SELECT_ENTRY} ORDER BY id DESC`).all());
});

app.post('/api/entries', (req, res) => {
  const body = req.body ?? {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  let name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!message) {
    return res.status(400).json({ error: 'Please write a message before signing.' });
  }
  if (message.length > 1000) {
    return res.status(400).json({ error: 'Message must be 1000 characters or fewer.' });
  }
  if (!name) name = 'Anonymous';
  name = name.slice(0, 80);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO entries (name, message) VALUES (?, ?)')
    .run(name, message);
  res.status(201).json(db.prepare(`${SELECT_ENTRY} WHERE id = ?`).get(lastInsertRowid));
});

app.post('/api/entries/:id/like', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid entry id.' });
  const { changes } = db.prepare('UPDATE entries SET likes = likes + 1 WHERE id = ?').run(id);
  if (!changes) return res.status(404).json({ error: 'Entry not found.' });
  res.json(db.prepare(`${SELECT_ENTRY} WHERE id = ?`).get(id));
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
