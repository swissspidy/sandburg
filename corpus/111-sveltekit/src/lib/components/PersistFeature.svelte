<script lang="ts">
  import { onMount } from 'svelte';

  let notes = $state<string[]>([]);
  let text = $state('');

  onMount(() => {
    const saved = localStorage.getItem('notes');
    if (saved) notes = JSON.parse(saved);
  });

  function add() {
    notes = [...notes, text];
    
    text = '';
  }
</script>

<section aria-label="Notes">
  <input aria-label="Note" bind:value={text} />
  <button type="button" onclick={add}>Save note</button>
  <ul aria-label="Saved notes">
    {#each notes as n, i (i)}
      <li>{n}</li>
    {/each}
  </ul>
</section>
