<script lang="ts">
  import CounterFeature from '#lib/components/CounterFeature.svelte';
  import FetchFeature from '#lib/components/FetchFeature.svelte';
</script>

<svelte:head>
  <title>Recipe Tracker</title>
</svelte:head>

<main>
  <h1>Recipe Tracker</h1>
  <CounterFeature />
  <FetchFeature source="/api/products" />
</main>
