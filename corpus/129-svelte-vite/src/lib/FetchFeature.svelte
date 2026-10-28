<script lang="ts">
  import { onMount } from 'svelte';

  type Product = { id: number; name: string; price: number };

  let { source }: { source: string } = $props();
  let items = $state<Product[] | null>(null);
  let error = $state('');

  onMount(() => {
    fetch(source)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((data: { products: Product[] }) => (items = data.products))
      .catch((e) => (error = String(e)));
  });
</script>

{#if error}
  <p role="alert">Failed to load products: {error}</p>
{:else if !items}
  <p>Loading…</p>
{:else}
  <section aria-label="Products">
    <ul>
      {#each items as p (p.id)}
        <li>{p.name} — ${p.price}</li>
      {/each}
    </ul>
  </section>
{/if}
