import db from '../../db.js';

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'));
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' });
  }
  const { changes } = db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  return { deleted: changes > 0 };
});
