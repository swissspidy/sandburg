<script setup lang="ts">
import FetchFeature from './components/FetchFeature.vue';
import TodoFeature from './components/TodoFeature.vue';
import SearchFeature from './components/SearchFeature.vue';
import ConverterFeature from './components/ConverterFeature.vue';
</script>

<template>
  <main>
    <h1>Chore Tracker</h1>
    <FetchFeature source="/api/products" />
    <TodoFeature />
    <SearchFeature />
    <ConverterFeature />
  </main>
</template>
