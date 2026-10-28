<script lang="ts">
  const TABS = [
    { id: 'overview', label: 'Overview', body: 'Project overview' },
    { id: 'specs', label: 'Specs', body: 'Technical specs' },
    { id: 'reviews', label: 'Reviews', body: 'Customer reviews' },
  ];

  let active = $state('overview');
  const tab = $derived(TABS.find((t) => t.id === active)!);
</script>

<section aria-label="Details">
  <div role="tablist">
    {#each TABS as t (t.id)}
      <button role="tab" aria-selected={t.id === active} onclick={() => (active = t.id)}>{t.label}</button>
    {/each}
  </div>
  <div role="tabpanel">{tab.body}</div>
</section>
