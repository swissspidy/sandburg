import db from '../db.js';

export default defineEventHandler(() => {
  return db
    .prepare('SELECT id, title, body, pinned, created_at FROM notes ORDER BY pinned DESC, id DESC')
    .all()
    .map((n) => ({ ...n, pinned: Boolean(n.pinned) }));
});
