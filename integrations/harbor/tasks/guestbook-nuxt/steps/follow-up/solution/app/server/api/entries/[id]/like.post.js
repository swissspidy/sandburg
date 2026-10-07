import db from '../../../db.js';

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'));
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid entry id.' });
  }
  const result = db.prepare('UPDATE entries SET likes = likes + 1 WHERE id = ?').run(id);
  if (!result.changes) {
    throw createError({ statusCode: 404, statusMessage: 'Entry not found.' });
  }
  const row = db.prepare('SELECT likes FROM entries WHERE id = ?').get(id);
  return { id, likes: row.likes };
});
