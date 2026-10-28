<script setup lang="ts">
import FormFeature from './components/FormFeature.vue';
import SearchFeature from './components/SearchFeature.vue';

const settings = (globalThis as any).__APP_SETTINGS__;
const theme = settings.theme;
</script>

<template>
  <main :data-theme="theme">
    <h1>Movie Tracker</h1>
    <FormFeature />
    <SearchFeature />
  </main>
</template>
