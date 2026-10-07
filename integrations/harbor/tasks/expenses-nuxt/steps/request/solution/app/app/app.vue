<script setup>
const { data: expenses, refresh } = await useFetch('/api/expenses', {
  default: () => [],
});

const description = ref('');
const amount = ref('');
const error = ref('');
const saving = ref(false);
const removingId = ref(null);
const descriptionInput = ref(null);

const totalCents = computed(() =>
  expenses.value.reduce((sum, e) => sum + e.amountCents, 0)
);

function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

async function addExpense() {
  error.value = '';
  const desc = description.value.trim();
  const amt = Number(amount.value);
  if (!desc) {
    error.value = 'Please enter a description.';
    return;
  }
  if (amount.value === '' || !Number.isFinite(amt) || amt <= 0) {
    error.value = 'Please enter an amount greater than zero.';
    return;
  }
  saving.value = true;
  try {
    const created = await $fetch('/api/expenses', {
      method: 'POST',
      body: { description: desc, amount: amt },
    });
    expenses.value = [created, ...expenses.value];
    description.value = '';
    amount.value = '';
    descriptionInput.value?.focus();
  } catch (e) {
    error.value = e?.data?.statusMessage || e?.statusMessage || 'Could not add expense.';
  } finally {
    saving.value = false;
  }
}

async function removeExpense(expense) {
  error.value = '';
  removingId.value = expense.id;
  try {
    await $fetch(`/api/expenses/${expense.id}`, { method: 'DELETE' });
    expenses.value = expenses.value.filter((e) => e.id !== expense.id);
  } catch (e) {
    error.value = e?.data?.statusMessage || 'Could not remove expense.';
    await refresh();
  } finally {
    removingId.value = null;
  }
}
</script>

<template>
  <main class="page">
    <header class="header">
      <h1>💸 Expense Tracker</h1>
      <p class="subtitle">Keep an eye on where your money goes.</p>
    </header>

    <section class="card" aria-labelledby="add-heading">
      <h2 id="add-heading" class="section-title">New expense</h2>
      <form class="form" @submit.prevent="addExpense" novalidate>
        <div class="field grow">
          <label for="description">Description</label>
          <input
            id="description"
            ref="descriptionInput"
            v-model="description"
            type="text"
            maxlength="200"
            placeholder="e.g. Groceries"
            autocomplete="off"
          />
        </div>
        <div class="field amount">
          <label for="amount">Amount</label>
          <div class="amount-wrap">
            <span class="currency" aria-hidden="true">$</span>
            <input
              id="amount"
              v-model="amount"
              type="number"
              inputmode="decimal"
              min="0.01"
              step="0.01"
              placeholder="0.00"
            />
          </div>
        </div>
        <button type="submit" class="btn-primary" :disabled="saving">
          {{ saving ? 'Adding…' : 'Add expense' }}
        </button>
      </form>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </section>

    <section class="card" aria-labelledby="list-heading">
      <div class="list-header">
        <h2 id="list-heading" class="section-title">Expenses</h2>
        <p class="total" aria-live="polite">Total: {{ formatCents(totalCents) }}</p>
      </div>

      <ul class="list" aria-labelledby="list-heading">
        <li v-for="expense in expenses" :key="expense.id" class="item">
          <span class="item-desc">{{ expense.description }}</span>
          <span class="item-amount">{{ formatCents(expense.amountCents) }}</span>
          <button
            type="button"
            class="btn-remove"
            :aria-label="`Remove ${expense.description}`"
            :disabled="removingId === expense.id"
            @click="removeExpense(expense)"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                fill="none"
              />
            </svg>
            <span class="btn-remove-text">Remove</span>
          </button>
        </li>
      </ul>
      <p v-if="expenses.length === 0" class="empty">
        No expenses yet. Add your first one above.
      </p>
    </section>
  </main>
</template>
