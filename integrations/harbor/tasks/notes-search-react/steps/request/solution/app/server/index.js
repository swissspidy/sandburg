import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ sqlite: db.prepare('select sqlite_version() as version').get().version });
});

app.get('/api/notes', (req, res) => {
  const notes = db
    .prepare('SELECT id, title, body, created_at FROM notes ORDER BY id DESC')
    .all();
  res.json(notes);
});

app.post('/api/notes', (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!title && !body) {
    return res.status(400).json({ error: 'A note needs a title or a body.' });
  }
  const result = db
    .prepare('INSERT INTO notes (title, body) VALUES (?, ?)')
    .run(title, body);
  const note = db
    .prepare('SELECT id, title, body, created_at FROM notes WHERE id = ?')
    .get(Number(result.lastInsertRowid));
  res.status(201).json(note);
});

app.delete('/api/notes/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
  const result = db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Note not found.' });
  res.status(204).end();
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
