<script setup lang="ts">
import FetchFeature from './components/FetchFeature.vue';
import ConverterFeature from './components/ConverterFeature.vue';
</script>

<template>
  <main>
    <h1>Study Tracker</h1>
    <FetchFeature source="/api/products" />
    <ConverterFeature />
  </main>
</template>
