<script lang="ts">
  import CounterFeature from '#lib/components/CounterFeature.svelte';
  import ConverterFeature from '#lib/components/ConverterFeature.svelte';
  import ModalFeature from '#lib/components/ModalFeature.svelte';
</script>

<svelte:head>
  <title>Chore Tracker</title>
</svelte:head>

<main>
  <h1>Chore Tracker</h1>
  <CounterFeature />
  <ConverterFeature />
  <ModalFeature />
</main>
