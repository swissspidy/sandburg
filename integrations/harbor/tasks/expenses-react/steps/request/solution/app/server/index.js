import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ sqlite: db.prepare('select sqlite_version() as version').get().version });
});

const toExpense = (row) => ({
  id: Number(row.id),
  description: row.description,
  amountCents: Number(row.amount_cents),
  createdAt: row.created_at,
});

app.get('/api/expenses', (req, res) => {
  const rows = db
    .prepare('SELECT id, description, amount_cents, created_at FROM expenses ORDER BY id DESC')
    .all();
  res.json(rows.map(toExpense));
});

app.post('/api/expenses', (req, res) => {
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const amount = Number(req.body?.amount);
  if (!description) return res.status(400).json({ error: 'Description is required.' });
  if (description.length > 200) return res.status(400).json({ error: 'Description is too long.' });
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) {
    return res.status(400).json({ error: 'Amount must be a positive number.' });
  }
  const cents = Math.round(amount * 100);
  if (cents <= 0) return res.status(400).json({ error: 'Amount must be at least $0.01.' });
  const { lastInsertRowid } = db
    .prepare('INSERT INTO expenses (description, amount_cents) VALUES (?, ?)')
    .run(description, cents);
  const row = db
    .prepare('SELECT id, description, amount_cents, created_at FROM expenses WHERE id = ?')
    .get(lastInsertRowid);
  res.status(201).json(toExpense(row));
});

app.delete('/api/expenses/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
  const { changes } = db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  if (!changes) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
