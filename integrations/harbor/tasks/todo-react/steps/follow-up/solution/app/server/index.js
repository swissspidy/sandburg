import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());

const PRIORITIES = ['low', 'normal', 'high'];

const toTask = (row) => ({
  id: Number(row.id),
  text: row.text,
  done: Boolean(row.done),
  priority: PRIORITIES.includes(row.priority) ? row.priority : 'normal',
});

const selectColumns = 'SELECT id, text, done, priority FROM tasks';

app.get('/api/health', (req, res) => {
  res.json({ sqlite: db.prepare('select sqlite_version() as version').get().version });
});

app.get('/api/tasks', (req, res) => {
  const rows = db
    .prepare(
      `${selectColumns}
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END,
                id ASC`,
    )
    .all();
  res.json(rows.map(toTask));
});

app.post('/api/tasks', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'Task text is required' });
  if (text.length > 500) return res.status(400).json({ error: 'Task text is too long' });
  const priority = req.body?.priority ?? 'normal';
  if (!PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: 'Priority must be low, normal or high' });
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO tasks (text, priority) VALUES (?, ?)')
    .run(text, priority);
  const row = db.prepare(`${selectColumns} WHERE id = ?`).get(lastInsertRowid);
  res.status(201).json(toTask(row));
});

app.patch('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  if (typeof req.body?.done !== 'boolean') {
    return res.status(400).json({ error: '"done" must be a boolean' });
  }
  const { changes } = db.prepare('UPDATE tasks SET done = ? WHERE id = ?').run(req.body.done ? 1 : 0, id);
  if (!changes) return res.status(404).json({ error: 'Task not found' });
  res.json(toTask(db.prepare(`${selectColumns} WHERE id = ?`).get(id)));
});

app.delete('/api/tasks/:id', (req, res) => {
  const { changes } = db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(req.params.id));
  if (!changes) return res.status(404).json({ error: 'Task not found' });
  res.status(204).end();
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
