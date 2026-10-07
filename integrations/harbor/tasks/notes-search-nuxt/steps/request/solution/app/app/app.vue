<script setup>
const { data: notes, refresh } = await useFetch('/api/notes', { default: () => [] });

const title = ref('');
const body = ref('');
const search = ref('');
const saving = ref(false);
const error = ref('');

const canSave = computed(() => (title.value.trim() || body.value.trim()) && !saving.value);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return notes.value;
  return notes.value.filter(
    (n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)
  );
});

async function save() {
  if (!title.value.trim() && !body.value.trim()) {
    error.value = 'Write a title or a body first.';
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    const note = await $fetch('/api/notes', {
      method: 'POST',
      body: { title: title.value, body: body.value },
    });
    notes.value = [note, ...notes.value];
    title.value = '';
    body.value = '';
  } catch (e) {
    error.value = e?.data?.statusMessage || 'Could not save the note.';
  } finally {
    saving.value = false;
  }
}

async function remove(note) {
  const prev = notes.value;
  notes.value = notes.value.filter((n) => n.id !== note.id);
  try {
    await $fetch(`/api/notes/${note.id}`, { method: 'DELETE' });
  } catch {
    notes.value = prev;
    await refresh();
  }
}

function formatDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
</script>

<template>
  <div class="page">
    <header class="top">
      <h1><span aria-hidden="true">🗒️</span> Notes</h1>
      <p class="sub">Jot things down. Find them again.</p>
    </header>

    <main class="layout">
      <section class="card" aria-labelledby="new-heading">
        <h2 id="new-heading">New note</h2>
        <form @submit.prevent="save" novalidate>
          <div class="field">
            <label for="note-title">Title</label>
            <input id="note-title" v-model="title" type="text" maxlength="200" placeholder="Groceries" autocomplete="off" />
          </div>
          <div class="field">
            <label for="note-body">Body</label>
            <textarea id="note-body" v-model="body" rows="5" placeholder="Milk, eggs, coffee…"></textarea>
          </div>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <button type="submit" class="primary" :disabled="!canSave">
            {{ saving ? 'Saving…' : 'Save note' }}
          </button>
        </form>
      </section>

      <section class="list-section" aria-labelledby="notes-heading">
        <div class="list-head">
          <h2 id="notes-heading">Notes <span class="count">{{ filtered.length }}</span></h2>
          <div class="field search">
            <label for="note-search">Search</label>
            <input id="note-search" v-model="search" type="search" placeholder="Filter by title or body" autocomplete="off" />
          </div>
        </div>

        <ul class="notes" aria-label="Notes">
          <li v-for="note in filtered" :key="note.id" class="note">
            <div class="note-main">
              <h3 class="note-title">{{ note.title || 'Untitled' }}</h3>
              <p v-if="note.body" class="note-body">{{ note.body }}</p>
              <time class="note-date" :datetime="note.created_at">{{ formatDate(note.created_at) }}</time>
            </div>
            <button
              type="button"
              class="icon-btn"
              :aria-label="`Delete note ${note.title || 'Untitled'}`"
              title="Delete"
              @click="remove(note)"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
              </svg>
            </button>
          </li>
        </ul>

        <div v-if="!filtered.length" class="empty">
          <p v-if="!notes.length">No notes yet. Write your first one on the left.</p>
          <p v-else>No notes match “{{ search }}”.</p>
        </div>
      </section>
    </main>
  </div>
</template>
