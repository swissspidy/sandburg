import db, { toTask } from '../db.js';

export default defineEventHandler(() => {
  return db
    .prepare('SELECT id, text, done, priority FROM tasks ORDER BY priority DESC, id ASC')
    .all()
    .map(toTask);
});
