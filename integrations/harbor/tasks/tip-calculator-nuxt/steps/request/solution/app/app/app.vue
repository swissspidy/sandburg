<script setup>
useHead({
  title: 'Tip Calculator',
  htmlAttrs: { lang: 'en' },
});

const bill = ref('');
const tipPercent = ref(15);
const people = ref(1);

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

const tip = computed(() => (billValue.value * tipValue.value) / 100);
const total = computed(() => billValue.value + tip.value);
const perPerson = computed(() => total.value / peopleValue.value);

const fmt = (n) => '$' + n.toFixed(2);

function changePeople(delta) {
  people.value = Math.max(1, peopleValue.value + delta);
}

function reset() {
  bill.value = '';
  tipPercent.value = 15;
  people.value = 1;
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

          <ul v-if="errors.length" class="errors" role="alert">
            <li v-for="e in errors" :key="e">{{ e }}</li>
          </ul>
        </form>

        <section class="results" aria-label="Results" aria-live="polite">
          <div class="row">
            <span class="label">Tip:</span>
            <output for="bill tip" class="value">{{ fmt(tip) }}</output>
          </div>
          <div class="row">
            <span class="label">Total:</span>
            <output for="bill tip" class="value">{{ fmt(total) }}</output>
          </div>
          <div class="row big">
            <span class="label">Per person:</span>
            <output for="bill tip people" class="value">{{ fmt(perPerson) }}</output>
          </div>
          <p class="note" v-if="billValue === 0">Enter a bill amount to get started.</p>
          <p class="note" v-else>
            {{ tipValue }}% tip, split {{ peopleValue }} {{ peopleValue === 1 ? 'way' : 'ways' }}.
          </p>
          <button type="button" class="reset" @click="reset">Reset</button>
        </section>
      </div>
    </section>
  </main>
</template>
