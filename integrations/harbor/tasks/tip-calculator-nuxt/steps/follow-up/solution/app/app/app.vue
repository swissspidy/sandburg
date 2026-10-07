<script setup>
useHead({
  title: 'Tip Calculator',
  htmlAttrs: { lang: 'en' },
});

const bill = ref('');
const tipPercent = ref(15);
const people = ref(1);
const roundUp = ref(false);

const presets = [10, 15, 18, 20, 25];

function toNumber(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const billValue = computed(() => Math.max(0, toNumber(bill.value)));
const tipValue = computed(() => Math.max(0, toNumber(tipPercent.value)));
const peopleValue = computed(() => {
  const n = Math.floor(toNumber(people.value));
  return n >= 1 ? n : 1;
});

const errors = computed(() => {
  const list = [];
  if (toNumber(bill.value) < 0) list.push('Bill amount can’t be negative.');
  if (toNumber(tipPercent.value) < 0) list.push('Tip percent can’t be negative.');
  if (people.value !== '' && toNumber(people.value) < 1) list.push('People must be at least 1.');
  return list;
});

// Work in cents to avoid floating-point surprises (e.g. 23.000000001 rounding up to 24).
const rawTotalCents = computed(() =>
  Math.round((billValue.value + (billValue.value * tipValue.value) / 100) * 100)
);
const totalCents = computed(() =>
  roundUp.value ? Math.ceil(rawTotalCents.value / 100) * 100 : rawTotalCents.value
);

const total = computed(() => totalCents.value / 100);
const tip = computed(() => Math.max(0, total.value - billValue.value));
const perPerson = computed(() => total.value / peopleValue.value);
const effectivePercent = computed(() =>
  billValue.value > 0 ? (tip.value / billValue.value) * 100 : tipValue.value
);

const fmt = (n) => '$' + n.toFixed(2);

function changePeople(delta) {
  people.value = Math.max(1, peopleValue.value + delta);
}

function reset() {
  bill.value = '';
  tipPercent.value = 15;
  people.value = 1;
  roundUp.value = false;
}
</script>

<template>
  <main class="page">
    <section class="card" aria-labelledby="title">
      <header class="head">
        <span class="logo" aria-hidden="true">🧾</span>
        <div>
          <h1 id="title">Tip Calculator</h1>
          <p class="sub">Split the bill fairly, instantly.</p>
        </div>
      </header>

      <div class="layout">
        <form class="inputs" @submit.prevent>
          <div class="field">
            <label for="bill">Bill amount</label>
            <div class="affix">
              <span class="prefix" aria-hidden="true">$</span>
              <input
                id="bill"
                v-model="bill"
                type="number"
                inputmode="decimal"
                min="0"
                step="0.01"
                placeholder="0.00"
                autocomplete="off"
              />
            </div>
          </div>

          <div class="field">
            <label for="tip">Tip percent</label>
            <div class="affix">
              <input
                id="tip"
                v-model="tipPercent"
                type="number"
                inputmode="decimal"
                min="0"
                step="1"
                placeholder="15"
                autocomplete="off"
              />
              <span class="suffix" aria-hidden="true">%</span>
            </div>
            <div class="presets" role="group" aria-label="Quick tip percentages">
              <button
                v-for="p in presets"
                :key="p"
                type="button"
                class="chip"
                :aria-pressed="toNumber(tipPercent) === p"
                @click="tipPercent = p"
              >
                {{ p }}%
              </button>
            </div>
          </div>

          <div class="field">
            <label for="people">People</label>
            <div class="stepper">
              <button
                type="button"
                class="step"
                aria-label="Decrease people"
                :disabled="peopleValue <= 1"
                @click="changePeople(-1)"
              >−</button>
              <input
                id="people"
                v-model="people"
                type="number"
                inputmode="numeric"
                min="1"
                step="1"
                autocomplete="off"
              />
              <button
                type="button"
                class="step"
                aria-label="Increase people"
                @click="changePeople(1)"
              >+</button>
            </div>
          </div>

          <label class="check" for="round-up">
            <input id="round-up" v-model="roundUp" type="checkbox" />
            <span class="box" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </span>
            <span class="check-text">
              <span class="check-label">Round up</span>
              <span class="check-hint">Total rounds up to the next whole dollar</span>
            </span>
          </label>

          <ul v-if="errors.length" class="errors" role="alert">
            <li v-for="e in errors" :key="e">{{ e }}</li>
          </ul>
        </form>

        <section class="results" aria-label="Results" aria-live="polite">
          <div class="row">
            <span class="label">Tip:</span>
            <output for="bill tip round-up" class="value">{{ fmt(tip) }}</output>
          </div>
          <div class="row">
            <span class="label">Total:</span>
            <output for="bill tip round-up" class="value">{{ fmt(total) }}</output>
          </div>
          <div class="row big">
            <span class="label">Per person:</span>
            <output for="bill tip people round-up" class="value">{{ fmt(perPerson) }}</output>
          </div>
          <p class="note" v-if="billValue === 0">Enter a bill amount to get started.</p>
          <p class="note" v-else>
            <template v-if="roundUp">
              Rounded up — effective tip {{ effectivePercent.toFixed(1) }}%,
            </template>
            <template v-else>{{ tipValue }}% tip,</template>
            split {{ peopleValue }} {{ peopleValue === 1 ? 'way' : 'ways' }}.
          </p>
          <button type="button" class="reset" @click="reset">Reset</button>
        </section>
      </div>
    </section>
  </main>
</template>
