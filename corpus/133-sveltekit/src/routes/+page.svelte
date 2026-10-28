<script lang="ts">
  import ModalFeature from '#lib/components/ModalFeature.svelte';
  import DatesFeature from '#lib/components/DatesFeature.svelte';
  import ConverterFeature from '#lib/components/ConverterFeature.svelte';
</script>

<svelte:head>
  <title>Travel Tracker</title>
</svelte:head>

<main>
  <h1>Travel Tracker</h1>
  <ModalFeature />
  <DatesFeature />
  <ConverterFeature />
</main>
