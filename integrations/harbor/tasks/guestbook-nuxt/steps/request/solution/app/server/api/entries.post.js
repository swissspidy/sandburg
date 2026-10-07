import db from '../db.js';

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) || {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';

  if (!message) {
    throw createError({ statusCode: 400, statusMessage: 'Please write a message before signing.' });
  }
  if (message.length > 2000) {
    throw createError({ statusCode: 400, statusMessage: 'Message is too long (2000 characters max).' });
  }

  const name = (rawName || 'Anonymous').slice(0, 100);
  const createdAt = new Date().toISOString();
  const result = db
    .prepare('INSERT INTO entries (name, message, created_at) VALUES (?, ?, ?)')
    .run(name, message, createdAt);

  return { id: Number(result.lastInsertRowid), name, message, created_at: createdAt };
});
