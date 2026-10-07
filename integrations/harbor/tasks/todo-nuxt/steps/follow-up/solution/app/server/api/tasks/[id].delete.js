import db from '../../db.js';

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'));
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' });
  }
  const { changes } = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  if (!changes) {
    throw createError({ statusCode: 404, statusMessage: 'Task not found' });
  }
  return { ok: true };
});
