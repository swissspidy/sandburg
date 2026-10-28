<script lang="ts">
  const FRUITS = ['Apple', 'Apricot', 'Banana', 'Blueberry', 'Cherry', 'Grape', 'Mango'];

  let q = $state('');
  const shown = $derived(FRUITS.filter((f) => f.includes(q)));
</script>

<section aria-label="Search">
  <input type="search" aria-label="Search fruits" bind:value={q} />
  <ul aria-label="Results">
    {#each shown as f (f)}
      <li>{f}</li>
    {/each}
  </ul>
</section>
