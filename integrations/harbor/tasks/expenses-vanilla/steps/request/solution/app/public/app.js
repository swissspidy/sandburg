const form = document.getElementById('expense-form');
const descInput = document.getElementById('description');
const amountInput = document.getElementById('amount');
const submitBtn = form.querySelector('button[type="submit"]');
const listEl = document.getElementById('expenses');
const emptyEl = document.getElementById('empty');
const totalEl = document.getElementById('total');
const errorEl = document.getElementById('error');

let expenses = [];

const formatCents = (cents) => `$${(cents / 100).toFixed(2)}`;

function render() {
  listEl.replaceChildren(
    ...expenses.map((e) => {
      const li = document.createElement('li');
      li.className = 'item';

      const desc = document.createElement('span');
      desc.className = 'item-desc';
      desc.textContent = e.description;

      const amount = document.createElement('span');
      amount.className = 'item-amount';
      amount.textContent = formatCents(e.amountCents);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-remove';
      btn.textContent = 'Remove';
      btn.setAttribute('aria-label', `Remove ${e.description}`);
      btn.addEventListener('click', () => removeExpense(e.id, btn));

      li.append(desc, amount, btn);
      return li;
    })
  );
  emptyEl.hidden = expenses.length > 0;
  const total = expenses.reduce((sum, e) => sum + e.amountCents, 0);
  totalEl.textContent = `Total: ${formatCents(total)}`;
}

function showError(msg) {
  errorEl.textContent = msg;
}

async function load() {
  try {
    const res = await fetch('/api/expenses');
    if (!res.ok) throw new Error();
    expenses = await res.json();
  } catch {
    showError('Could not load expenses.');
  }
  render();
}

async function removeExpense(id, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(`/api/expenses/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error();
    expenses = expenses.filter((e) => e.id !== id);
    showError('');
    render();
    descInput.focus();
  } catch {
    btn.disabled = false;
    showError('Could not remove the expense. Please try again.');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const description = descInput.value.trim();
  const amount = Number(amountInput.value);
  descInput.removeAttribute('aria-invalid');
  amountInput.removeAttribute('aria-invalid');

  if (!description) {
    descInput.setAttribute('aria-invalid', 'true');
    descInput.focus();
    return showError('Please enter a description.');
  }
  if (amountInput.value === '' || !Number.isFinite(amount) || Math.round(amount * 100) <= 0) {
    amountInput.setAttribute('aria-invalid', 'true');
    amountInput.focus();
    return showError('Please enter an amount greater than $0.00.');
  }

  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, amount }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not add the expense.');
    expenses.unshift(data);
    showError('');
    form.reset();
    render();
    descInput.focus();
  } catch (err) {
    showError(err.message || 'Could not add the expense.');
  } finally {
    submitBtn.disabled = false;
  }
});

load();
