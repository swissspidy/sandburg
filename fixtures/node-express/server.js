const express = require('express');
const path = require('node:path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const notes = [];
app.get('/api/notes', (req, res) => res.json(notes));
app.post('/api/notes', (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const note = { id: notes.length + 1, text };
  notes.push(note);
  res.status(201).json(note);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));
