import db from '../lib/db.js';
import ExpenseForm from './ExpenseForm.js';
import { removeExpense } from './actions.js';
import { CATEGORIES, DEFAULT_CATEGORY } from '../lib/categories.js';

// Rendered on each request (it reads the database).
export const dynamic = 'force-dynamic';

function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function Page() {
  const expenses = db
    .prepare('SELECT id, description, amount_cents, category FROM expenses ORDER BY id DESC')
    .all()
    .map((e) => ({
      ...e,
      amount_cents: Number(e.amount_cents),
      category: CATEGORIES.includes(e.category) ? e.category : DEFAULT_CATEGORY,
    }));

  const totalCents = expenses.reduce((sum, e) => sum + e.amount_cents, 0);
  const byCategory = CATEGORIES.map((c) => {
    const items = expenses.filter((e) => e.category === c);
    return { category: c, count: items.length, cents: items.reduce((s, e) => s + e.amount_cents, 0) };
  }).filter((c) => c.count > 0);

  return (
    <main className="container">
      <header className="page-header">
        <h1>💸 Expense Tracker</h1>
        <p className="subtitle">Keep an eye on where your money goes.</p>
      </header>

      <section className="card" aria-labelledby="add-heading">
        <h2 id="add-heading" className="section-title">Add an expense</h2>
        <ExpenseForm />
      </section>

      <section className="card" aria-labelledby="expenses-heading">
        <div className="summary">
          <div className="list-header">
            <h2 id="expenses-heading" className="section-title">Expenses</h2>
            <p className="total">{`Total: ${formatCents(totalCents)}`}</p>
          </div>
          {byCategory.length > 0 && (
            <ul className="category-totals" aria-label="Totals by category">
              {byCategory.map((c) => (
                <li key={c.category} className={`cat-total cat-${c.category.toLowerCase()}`}>
                  {`${c.category}: ${formatCents(c.cents)}`}
                </li>
              ))}
            </ul>
          )}
        </div>

        <ul className="expense-list" aria-labelledby="expenses-heading">
          {expenses.map((e) => (
            <li key={e.id} className="expense-item">
              <span className="desc">{e.description}</span>
              <span className={`badge cat-${e.category.toLowerCase()}`}>{e.category}</span>
              <span className="amount">{formatCents(e.amount_cents)}</span>
              <form action={removeExpense}>
                <input type="hidden" name="id" value={e.id} />
                <button
                  type="submit"
                  className="btn-remove"
                  aria-label={`Remove ${e.description}`}
                  title={`Remove ${e.description}`}
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
              </form>
            </li>
          ))}
        </ul>

        {expenses.length === 0 && (
          <div className="empty">
            <span className="empty-icon" aria-hidden="true">🧾</span>
            <p>No expenses yet. Add your first one above.</p>
          </div>
        )}
      </section>
    </main>
  );
}
