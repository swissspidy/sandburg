const billEl = document.getElementById('bill');
const tipEl = document.getElementById('tip');
const peopleEl = document.getElementById('people');
const tipOut = document.getElementById('tipOut');
const totalOut = document.getElementById('totalOut');
const perOut = document.getElementById('perOut');
const summary = document.getElementById('summary');
const errorEl = document.getElementById('error');
const presetButtons = document.querySelectorAll('[data-tip]');

const fmt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const money = (n) => `$${fmt.format(n)}`;

function readNumber(el, fallback) {
  if (el.value.trim() === '') return fallback;
  const n = Number(el.value);
  return Number.isFinite(n) ? n : NaN;
}

function update() {
  const bill = readNumber(billEl, 0);
  const pct = readNumber(tipEl, 0);
  const people = readNumber(peopleEl, 1);

  const errors = [];
  if (Number.isNaN(bill) || bill < 0) errors.push('Bill amount must be zero or more.');
  if (Number.isNaN(pct) || pct < 0) errors.push('Tip percent must be zero or more.');
  if (Number.isNaN(people) || people < 1 || !Number.isInteger(people)) errors.push('People must be a whole number of at least 1.');

  billEl.setAttribute('aria-invalid', String(Number.isNaN(bill) || bill < 0));
  tipEl.setAttribute('aria-invalid', String(Number.isNaN(pct) || pct < 0));
  peopleEl.setAttribute('aria-invalid', String(Number.isNaN(people) || people < 1 || !Number.isInteger(people)));

  presetButtons.forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.tip) === pct));
  });

  if (errors.length) {
    errorEl.textContent = errors.join(' ');
    errorEl.hidden = false;
    tipOut.textContent = '—';
    totalOut.textContent = '—';
    perOut.textContent = '—';
    return;
  }
  errorEl.hidden = true;

  const tip = (bill * pct) / 100;
  const total = bill + tip;
  const per = total / people;

  tipOut.textContent = money(tip);
  totalOut.textContent = money(total);
  perOut.textContent = money(per);
  summary.textContent = `Tip: ${money(tip)}. Total: ${money(total)}. Per person: ${money(per)}.`;
}

document.getElementById('calc').addEventListener('input', update);
document.getElementById('calc').addEventListener('submit', (e) => e.preventDefault());

presetButtons.forEach((b) => {
  b.addEventListener('click', () => {
    tipEl.value = b.dataset.tip;
    update();
  });
});

document.getElementById('reset').addEventListener('click', () => {
  billEl.value = '';
  tipEl.value = '15';
  peopleEl.value = '1';
  update();
  billEl.focus();
});

update();
