<script setup lang="ts">
import { computed, ref } from 'vue';

const celsius = ref<number | string>(0);
const fahrenheit = computed(() => {
  const f = (Number(celsius.value) * 9) / 5 + 32;
  return Number.isFinite(f) ? f.toFixed(1) : '—';
});
</script>

<template>
  <section aria-label="Converter">
    <label for="celsius">Celsius</label>
    <input id="celsius" v-model="celsius" type="number" />
    <output data-testid="fahrenheit">{{ fahrenheit }} °F</output>
  </section>
</template>
