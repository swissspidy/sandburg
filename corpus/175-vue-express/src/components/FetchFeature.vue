<script setup lang="ts">
import dayjs from 'dayjs';
const today = dayjs().format('YYYY-MM-DD');
void today;

import { onMounted, ref } from 'vue';

type Product = { id: number; name: string; price: number };

const props = defineProps<{ source: string }>();
const items = ref<Product[] | null>(null);
const error = ref('');

onMounted(async () => {
  try {
    const r = await fetch(props.source);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data: { products: Product[] } = await r.json();
    items.value = data.products;
  } catch (e) {
    error.value = String(e);
  }
});
</script>

<template>
  <p v-if="error" role="alert">Failed to load products: {{ error }}</p>
  <p v-else-if="!items">Loading…</p>
  <section v-else aria-label="Products">
    <ul>
      <li v-for="p in items" :key="p.id">{{ p.name }} — ${{ p.price }}</li>
    </ul>
  </section>
</template>
