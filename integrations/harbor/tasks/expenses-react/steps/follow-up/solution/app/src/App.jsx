import { useEffect, useState } from 'react';

const CATEGORIES = ['Food', 'Transport', 'Other'];
const CATEGORY_ICONS = { Food: '🍔', Transport: '🚌', Other: '📦' };

const formatCents = (cents) => (cents / 100).toFixed(2);

export default function App() {
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('Other');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/expenses')
      .then((r) => {
        if (!r.ok) throw new Error('Could not load expenses.');
        return r.json();
      })
      .then((data) => !cancelled && setExpenses(data))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const totalCents = expenses.reduce((sum, e) => sum + e.amountCents, 0);
  const categoryTotals = CATEGORIES.map((name) => {
    const items = expenses.filter((e) => e.category === name);
    return {
      name,
      count: items.length,
      cents: items.reduce((sum, e) => sum + e.amountCents, 0),
    };
  }).filter((c) => c.count > 0);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    const desc = description.trim();
    const value = Number(amount);
    if (!desc) return setError('Please enter a description.');
    if (amount === '' || !Number.isFinite(value) || value <= 0) {
      return setError('Please enter an amount greater than zero.');
    }
    setSaving(true);
    try {
      const res = await fetch('/api/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: desc, amount: value, category }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add expense.');
      setExpenses((list) => [data, ...list]);
      setDescription('');
      setAmount('');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(id) {
    setError('');
    try {
      const res = await fetch(`/api/expenses/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error('Could not remove expense.');
      setExpenses((list) => list.filter((e) => e.id !== id));
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <main className="container">
      <header className="header">
        <h1>
          <span aria-hidden="true">💸</span> Expense Tracker
        </h1>
        <div className="summary" aria-live="polite">
          <p className="total">{`Total: $${formatCents(totalCents)}`}</p>
          {categoryTotals.length > 0 && (
            <ul className="breakdown" aria-label="Totals by category">
              {categoryTotals.map((c) => (
                <li key={c.name} className={`cat cat-${c.name.toLowerCase()}`}>
                  {`${c.name}: $${formatCents(c.cents)}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      </header>

      <form className="card form" onSubmit={handleSubmit} noValidate>
        <div className="field grow">
          <label htmlFor="description">Description</label>
          <input
            id="description"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Groceries"
            maxLength={200}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="amount">Amount</label>
          <div className="money">
            <span aria-hidden="true">$</span>
            <input
              id="amount"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="category">Category</label>
          <select id="category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="primary" disabled={saving}>
          Add expense
        </button>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="card">
        <h2 id="expenses-heading">Expenses</h2>
        <ul className="list" aria-labelledby="expenses-heading">
          {expenses.map((e) => (
            <li key={e.id} className="item">
              <span className="desc">{e.description}</span>
              <span className={`badge cat-${e.category.toLowerCase()}`}>
                <span aria-hidden="true">{CATEGORY_ICONS[e.category]} </span>
                {e.category}
              </span>
              <span className="amount">${formatCents(e.amountCents)}</span>
              <button
                type="button"
                className="remove"
                aria-label={`Remove ${e.description}`}
                title={`Remove ${e.description}`}
                onClick={() => handleRemove(e.id)}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    d="M6 6l12 12M18 6L6 18"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>
        {!loading && expenses.length === 0 && (
          <p className="empty">No expenses yet. Add your first one above.</p>
        )}
        {loading && <p className="empty">Loading…</p>}
      </section>
    </main>
  );
}
