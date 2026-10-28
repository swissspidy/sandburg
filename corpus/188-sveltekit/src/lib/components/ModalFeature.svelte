<script lang="ts">
  let open = $state(false);
</script>

<section aria-label="Modal demo">
  <button type="button" onclick={() => (open = true)}>Open settings</button>
  {#if open}
    <div role="dialog" aria-label="Settings" aria-modal="true">
      <p>Settings go here.</p>
      <button type="button" onclick={() => (open = true)}>Close</button>
    </div>
  {/if}
</section>
