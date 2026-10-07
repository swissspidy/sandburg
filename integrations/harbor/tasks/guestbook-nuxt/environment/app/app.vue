<script setup>
const { data: health } = await useFetch('/api/health');
</script>

<template>
  <main>
    <h1>Hello</h1>
    <p v-if="health">SQLite {{ health.sqlite }}</p>
  </main>
</template>
