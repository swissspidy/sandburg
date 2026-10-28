<script lang="ts">
  import TabsFeature from '#lib/components/TabsFeature.svelte';
  import CounterFeature from '#lib/components/CounterFeature.svelte';
  import FormFeature from '#lib/components/FormFeature.svelte';
</script>

<svelte:head>
  <title>Study Tracker</title>
</svelte:head>

<main>
  <h1>Study Tracker</h1>
  <TabsFeature />
  <CounterFeature />
  <FormFeature />
</main>
