import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());

const SELECT_COLUMNS = 'id, title, body, pinned, created_at';

function toNote(row) {
  return row && { ...row, pinned: Boolean(row.pinned) };
}

app.get('/api/health', (req, res) => {
  res.json({ sqlite: db.prepare('select sqlite_version() as version').get().version });
});

app.get('/api/notes', (req, res) => {
  const notes = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM notes ORDER BY pinned DESC, id DESC`)
    .all()
    .map(toNote);
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
    .prepare(`SELECT ${SELECT_COLUMNS} FROM notes WHERE id = ?`)
    .get(Number(result.lastInsertRowid));
  res.status(201).json(toNote(note));
});

app.patch('/api/notes/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
  if (typeof req.body?.pinned !== 'boolean') {
    return res.status(400).json({ error: '"pinned" must be true or false.' });
  }
  const result = db
    .prepare('UPDATE notes SET pinned = ? WHERE id = ?')
    .run(req.body.pinned ? 1 : 0, id);
  if (result.changes === 0) return res.status(404).json({ error: 'Note not found.' });
  const note = db.prepare(`SELECT ${SELECT_COLUMNS} FROM notes WHERE id = ?`).get(id);
  res.json(toNote(note));
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
