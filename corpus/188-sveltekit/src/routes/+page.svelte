<script lang="ts">
  import ModalFeature from '#lib/components/ModalFeature.svelte';
  import FetchFeature from '#lib/components/FetchFeature.svelte';
</script>

<svelte:head>
  <title>Habit Tracker</title>
</svelte:head>

<main>
  <h1>Habit Tracker</h1>
  <ModalFeature />
  <FetchFeature source="/api/products" />
</main>
