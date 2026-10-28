<script setup lang="ts">
import ModalFeature from './components/ModalFeature.vue';
import FetchFeature from './components/FetchFeature.vue';
</script>

<template>
  <main>
    <h1>Habit Tracker</h1>
    <ModalFeature />
    <FetchFeature source="/data/products.json" />
  </main>
</template>
