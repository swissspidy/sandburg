import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Stored as integers so they sort naturally: 2 = high, 1 = normal, 0 = low.
const PRIORITY_TO_INT = { low: 0, normal: 1, high: 2 };
const INT_TO_PRIORITY = ['low', 'normal', 'high'];

const toTask = (row) => ({
  id: row.id,
  text: row.text,
  done: !!row.done,
  priority: INT_TO_PRIORITY[row.priority] ?? 'normal',
  createdAt: row.created_at,
});

app.get('/api/health', (req, res) => {
  res.json({ sqlite: db.prepare('select sqlite_version() as version').get().version });
});

app.get('/api/tasks', (req, res) => {
  const rows = db.prepare('SELECT * FROM tasks ORDER BY priority DESC, id ASC').all();
  res.json(rows.map(toTask));
});

app.post('/api/tasks', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'Task text is required' });
  if (text.length > 500) return res.status(400).json({ error: 'Task text is too long' });
  const priorityName = req.body?.priority ?? 'normal';
  if (!(priorityName in PRIORITY_TO_INT)) {
    return res.status(400).json({ error: 'Priority must be low, normal or high' });
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO tasks (text, priority) VALUES (?, ?)')
    .run(text, PRIORITY_TO_INT[priorityName]);
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(lastInsertRowid);
  res.status(201).json(toTask(row));
});

app.patch('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  if (typeof req.body?.done !== 'boolean') return res.status(400).json({ error: '"done" must be a boolean' });
  const { changes } = db.prepare('UPDATE tasks SET done = ? WHERE id = ?').run(req.body.done ? 1 : 0, id);
  if (!changes) return res.status(404).json({ error: 'Task not found' });
  res.json(toTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)));
});

app.delete('/api/tasks/:id', (req, res) => {
  const { changes } = db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(req.params.id));
  if (!changes) return res.status(404).json({ error: 'Task not found' });
  res.status(204).end();
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
