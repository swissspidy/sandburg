'use server';

import { revalidatePath } from 'next/cache';
import db from '../lib/db.js';
import { CATEGORIES, DEFAULT_CATEGORY } from '../lib/categories.js';

export async function addExpense(prevState, formData) {
  const description = String(formData.get('description') ?? '').trim();
  const amountRaw = String(formData.get('amount') ?? '').trim();
  const categoryRaw = String(formData.get('category') ?? DEFAULT_CATEGORY);
  const category = CATEGORIES.includes(categoryRaw) ? categoryRaw : DEFAULT_CATEGORY;
  const amount = Number(amountRaw);
  const values = { description, amount: amountRaw, category };

  if (!description) {
    return { error: 'Please enter a description.', values };
  }
  if (description.length > 200) {
    return { error: 'Description is too long (200 characters max).', values };
  }
  if (amountRaw === '' || !Number.isFinite(amount) || amount <= 0) {
    return { error: 'Please enter an amount greater than 0.', values };
  }
  const cents = Math.round(amount * 100);
  if (cents <= 0 || cents > 100_000_000_00) {
    return { error: 'Please enter a reasonable amount.', values };
  }

  db.prepare('INSERT INTO expenses (description, amount_cents, category) VALUES (?, ?, ?)').run(
    description,
    cents,
    category
  );
  revalidatePath('/');
  return {
    error: null,
    values: { description: '', amount: '', category: DEFAULT_CATEGORY },
    ok: Date.now(),
  };
}

export async function removeExpense(formData) {
  const id = Number(formData.get('id'));
  if (Number.isInteger(id)) {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  }
  revalidatePath('/');
}
