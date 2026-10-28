<script lang="ts">
  let count = $state(0);
</script>

<section aria-label="Counter">
  <p data-testid="count">Count: {count}</p>
  <button type="button" onclick={() => (count += 1)}>Increment</button>
  <button type="button" onclick={() => (count = 0)}>Reset</button>
</section>
