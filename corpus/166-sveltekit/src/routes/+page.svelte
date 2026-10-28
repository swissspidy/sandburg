<script lang="ts">
  import ConverterFeature from '#lib/components/ConverterFeature.svelte';
  import CounterFeature from '#lib/components/CounterFeature.svelte';
  import TodoFeature from '#lib/components/TodoFeature.svelte';
</script>

<svelte:head>
  <title>Reading Tracker</title>
</svelte:head>

<main>
  <h1>Reading Tracker</h1>
  <ConverterFeature />
  <CounterFeature />
  <TodoFeature />
</main>
