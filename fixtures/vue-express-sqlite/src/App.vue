<script setup>
import { computed, onMounted, ref } from 'vue';
import NoteItem from './components/NoteItem.vue';

const notes = ref([]);
const draft = ref('');
const error = ref('');
const pinnedCount = computed(() => notes.value.filter((n) => n.pinned).length);

async function load() {
  const res = await fetch('/api/notes');
  notes.value = await res.json();
}

async function add() {
  error.value = '';
  const res = await fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: draft.value }),
  });
  if (!res.ok) {
    error.value = (await res.json()).error;
    return;
  }
  draft.value = '';
  await load();
}

async function pin(id) {
  await fetch(`/api/notes/${id}/pin`, { method: 'PATCH' });
  await load();
}

async function remove(id) {
  await fetch(`/api/notes/${id}`, { method: 'DELETE' });
  await load();
}

onMounted(load);
</script>

<template>
  <main>
    <h1>Notes</h1>
    <form @submit.prevent="add">
      <label for="draft">New note</label>
      <input id="draft" v-model="draft" placeholder="Write something" />
      <button type="submit">Add</button>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
    <p role="status">{{ notes.length }} notes, {{ pinnedCount }} pinned</p>
    <ul>
      <NoteItem v-for="note in notes" :key="note.id" :note="note" @pin="pin" @remove="remove" />
    </ul>
  </main>
</template>

<style>
main {
  max-width: 36rem;
  margin: 0 auto;
  padding: 1.5rem;
}
ul {
  list-style: none;
  padding: 0;
}
</style>
