import Database from 'better-sqlite3';

const db = new Database('music-tracker.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price INTEGER NOT NULL
  )
`);

const count = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (count === 0) {
  const insert = db.prepare('INSERT INTO products (name, price) VALUES (@name, @price)');
  const seed = db.transaction((products) => {
    for (const product of products) insert.run(product);
  });
  seed([
    { name: 'Lamp', price: 25 },
    { name: 'Chair', price: 80 },
    { name: 'Desk', price: 150 },
  ]);
}

export default db;
