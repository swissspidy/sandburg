<script setup lang="ts">
import ModalFeature from './components/ModalFeature.vue';
import SearchFeature from './components/SearchFeature.vue';
import FetchFeature from './components/FetchFeature.vue';
</script>

<template>
  <main>
    <h1>Chore Tracker</h1>
    <ModalFeature />
    <SearchFeature />
    <FetchFeature source="/data/products.json" />
  </main>
</template>
