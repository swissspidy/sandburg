import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());

const listProducts = db.prepare('SELECT id, name, price FROM products ORDER BY price ASC');

app.get('/api/products', (req, res) => {
  res.json({ products: listProducts.all() });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
