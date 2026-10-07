import db from '../db.js';

export default defineEventHandler(() => {
  return db
    .prepare('SELECT id, title, body, created_at FROM notes ORDER BY id DESC')
    .all();
});
