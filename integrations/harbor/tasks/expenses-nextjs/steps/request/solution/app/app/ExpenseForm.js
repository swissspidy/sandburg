'use client';

import { useActionState, useEffect, useRef } from 'react';
import { addExpense } from './actions.js';

const initialState = { error: null, values: { description: '', amount: '' } };

export default function ExpenseForm() {
  const [state, formAction, pending] = useActionState(addExpense, initialState);
  const descRef = useRef(null);

  useEffect(() => {
    if (state.ok) descRef.current?.focus();
  }, [state.ok]);

  return (
    <form action={formAction} className="expense-form" noValidate>
      <div className="field grow">
        <label htmlFor="description">Description</label>
        <input
          ref={descRef}
          id="description"
          name="description"
          type="text"
          placeholder="e.g. Groceries"
          defaultValue={state.values.description}
          key={`d-${state.ok ?? 'x'}`}
          maxLength={200}
          required
          autoComplete="off"
        />
      </div>
      <div className="field amount-field">
        <label htmlFor="amount">Amount</label>
        <div className="amount-wrap">
          <span aria-hidden="true">$</span>
          <input
            id="amount"
            name="amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            placeholder="0.00"
            defaultValue={state.values.amount}
            key={`a-${state.ok ?? 'x'}`}
            required
          />
        </div>
      </div>
      <button type="submit" className="btn-primary" disabled={pending}>
        {pending ? 'Adding…' : 'Add expense'}
      </button>
      <p className="form-error" role="alert" aria-live="polite">
        {state.error ?? ''}
      </p>
    </form>
  );
}
