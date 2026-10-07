<script setup>
const { data: entries, refresh } = await useFetch('/api/entries', { default: () => [] });

const name = ref('');
const message = ref('');
const error = ref('');
const submitting = ref(false);
const messageInput = ref(null);
const liking = ref(new Set());

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

function likesLabel(n) {
  const count = Number(n) || 0;
  return `${count} ${count === 1 ? 'like' : 'likes'}`;
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

async function like(entry) {
  if (liking.value.has(entry.id)) return;
  liking.value = new Set(liking.value).add(entry.id);
  const previous = entry.likes || 0;
  entry.likes = previous + 1;
  try {
    const res = await $fetch(`/api/entries/${entry.id}/like`, { method: 'POST' });
    entry.likes = res.likes;
  } catch {
    entry.likes = previous;
  } finally {
    const next = new Set(liking.value);
    next.delete(entry.id);
    liking.value = next;
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
        <button type="submit" class="primary" :disabled="submitting">{{ submitting ? 'Signing…' : 'Sign' }}</button>
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
            <div class="like-row">
              <button
                type="button"
                class="like"
                :aria-label="`Like ${entry.name}'s message`"
                :disabled="liking.has(entry.id)"
                @click="like(entry)"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    d="M12 21s-7.5-4.6-9.6-9.2C1 8.6 3 5 6.6 5c2 0 3.4 1.1 4.4 2.5C12 6.1 13.4 5 15.4 5 19 5 21 8.6 19.6 11.8 17.5 16.4 12 21 12 21z"
                    fill="currentColor"
                  />
                </svg>
                <span aria-hidden="true">Like</span>
              </button>
              <span class="likes" aria-live="polite">{{ likesLabel(entry.likes) }}</span>
            </div>
          </div>
        </li>
      </ul>
      <p v-if="!entries.length" class="empty">No entries yet. Be the first to sign! ✍️</p>
    </section>
  </main>
</template>
