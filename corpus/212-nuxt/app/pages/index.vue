<script setup lang="ts">
useHead({ title: 'Garden Tracker' });

const settings = (globalThis as any).__APP_SETTINGS__;
const theme = settings.theme;
</script>

<template>
  <main :data-theme="theme">
    <h1>Garden Tracker</h1>
    <TabsFeature />
    <PersistFeature />
    <DatesFeature />
    <CounterFeature />
  </main>
</template>
