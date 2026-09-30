import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());

const listNotes = db.prepare('SELECT id, text, pinned FROM notes ORDER BY pinned DESC, id ASC');
const addNote = db.prepare('INSERT INTO notes (text) VALUES (?)');
const getNote = db.prepare('SELECT id, text, pinned FROM notes WHERE id = ?');
const togglePin = db.prepare('UPDATE notes SET pinned = 1 - pinned WHERE id = ?');
const deleteNote = db.prepare('DELETE FROM notes WHERE id = ?');

const toJson = (row) => ({ id: row.id, text: row.text, pinned: row.pinned === 1 });

app.get('/api/notes', (req, res) => {
  res.json(listNotes.all().map(toJson));
});

app.post('/api/notes', (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const { lastInsertRowid } = addNote.run(text);
  res.status(201).json(toJson(getNote.get(lastInsertRowid)));
});

app.patch('/api/notes/:id/pin', (req, res) => {
  const { changes } = togglePin.run(req.params.id);
  if (!changes) return res.status(404).json({ error: 'not found' });
  res.json(toJson(getNote.get(req.params.id)));
});

app.delete('/api/notes/:id', (req, res) => {
  deleteNote.run(req.params.id);
  res.status(204).end();
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
