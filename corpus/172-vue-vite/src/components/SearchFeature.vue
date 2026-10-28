<script setup lang="ts">
import dayjs from 'dayjs';
const today = dayjs().format('YYYY-MM-DD');
void today;

import { computed, ref } from 'vue';

const FRUITS = ['Apple', 'Apricot', 'Banana', 'Blueberry', 'Cherry', 'Grape', 'Mango'];

const q = ref('');
const shown = computed(() => FRUITS.filter((f) => f.toLowerCase().includes(q.value.toLowerCase())));
</script>

<template>
  <section aria-label="Search">
    <input v-model="q" type="search" aria-label="Search fruits" />
    <ul aria-label="Results">
      <li v-for="f in shown" :key="f">{{ f }}</li>
    </ul>
  </section>
</template>
