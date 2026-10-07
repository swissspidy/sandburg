import { Component, computed, signal } from '@angular/core';

interface Expense {
  id: number;
  description: string;
  amountCents: number;
  createdAt: string;
}

function formatCents(cents: number): string {
  return '$' + (cents / 100).toFixed(2);
}

@Component({
  selector: 'app-root',
  template: `
    <main class="shell">
      <header class="header">
        <span class="logo" aria-hidden="true">💸</span>
        <div>
          <h1>Expense Tracker</h1>
          <p class="subtitle">Keep an eye on where your money goes.</p>
        </div>
      </header>

      <section class="card" aria-labelledby="add-heading">
        <h2 id="add-heading" class="section-title">New expense</h2>
        <form class="form" (submit)="add($event)" novalidate>
          <div class="field grow">
            <label for="description">Description</label>
            <input
              id="description"
              type="text"
              autocomplete="off"
              maxlength="200"
              placeholder="e.g. Groceries"
              [value]="description()"
              (input)="description.set(inputValue($event))"
            />
          </div>
          <div class="field amount">
            <label for="amount">Amount</label>
            <div class="money-input">
              <span aria-hidden="true">$</span>
              <input
                id="amount"
                type="number"
                inputmode="decimal"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                [value]="amount()"
                (input)="amount.set(inputValue($event))"
              />
            </div>
          </div>
          <button type="submit" class="primary" [disabled]="saving()">
            {{ saving() ? 'Adding…' : 'Add expense' }}
          </button>
        </form>
        @if (error()) {
          <p class="error" role="alert">{{ error() }}</p>
        }
      </section>

      <section class="card" aria-labelledby="list-heading">
        <div class="list-header">
          <h2 id="list-heading" class="section-title">Expenses</h2>
          <p class="total" aria-live="polite">Total: {{ totalText() }}</p>
        </div>

        @if (loading()) {
          <p class="muted">Loading expenses…</p>
        } @else {
          <ul class="list" aria-labelledby="list-heading">
            @for (e of expenses(); track e.id) {
              <li class="item">
                <span class="desc">{{ e.description }}</span>
                <span class="amt">{{ format(e.amountCents) }}</span>
                <button
                  type="button"
                  class="remove"
                  [attr.aria-label]="'Remove ' + e.description"
                  [title]="'Remove ' + e.description"
                  [disabled]="removing() === e.id"
                  (click)="remove(e)"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" />
                  </svg>
                </button>
              </li>
            }
          </ul>
          @if (expenses().length === 0) {
            <div class="empty">
              <span aria-hidden="true">🧾</span>
              <p>No expenses yet. Add your first one above.</p>
            </div>
          }
        }
      </section>
    </main>
  `,
})
export class App {
  protected readonly expenses = signal<Expense[]>([]);
  protected readonly description = signal('');
  protected readonly amount = signal('');
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly removing = signal<number | null>(null);
  protected readonly error = signal('');

  protected readonly totalText = computed(() =>
    formatCents(this.expenses().reduce((sum, e) => sum + e.amountCents, 0)),
  );

  constructor() {
    this.load();
  }

  protected format(cents: number): string {
    return formatCents(cents);
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch('/api/expenses');
      if (!res.ok) throw new Error();
      this.expenses.set(await res.json());
    } catch {
      this.error.set('Could not load expenses.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async add(event: Event): Promise<void> {
    event.preventDefault();
    const description = this.description().trim();
    const amount = Number(this.amount());
    if (!description) {
      this.error.set('Please enter a description.');
      return;
    }
    if (this.amount() === '' || !Number.isFinite(amount) || amount <= 0) {
      this.error.set('Please enter an amount greater than zero.');
      return;
    }
    this.error.set('');
    this.saving.set(true);
    try {
      const res = await fetch('/api/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, amount }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add expense.');
      this.expenses.update((list) => [data as Expense, ...list]);
      this.description.set('');
      this.amount.set('');
      document.getElementById('description')?.focus();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not add expense.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(expense: Expense): Promise<void> {
    this.removing.set(expense.id);
    this.error.set('');
    try {
      const res = await fetch(`/api/expenses/${expense.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error();
      this.expenses.update((list) => list.filter((e) => e.id !== expense.id));
    } catch {
      this.error.set(`Could not remove "${expense.description}".`);
    } finally {
      this.removing.set(null);
    }
  }
}
