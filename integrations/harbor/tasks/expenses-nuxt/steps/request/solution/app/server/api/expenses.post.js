import db from '../db.js';

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) || {};
  const description = String(body.description ?? '').trim();
  const amount = Number(body.amount);

  if (!description) {
    throw createError({ statusCode: 400, statusMessage: 'Description is required.' });
  }
  if (description.length > 200) {
    throw createError({ statusCode: 400, statusMessage: 'Description is too long.' });
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) {
    throw createError({ statusCode: 400, statusMessage: 'Amount must be a positive number.' });
  }

  const amountCents = Math.round(amount * 100);
  if (amountCents <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Amount must be at least $0.01.' });
  }

  const result = db
    .prepare('INSERT INTO expenses (description, amount_cents) VALUES (?, ?)')
    .run(description, amountCents);

  return { id: Number(result.lastInsertRowid), description, amountCents };
});
