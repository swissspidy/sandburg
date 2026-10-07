<script>
  import { enhance } from '$app/forms';

  let { data, form } = $props();

  let descriptionInput;

  const fmt = (cents) => `$${(cents / 100).toFixed(2)}`;

  function addEnhance() {
    return async ({ result, update }) => {
      await update();
      if (result.type === 'success') descriptionInput?.focus();
    };
  }
</script>

<svelte:head>
  <title>Expense Tracker</title>
</svelte:head>

<main>
  <header>
    <h1>Expense Tracker</h1>
    <p class="total" aria-live="polite">{`Total: ${fmt(data.totalCents)}`}</p>
  </header>

  <section class="card" aria-labelledby="add-heading">
    <h2 id="add-heading">New expense</h2>
    <form method="POST" action="?/add" use:enhance={addEnhance} class="add-form">
      <div class="field grow">
        <label for="description">Description</label>
        <input
          id="description"
          name="description"
          type="text"
          maxlength="200"
          placeholder="e.g. Groceries"
          autocomplete="off"
          required
          value={form?.description ?? ''}
          bind:this={descriptionInput}
        />
      </div>
      <div class="field amount">
        <label for="amount">Amount</label>
        <div class="money">
          <span aria-hidden="true">$</span>
          <input
            id="amount"
            name="amount"
            type="number"
            step="0.01"
            min="0.01"
            inputmode="decimal"
            placeholder="0.00"
            required
            value={form?.amount ?? ''}
          />
        </div>
      </div>
      <button type="submit" class="primary">Add expense</button>
    </form>
    {#if form?.error}
      <p class="error" role="alert">{form.error}</p>
    {/if}
  </section>

  <section class="card" aria-labelledby="list-heading">
    <h2 id="list-heading">Expenses</h2>
    <ul class="list" aria-labelledby="list-heading">
      {#each data.expenses as expense (expense.id)}
        <li>
          <span class="desc">{expense.description}</span>
          <span class="amt">{fmt(expense.cents)}</span>
          <form method="POST" action="?/remove" use:enhance>
            <input type="hidden" name="id" value={expense.id} />
            <button type="submit" class="remove" aria-label={`Remove ${expense.description}`} title="Remove">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
          </form>
        </li>
      {/each}
    </ul>
    {#if data.expenses.length === 0}
      <div class="empty">
        <span aria-hidden="true">🧾</span>
        <p>No expenses yet. Add your first one above.</p>
      </div>
    {/if}
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: #f4f6fb;
    color: #1f2937;
    line-height: 1.5;
  }

  main {
    max-width: 680px;
    margin: 0 auto;
    padding: 2rem 1rem 3rem;
  }

  header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    margin-bottom: 1.5rem;
  }

  h1 {
    margin: 0;
    font-size: 1.75rem;
    letter-spacing: -0.02em;
  }

  .total {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 700;
    color: #4338ca;
    background: #e0e7ff;
    padding: 0.35rem 0.85rem;
    border-radius: 999px;
    font-variant-numeric: tabular-nums;
  }

  .card {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 14px;
    padding: 1.25rem;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
    margin-bottom: 1.25rem;
  }

  h2 {
    margin: 0 0 0.9rem;
    font-size: 1rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
  }

  .add-form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: flex-end;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .field.grow {
    flex: 1 1 220px;
  }

  .field.amount {
    flex: 0 1 150px;
  }

  label {
    font-size: 0.875rem;
    font-weight: 600;
  }

  input[type='text'],
  input[type='number'] {
    font: inherit;
    padding: 0.55rem 0.7rem;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    background: #fff;
    color: inherit;
    width: 100%;
    box-sizing: border-box;
  }

  .money {
    position: relative;
  }

  .money span {
    position: absolute;
    left: 0.7rem;
    top: 50%;
    transform: translateY(-50%);
    color: #9ca3af;
  }

  .money input {
    padding-left: 1.5rem;
  }

  input:focus {
    outline: none;
    border-color: #6366f1;
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.25);
  }

  button {
    font: inherit;
    cursor: pointer;
  }

  .primary {
    background: #4f46e5;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 0.6rem 1.1rem;
    font-weight: 600;
    transition: background 0.15s;
  }

  .primary:hover {
    background: #4338ca;
  }

  .primary:focus-visible,
  .remove:focus-visible {
    outline: 3px solid rgba(99, 102, 241, 0.45);
    outline-offset: 2px;
  }

  .error {
    margin: 0.75rem 0 0;
    color: #b91c1c;
    font-size: 0.9rem;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .list li {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 0.25rem;
    border-bottom: 1px solid #f1f5f9;
  }

  .list li:last-child {
    border-bottom: none;
  }

  .desc {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .amt {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .list form {
    margin: 0;
  }

  .remove {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: #9ca3af;
    transition: background 0.15s, color 0.15s;
  }

  .remove:hover {
    background: #fee2e2;
    color: #dc2626;
  }

  .empty {
    text-align: center;
    padding: 1.5rem 0 0.5rem;
    color: #6b7280;
  }

  .empty span {
    font-size: 2rem;
  }

  .empty p {
    margin: 0.25rem 0 0;
  }

  @media (max-width: 480px) {
    .field.amount,
    .primary {
      flex: 1 1 100%;
    }
  }
</style>
