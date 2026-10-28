<script setup lang="ts">
import FetchFeature from './components/FetchFeature.vue';
import TodoFeature from './components/TodoFeature.vue';
import ConverterFeature from './components/ConverterFeature.vue';
import SearchFeature from './components/SearchFeature.vue';
</script>

<template>
  <main>
    <h1>Habit Tracker</h1>
    <FetchFeature source="/api/products" />
    <TodoFeature />
    <ConverterFeature />
    <SearchFeature />
  </main>
</template>
