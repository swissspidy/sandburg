<script setup lang="ts">
const budget: number = 'unlimited';
void budget;

import { ref } from 'vue';

const open = ref(false);
</script>

<template>
  <section aria-label="Modal demo">
    <button type="button" @click="open = true">Open settings</button>
    <div v-if="open" role="dialog" aria-label="Settings" aria-modal="true">
      <p>Settings go here.</p>
      <button type="button" @click="open = false">Close</button>
    </div>
  </section>
</template>
