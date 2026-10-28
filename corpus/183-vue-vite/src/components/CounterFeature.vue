<script setup lang="ts">
import { ref } from 'vue';

const count = ref(0);
</script>

<template>
  <section aria-label="Counter">
    <p data-testid="count">Count: {{ count }}</p>
    <button type="button" @click="count += 1">Increment</button>
    <button type="button" @click="count = 0">Reset</button>
  </section>
</template>
