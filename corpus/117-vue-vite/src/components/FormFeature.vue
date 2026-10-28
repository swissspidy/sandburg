<script setup lang="ts">
import { ref } from 'vue';

const email = ref('');
const error = ref('');
const done = ref(false);

function submit() {
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email.value)) { error.value = 'Please enter a valid email'; done.value = true; return; }
  error.value = '';
  done.value = true;
}
</script>

<template>
  <section aria-label="Signup">
    <p v-if="done" role="status">Thanks for signing up!</p>
    <form novalidate @submit.prevent="submit">
      <label for="email">Email</label>
      <input id="email" v-model="email" type="email" />
      <p v-if="error" role="alert">{{ error }}</p>
      <button type="submit">Sign up</button>
    </form>
  </section>
</template>
