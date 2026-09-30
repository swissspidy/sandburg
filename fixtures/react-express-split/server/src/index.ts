import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { db, type Bookmark } from './db.js';

const app = express();
app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

app.get('/bookmarks', (_req: Request, res: Response) => {
  res.json(db.prepare('SELECT id, title, url FROM bookmarks ORDER BY id').all() as unknown as Bookmark[]);
});

app.post('/bookmarks', (req: Request, res: Response) => {
  const { title, url } = req.body as Partial<Bookmark>;
  if (!title || !url) return res.status(400).json({ error: 'title and url are required' });
  try {
    const { lastInsertRowid } = db.prepare('INSERT INTO bookmarks (title, url) VALUES (?, ?)').run(title, url);
    res.status(201).json({ id: Number(lastInsertRowid), title, url });
  } catch (err) {
    if ((err as Error).message.includes('UNIQUE')) return res.status(409).json({ error: 'already bookmarked' });
    throw err;
  }
});

const PORT = 4000;
app.listen(PORT, () => console.log(`bookmarks API on :${PORT}`));
