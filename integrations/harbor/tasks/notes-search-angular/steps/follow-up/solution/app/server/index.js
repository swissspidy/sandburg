import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());

const SELECT_NOTE = 'SELECT id, title, body, pinned, created_at AS createdAt FROM notes';

function toNote(row) {
  return { ...row, pinned: Boolean(row.pinned) };
}

app.get('/api/health', (req, res) => {
  res.json({ sqlite: db.prepare('select sqlite_version() as version').get().version });
});

app.get('/api/notes', (req, res) => {
  const notes = db.prepare(`${SELECT_NOTE} ORDER BY pinned DESC, id DESC`).all();
  res.json(notes.map(toNote));
});

app.post('/api/notes', (req, res) => {
  const title = String(req.body?.title ?? '').trim();
  const body = String(req.body?.body ?? '').trim();
  if (!title) {
    return res.status(400).json({ error: 'Title is required.' });
  }
  if (title.length > 200 || body.length > 10000) {
    return res.status(400).json({ error: 'Note is too long.' });
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO notes (title, body) VALUES (?, ?)')
    .run(title, body);
  const note = db.prepare(`${SELECT_NOTE} WHERE id = ?`).get(lastInsertRowid);
  res.status(201).json(toNote(note));
});

app.patch('/api/notes/:id', (req, res) => {
  const id = Number(req.params.id);
  if (typeof req.body?.pinned !== 'boolean') {
    return res.status(400).json({ error: 'pinned must be true or false.' });
  }
  const { changes } = db
    .prepare('UPDATE notes SET pinned = ? WHERE id = ?')
    .run(req.body.pinned ? 1 : 0, id);
  if (!changes) return res.status(404).json({ error: 'Note not found.' });
  res.json(toNote(db.prepare(`${SELECT_NOTE} WHERE id = ?`).get(id)));
});

app.delete('/api/notes/:id', (req, res) => {
  const { changes } = db.prepare('DELETE FROM notes WHERE id = ?').run(Number(req.params.id));
  if (!changes) return res.status(404).json({ error: 'Note not found.' });
  res.status(204).end();
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
