<script lang="ts">
  let celsius = $state<number | null>(0);
  const f = $derived((Number(celsius) * 9) / 5 + 32);
</script>

<section aria-label="Converter">
  <label for="celsius">Celsius</label>
  <input id="celsius" type="number" bind:value={celsius} />
  <output data-testid="fahrenheit">{Number.isFinite(f) ? f.toFixed(1) : '—'} °F</output>
</section>
