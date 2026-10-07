import db from '../../db.js';

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'));
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id.' });
  }
  const result = db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  if (result.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: 'Expense not found.' });
  }
  return { ok: true };
});
