<script lang="ts">
  import FetchFeature from '#lib/components/FetchFeature.svelte';
  import ConverterFeature from '#lib/components/ConverterFeature.svelte';
  import CounterFeature from '#lib/components/CounterFeature.svelte';
  import FormFeature from '#lib/components/FormFeature.svelte';
</script>

<svelte:head>
  <title>Chore Tracker</title>
</svelte:head>

<main>
  <h1>Chore Tracker</h1>
  <FetchFeature source="/api/products" />
  <ConverterFeature />
  <CounterFeature />
  <FormFeature />
</main>
