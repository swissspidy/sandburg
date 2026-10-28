<script setup lang="ts">
import FetchFeature from './components/FetchFeature.vue';
import TodoFeature from './components/TodoFeature.vue';
import ModalFeature from './components/ModalFeature.vue';
</script>

<template>
  <main>
    <h1>Music Tracker</h1>
    <FetchFeature source="/api/products" />
    <TodoFeature />
    <ModalFeature />
  </main>
</template>
