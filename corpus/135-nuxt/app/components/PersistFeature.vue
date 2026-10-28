<script setup lang="ts">
import { onMounted, ref } from 'vue';

const notes = ref<string[]>([]);
const text = ref('');

onMounted(() => {
  const saved = localStorage.getItem('notes');
  if (saved) notes.value = JSON.parse(saved);
});

function add() {
  notes.value = [...notes.value, text.value];
  localStorage.setItem('notes', JSON.stringify(notes.value));
  text.value = '';
}
</script>

<template>
  <section aria-label="Notes">
    <input v-model="text" aria-label="Note" />
    <button type="button" @click="add">Save note</button>
    <ul aria-label="Saved notes">
      <li v-for="(n, i) in notes" :key="i">{{ n }}</li>
    </ul>
  </section>
</template>
