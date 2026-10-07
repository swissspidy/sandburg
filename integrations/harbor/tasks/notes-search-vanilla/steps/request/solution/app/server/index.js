import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

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
  const title = String(req.body?.title ?? '').trim();
  const body = String(req.body?.body ?? '').trim();
  if (!title && !body) {
    return res.status(400).json({ error: 'A note needs a title or a body.' });
  }
  if (title.length > 200 || body.length > 10000) {
    return res.status(400).json({ error: 'Note is too long.' });
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO notes (title, body) VALUES (?, ?)')
    .run(title, body);
  const note = db
    .prepare('SELECT id, title, body, created_at FROM notes WHERE id = ?')
    .get(lastInsertRowid);
  res.status(201).json(note);
});

app.delete('/api/notes/:id', (req, res) => {
  const { changes } = db.prepare('DELETE FROM notes WHERE id = ?').run(Number(req.params.id));
  if (!changes) return res.status(404).json({ error: 'Note not found.' });
  res.status(204).end();
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
