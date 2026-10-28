<script setup lang="ts">
const broken = ;

import { computed, ref } from 'vue';

const TABS = [
  { id: 'overview', label: 'Overview', body: 'Project overview' },
  { id: 'specs', label: 'Specs', body: 'Technical specs' },
  { id: 'reviews', label: 'Reviews', body: 'Customer reviews' },
];

const active = ref('overview');
const tab = computed(() => TABS.find((t) => t.id === active.value)!);
</script>

<template>
  <section aria-label="Details">
    <div role="tablist">
      <button v-for="t in TABS" :key="t.id" role="tab" :aria-selected="t.id === active" @click="active = t.id">{{ t.label }}</button>
    </div>
    <div role="tabpanel">{{ tab.body }}</div>
  </section>
</template>
