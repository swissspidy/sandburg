import { DatabaseSync } from 'node:sqlite';

// The app's database: a file next to the project (exec, prepare(sql).all/get/run).
const db = new DatabaseSync('app.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export function listNotes() {
  return db
    .prepare('SELECT id, title, body, created_at FROM notes ORDER BY id DESC')
    .all()
    .map((n) => ({ id: Number(n.id), title: n.title, body: n.body, createdAt: n.created_at }));
}

export function insertNote(title, body) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO notes (title, body) VALUES (?, ?)')
    .run(title, body);
  return Number(lastInsertRowid);
}

export default db;
