import { fail } from '@sveltejs/kit';
import db from '$lib/server/db.js';

const CATEGORIES = ['Food', 'Transport', 'Other'];

export function load() {
  const expenses = db
    .prepare('SELECT id, description, amount_cents, category FROM expenses ORDER BY id DESC')
    .all()
    .map((r) => ({
      id: Number(r.id),
      description: r.description,
      cents: Number(r.amount_cents),
      category: CATEGORIES.includes(r.category) ? r.category : 'Other'
    }));
  const totalCents = expenses.reduce((sum, e) => sum + e.cents, 0);
  const byCategory = CATEGORIES.map((name) => {
    const items = expenses.filter((e) => e.category === name);
    return { name, count: items.length, cents: items.reduce((s, e) => s + e.cents, 0) };
  }).filter((c) => c.count > 0);
  return { expenses, totalCents, byCategory, categories: CATEGORIES };
}

export const actions = {
  add: async ({ request }) => {
    const form = await request.formData();
    const description = String(form.get('description') ?? '').trim();
    const amountRaw = String(form.get('amount') ?? '').trim();
    const categoryRaw = String(form.get('category') ?? 'Other');
    const category = CATEGORIES.includes(categoryRaw) ? categoryRaw : 'Other';
    const amount = Number(amountRaw);
    const values = { description, amount: amountRaw, category };

    if (!description) {
      return fail(400, { error: 'Please enter a description.', ...values });
    }
    if (description.length > 200) {
      return fail(400, { error: 'Description is too long (200 characters max).', ...values });
    }
    if (amountRaw === '' || !Number.isFinite(amount) || amount <= 0) {
      return fail(400, { error: 'Please enter an amount greater than 0.', ...values });
    }
    const cents = Math.round(amount * 100);
    if (cents <= 0 || cents > 100_000_000_00) {
      return fail(400, { error: 'Please enter a valid amount.', ...values });
    }

    db.prepare('INSERT INTO expenses (description, amount_cents, category) VALUES (?, ?, ?)').run(
      description,
      cents,
      category
    );
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
