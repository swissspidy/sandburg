<script lang="ts">
  import SearchFeature from './lib/SearchFeature.svelte';
  import FetchFeature from './lib/FetchFeature.svelte';
</script>

<main>
  <h1>Chore Tracker</h1>
  <SearchFeature />
  <FetchFeature source="/data/products.json" />
</main>
