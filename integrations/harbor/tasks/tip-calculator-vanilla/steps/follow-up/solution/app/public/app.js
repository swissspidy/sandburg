const billEl = document.getElementById('bill');
const tipEl = document.getElementById('tip');
const peopleEl = document.getElementById('people');
const roundEl = document.getElementById('roundUp');
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

  const billBad = Number.isNaN(bill) || bill < 0;
  const pctBad = Number.isNaN(pct) || pct < 0;
  const peopleBad = Number.isNaN(people) || people < 1 || !Number.isInteger(people);

  const errors = [];
  if (billBad) errors.push('Bill amount must be zero or more.');
  if (pctBad) errors.push('Tip percent must be zero or more.');
  if (peopleBad) errors.push('People must be a whole number of at least 1.');

  billEl.setAttribute('aria-invalid', String(billBad));
  tipEl.setAttribute('aria-invalid', String(pctBad));
  peopleEl.setAttribute('aria-invalid', String(peopleBad));

  presetButtons.forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.tip) === pct));
  });

  if (errors.length) {
    errorEl.textContent = errors.join(' ');
    errorEl.hidden = false;
    tipOut.textContent = '—';
    totalOut.textContent = '—';
    perOut.textContent = '—';
    summary.textContent = '';
    return;
  }
  errorEl.hidden = true;

  // Work in cents to avoid floating-point surprises when rounding.
  const billCents = Math.round(bill * 100);
  let tipCents = Math.round((billCents * pct) / 100);
  let totalCents = billCents + tipCents;

  if (roundEl.checked) {
    totalCents = Math.ceil(totalCents / 100) * 100;
    tipCents = totalCents - billCents;
  }

  const tip = tipCents / 100;
  const total = totalCents / 100;
  const per = total / people;

  tipOut.textContent = money(tip);
  totalOut.textContent = money(total);
  perOut.textContent = money(per);
  summary.textContent = `Tip: ${money(tip)}. Total: ${money(total)}. Per person: ${money(per)}.`;
}

const form = document.getElementById('calc');
form.addEventListener('input', update);
form.addEventListener('change', update);
form.addEventListener('submit', (e) => e.preventDefault());

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
  roundEl.checked = false;
  update();
  billEl.focus();
});

update();
