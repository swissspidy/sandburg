'use server';

import { revalidatePath } from 'next/cache';
import db from '../lib/db.js';

export async function addExpense(prevState, formData) {
  const description = String(formData.get('description') ?? '').trim();
  const amountRaw = String(formData.get('amount') ?? '').trim();
  const amount = Number(amountRaw);

  if (!description) {
    return { error: 'Please enter a description.', values: { description, amount: amountRaw } };
  }
  if (description.length > 200) {
    return { error: 'Description is too long (200 characters max).', values: { description, amount: amountRaw } };
  }
  if (amountRaw === '' || !Number.isFinite(amount) || amount <= 0) {
    return { error: 'Please enter an amount greater than 0.', values: { description, amount: amountRaw } };
  }
  const cents = Math.round(amount * 100);
  if (cents <= 0 || cents > 100_000_000_00) {
    return { error: 'Please enter a reasonable amount.', values: { description, amount: amountRaw } };
  }

  db.prepare('INSERT INTO expenses (description, amount_cents) VALUES (?, ?)').run(description, cents);
  revalidatePath('/');
  return { error: null, values: { description: '', amount: '' }, ok: Date.now() };
}

export async function removeExpense(formData) {
  const id = Number(formData.get('id'));
  if (Number.isInteger(id)) {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  }
  revalidatePath('/');
}
