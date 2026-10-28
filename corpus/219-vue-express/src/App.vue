<script setup lang="ts">
import FetchFeature from './components/FetchFeature.vue';
import SearchFeature from './components/SearchFeature.vue';
import FormFeature from './components/FormFeature.vue';
import TodoFeature from './components/TodoFeature.vue';

const settings = (globalThis as any).__APP_SETTINGS__;
const theme = settings.theme;
</script>

<template>
  <main :data-theme="theme">
    <h1>Habit Tracker</h1>
    <FetchFeature source="/api/products" />
    <SearchFeature />
    <FormFeature />
    <TodoFeature />
  </main>
</template>
