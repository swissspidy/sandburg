<script setup lang="ts">
import FetchFeature from './components/FetchFeature.vue';
import FormFeature from './components/FormFeature.vue';
</script>

<template>
  <main>
    <h1>Workout Tracker</h1>
    <FetchFeature source="/api/products" />
    <FormFeature />
  </main>
</template>
