import { DatabaseSync } from 'node:sqlite';

// The app's database: a file next to the project (exec, prepare(sql).all/get/run).
const db = new DatabaseSync('app.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migrate databases created before pinning existed: existing notes start unpinned.
const columns = db.prepare('PRAGMA table_info(notes)').all();
if (!columns.some((c) => c.name === 'pinned')) {
  db.exec('ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
}

export function listNotes() {
  return db
    .prepare(
      'SELECT id, title, body, pinned, created_at FROM notes ORDER BY pinned DESC, id DESC'
    )
    .all()
    .map((n) => ({
      id: Number(n.id),
      title: n.title,
      body: n.body,
      pinned: Number(n.pinned) === 1,
      createdAt: n.created_at,
    }));
}

export function insertNote(title, body) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO notes (title, body) VALUES (?, ?)')
    .run(title, body);
  return Number(lastInsertRowid);
}

export function setPinned(id, pinned) {
  const { changes } = db
    .prepare('UPDATE notes SET pinned = ? WHERE id = ?')
    .run(pinned ? 1 : 0, id);
  return changes > 0;
}

export default db;
