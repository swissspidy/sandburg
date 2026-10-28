<script lang="ts">
  import ModalFeature from '#lib/components/ModalFeature.svelte';
  import CounterFeature from '#lib/components/CounterFeature.svelte';
  import ConverterFeature from '#lib/components/ConverterFeature.svelte';
</script>

<svelte:head>
  <title>Chore Tracker</title>
</svelte:head>

<main>
  <h1>Chore Tracker</h1>
  <ModalFeature />
  <CounterFeature />
  <ConverterFeature />
</main>
