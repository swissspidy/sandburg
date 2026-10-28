<script lang="ts">
  import ModalFeature from './lib/ModalFeature.svelte';
  import FetchFeature from './lib/FetchFeature.svelte';
  import ConverterFeature from './lib/ConverterFeature.svelte';
</script>

<main>
  <h1>Music Tracker</h1>
  <ModalFeature />
  <FetchFeature source="/data/products.json" />
  <ConverterFeature />
</main>
