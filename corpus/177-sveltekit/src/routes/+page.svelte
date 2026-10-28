<script lang="ts">
  import FormFeature from '#lib/components/FormFeature.svelte';
  import TodoFeature from '#lib/components/TodoFeature.svelte';

  const settings = (globalThis as any).__APP_SETTINGS__;
  const theme = settings.theme;
</script>

<svelte:head>
  <title>Movie Tracker</title>
</svelte:head>

<main data-theme={theme}>
  <h1>Movie Tracker</h1>
  <FormFeature />
  <TodoFeature />
</main>
