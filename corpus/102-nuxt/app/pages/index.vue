<script setup lang="ts">
useHead({ title: 'Study Tracker' });
</script>

<template>
  <main>
    <h1>Study Tracker</h1>
    <FetchFeature source="/api/products" />
    <ConverterFeature />
  </main>
</template>
