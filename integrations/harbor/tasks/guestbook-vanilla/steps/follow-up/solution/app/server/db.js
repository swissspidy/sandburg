import { DatabaseSync } from 'node:sqlite';

// The app's database: a file next to the project (exec, prepare(sql).all/get/run).
const db = new DatabaseSync('app.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    likes INTEGER NOT NULL DEFAULT 0
  )
`);

// Databases created before likes existed: add the column (existing rows get 0).
const columns = db.prepare('PRAGMA table_info(entries)').all();
if (!columns.some((c) => c.name === 'likes')) {
  db.exec('ALTER TABLE entries ADD COLUMN likes INTEGER NOT NULL DEFAULT 0');
}

export default db;
