<script setup>
const { data: entries, refresh } = await useFetch('/api/entries', { default: () => [] });

const name = ref('');
const message = ref('');
const error = ref('');
const submitting = ref(false);
const messageInput = ref(null);

const dateFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});
function formatDate(iso) {
  try {
    return dateFormat.format(new Date(iso)) + ' UTC';
  } catch {
    return '';
  }
}

async function sign() {
  error.value = '';
  if (!message.value.trim()) {
    error.value = 'Please write a message before signing.';
    messageInput.value?.focus();
    return;
  }
  submitting.value = true;
  try {
    const entry = await $fetch('/api/entries', {
      method: 'POST',
      body: { name: name.value, message: message.value },
    });
    entries.value = [entry, ...(entries.value || [])];
    message.value = '';
    refresh();
  } catch (e) {
    error.value = e?.data?.statusMessage || e?.statusMessage || 'Could not sign the guestbook. Please try again.';
  } finally {
    submitting.value = false;
  }
}

function initial(n) {
  return (n || '?').trim().charAt(0).toUpperCase() || '?';
}
</script>

<template>
  <main class="page">
    <header class="hero">
      <span class="logo" aria-hidden="true">📖</span>
      <div>
        <h1>Guestbook</h1>
        <p class="sub">Leave a note for everyone who comes by.</p>
      </div>
    </header>

    <form class="card form" novalidate @submit.prevent="sign">
      <div class="field">
        <label for="gb-name">Name</label>
        <input id="gb-name" v-model="name" type="text" maxlength="100" autocomplete="name" placeholder="Your name (optional)" />
      </div>
      <div class="field">
        <label for="gb-message">Message</label>
        <textarea
          id="gb-message"
          ref="messageInput"
          v-model="message"
          rows="4"
          maxlength="2000"
          placeholder="Say hello…"
          :aria-invalid="error ? 'true' : 'false'"
          :aria-describedby="error ? 'gb-error' : undefined"
          @input="error = ''"
        ></textarea>
      </div>
      <p v-if="error" id="gb-error" class="error" role="alert">{{ error }}</p>
      <div class="actions">
        <button type="submit" :disabled="submitting">{{ submitting ? 'Signing…' : 'Sign' }}</button>
      </div>
    </form>

    <section class="entries" aria-labelledby="entries-heading">
      <h2 id="entries-heading">Entries <span class="count">{{ entries.length }}</span></h2>
      <ul class="list" aria-labelledby="entries-heading">
        <li v-for="entry in entries" :key="entry.id" class="card entry">
          <span class="avatar" aria-hidden="true">{{ initial(entry.name) }}</span>
          <div class="body">
            <div class="meta">
              <strong class="name">{{ entry.name }}</strong>
              <time :datetime="entry.created_at">{{ formatDate(entry.created_at) }}</time>
            </div>
            <p class="message">{{ entry.message }}</p>
          </div>
        </li>
      </ul>
      <p v-if="!entries.length" class="empty">No entries yet. Be the first to sign! ✍️</p>
    </section>
  </main>
</template>
