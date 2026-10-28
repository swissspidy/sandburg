<script lang="ts">
  import DatesFeature from './lib/DatesFeature.svelte';
  import TodoFeature from './lib/TodoFeature.svelte';
  import FetchFeature from './lib/FetchFeature.svelte';
</script>

<main>
  <h1>Garden Tracker</h1>
  <DatesFeature />
  <TodoFeature />
  <FetchFeature source="/data/products.json" />
</main>
