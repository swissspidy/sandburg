<script lang="ts">
  import DatesFeature from '#lib/components/DatesFeature.svelte';
  import SearchFeature from '#lib/components/SearchFeature.svelte';
  import PersistFeature from '#lib/components/PersistFeature.svelte';
  import FetchFeature from '#lib/components/FetchFeature.svelte';
</script>

<svelte:head>
  <title>Study Tracker</title>
</svelte:head>

<main>
  <h1>Study Tracker</h1>
  <DatesFeature />
  <SearchFeature />
  <PersistFeature />
  <FetchFeature source="/api/products" />
</main>
