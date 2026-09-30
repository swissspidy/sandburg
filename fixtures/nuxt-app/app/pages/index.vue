<script setup lang="ts">
const { data } = await useFetch('/api/hello');
const count = ref(0);
useHead({ title: 'Welcome to Nuxt' });
</script>

<template>
  <div>
    <h1>Welcome to Nuxt</h1>
    <p>{{ data?.message }}</p>
    <button type="button" @click="count++">Clicked {{ count }} times</button>
  </div>
</template>
