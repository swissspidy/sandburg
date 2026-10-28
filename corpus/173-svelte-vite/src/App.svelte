<script lang="ts">
  import TabsFeature from './lib/TabsFeature.svelte';
  import ConverterFeature from './lib/ConverterFeature.svelte';
  import SearchFeature from './lib/SearchFeature.svelte';
  import PersistFeature from './lib/PersistFeature.svelte';

  const settings = (globalThis as any).__APP_SETTINGS__;
  const theme = settings.theme;
</script>

<main data-theme={theme}>
  <h1>Garden Tracker</h1>
  <TabsFeature />
  <ConverterFeature />
  <SearchFeature />
  <PersistFeature />
</main>
