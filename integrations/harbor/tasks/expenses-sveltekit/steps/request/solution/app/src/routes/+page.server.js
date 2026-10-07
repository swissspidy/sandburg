import { fail } from '@sveltejs/kit';
import db from '$lib/server/db.js';

export function load() {
  const expenses = db
    .prepare('SELECT id, description, amount_cents FROM expenses ORDER BY id DESC')
    .all()
    .map((r) => ({ id: Number(r.id), description: r.description, cents: Number(r.amount_cents) }));
  const totalCents = expenses.reduce((sum, e) => sum + e.cents, 0);
  return { expenses, totalCents };
}

export const actions = {
  add: async ({ request }) => {
    const form = await request.formData();
    const description = String(form.get('description') ?? '').trim();
    const amountRaw = String(form.get('amount') ?? '').trim();
    const amount = Number(amountRaw);

    if (!description) {
      return fail(400, { error: 'Please enter a description.', description, amount: amountRaw });
    }
    if (description.length > 200) {
      return fail(400, { error: 'Description is too long (200 characters max).', description, amount: amountRaw });
    }
    if (amountRaw === '' || !Number.isFinite(amount) || amount <= 0) {
      return fail(400, { error: 'Please enter an amount greater than 0.', description, amount: amountRaw });
    }
    const cents = Math.round(amount * 100);
    if (cents <= 0 || cents > 100_000_000_00) {
      return fail(400, { error: 'Please enter a valid amount.', description, amount: amountRaw });
    }

    db.prepare('INSERT INTO expenses (description, amount_cents) VALUES (?, ?)').run(description, cents);
    return { success: true };
  },

  remove: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    if (!Number.isInteger(id)) return fail(400, { error: 'Invalid expense.' });
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    return { removed: true };
  }
};
