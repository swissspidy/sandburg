import db from '../db.js';

export default defineEventHandler(() => {
  return db
    .prepare(
      'SELECT id, description, amount_cents AS amountCents, category FROM expenses ORDER BY id DESC'
    )
    .all();
});
