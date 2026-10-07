<script>
  let bill = $state(null);
  let tipPercent = $state(15);
  let people = $state(1);
  let roundUp = $state(false);

  const presets = [10, 15, 18, 20, 25];

  function num(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  let billValue = $derived(num(bill));
  let tipValue = $derived(num(tipPercent));
  let peopleCount = $derived(Math.max(1, Math.floor(num(people)) || 1));

  // Work in whole cents to avoid floating-point drift.
  let billCents = $derived(Math.round(billValue * 100));
  let baseTipCents = $derived(Math.round((billCents * tipValue) / 100));
  let totalCents = $derived.by(() => {
    const raw = billCents + baseTipCents;
    return roundUp ? Math.ceil(raw / 100) * 100 : raw;
  });
  let tipCents = $derived(totalCents - billCents);
  let perPersonCents = $derived(totalCents / peopleCount);

  let effectivePercent = $derived(billCents > 0 ? (tipCents / billCents) * 100 : 0);

  const money = (cents) => `$${(cents / 100).toFixed(2)}`;

  function reset() {
    bill = null;
    tipPercent = 15;
    people = 1;
    roundUp = false;
  }
</script>

<svelte:head>
  <title>Tip Calculator</title>
</svelte:head>

<main>
  <section class="card" aria-labelledby="title">
    <header>
      <span class="logo" aria-hidden="true">🧾</span>
      <div>
        <h1 id="title">Tip Calculator</h1>
        <p class="sub">Split the bill fairly, instantly.</p>
      </div>
    </header>

    <div class="grid">
      <form class="inputs" onsubmit={(e) => e.preventDefault()}>
        <div class="field">
          <label for="bill">Bill amount</label>
          <div class="input-wrap">
            <span class="affix" aria-hidden="true">$</span>
            <input
              id="bill"
              type="number"
              inputmode="decimal"
              min="0"
              step="0.01"
              placeholder="0.00"
              bind:value={bill}
            />
          </div>
        </div>

        <div class="field">
          <label for="tip">Tip percent</label>
          <div class="input-wrap">
            <input
              id="tip"
              type="number"
              inputmode="decimal"
              min="0"
              step="1"
              placeholder="15"
              bind:value={tipPercent}
            />
            <span class="affix right" aria-hidden="true">%</span>
          </div>
          <div class="presets" role="group" aria-label="Quick tip percentages">
            {#each presets as p}
              <button
                type="button"
                class:active={tipValue === p}
                aria-pressed={tipValue === p}
                aria-label={`Set tip to ${p} percent`}
                onclick={() => (tipPercent = p)}>{p}%</button
              >
            {/each}
          </div>
        </div>

        <div class="field">
          <label for="people">People</label>
          <div class="stepper">
            <button
              type="button"
              aria-label="Fewer people"
              onclick={() => (people = Math.max(1, peopleCount - 1))}
              disabled={peopleCount <= 1}>−</button
            >
            <input
              id="people"
              type="number"
              inputmode="numeric"
              min="1"
              step="1"
              bind:value={people}
            />
            <button type="button" aria-label="More people" onclick={() => (people = peopleCount + 1)}
              >+</button
            >
          </div>
        </div>

        <label class="check" for="roundup">
          <input id="roundup" type="checkbox" bind:checked={roundUp} />
          <span class="box" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="12" height="12"
              ><path
                d="M3 8.5l3 3 7-7"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              /></svg
            >
          </span>
          <span class="check-text">
            Round up
            <small>Raise the total to the next whole dollar</small>
          </span>
        </label>
      </form>

      <div class="results" aria-live="polite">
        {#if billCents === 0}
          <p class="hint">Enter a bill amount to see the breakdown.</p>
        {/if}
        <dl>
          <div class="row">
            <dt>
              Tip
              {#if roundUp && billCents > 0}
                <span class="badge">{effectivePercent.toFixed(1)}% after rounding</span>
              {/if}
            </dt>
            <dd>Tip: {money(tipCents)}</dd>
          </div>
          <div class="row">
            <dt>Total</dt>
            <dd>Total: {money(totalCents)}</dd>
          </div>
          <div class="row highlight">
            <dt>Per person</dt>
            <dd>Per person: {money(perPersonCents)}</dd>
          </div>
        </dl>
        <button type="button" class="reset" onclick={reset}>Reset</button>
      </div>
    </div>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(160deg, #ecfdf5 0%, #f0f9ff 100%);
    color: #0f172a;
    min-height: 100vh;
  }
  main {
    display: grid;
    place-items: center;
    padding: 2rem 1rem;
    min-height: 100vh;
    box-sizing: border-box;
  }
  .card {
    width: 100%;
    max-width: 760px;
    background: #fff;
    border-radius: 20px;
    box-shadow: 0 10px 40px rgba(15, 23, 42, 0.08);
    padding: 1.75rem;
    box-sizing: border-box;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    margin-bottom: 1.5rem;
  }
  .logo {
    font-size: 1.8rem;
    background: #d1fae5;
    border-radius: 12px;
    width: 3rem;
    height: 3rem;
    display: grid;
    place-items: center;
  }
  h1 {
    margin: 0;
    font-size: 1.4rem;
  }
  .sub {
    margin: 0.15rem 0 0;
    color: #64748b;
    font-size: 0.92rem;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
  }
  @media (max-width: 640px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
  .inputs {
    display: flex;
    flex-direction: column;
    gap: 1.15rem;
  }
  .field label {
    display: block;
    font-weight: 600;
    font-size: 0.9rem;
    margin-bottom: 0.4rem;
    color: #334155;
  }
  .input-wrap {
    display: flex;
    align-items: center;
    border: 1.5px solid #cbd5e1;
    border-radius: 10px;
    background: #f8fafc;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .input-wrap:focus-within {
    border-color: #059669;
    box-shadow: 0 0 0 3px rgba(5, 150, 105, 0.18);
    background: #fff;
  }
  .affix {
    padding: 0 0.75rem;
    color: #64748b;
    font-weight: 600;
  }
  .input-wrap input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    padding: 0.7rem 0.75rem 0.7rem 0;
    font-size: 1.1rem;
    color: inherit;
    outline: none;
  }
  .input-wrap input:first-child {
    padding-left: 0.75rem;
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.55rem;
  }
  .presets button {
    flex: 1;
    min-width: 3rem;
    padding: 0.45rem 0;
    border-radius: 8px;
    border: 1.5px solid #d1fae5;
    background: #ecfdf5;
    color: #047857;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .presets button:hover {
    background: #d1fae5;
  }
  .presets button.active {
    background: #059669;
    border-color: #059669;
    color: #fff;
  }
  .stepper {
    display: flex;
    border: 1.5px solid #cbd5e1;
    border-radius: 10px;
    overflow: hidden;
    background: #f8fafc;
  }
  .stepper:focus-within {
    border-color: #059669;
    box-shadow: 0 0 0 3px rgba(5, 150, 105, 0.18);
  }
  .stepper button {
    width: 3rem;
    border: none;
    background: #f1f5f9;
    font-size: 1.25rem;
    cursor: pointer;
    color: #0f172a;
  }
  .stepper button:hover:not(:disabled) {
    background: #e2e8f0;
  }
  .stepper button:disabled {
    color: #cbd5e1;
    cursor: not-allowed;
  }
  .stepper input {
    flex: 1;
    min-width: 0;
    text-align: center;
    border: none;
    background: transparent;
    font-size: 1.1rem;
    padding: 0.7rem 0;
    outline: none;
    color: inherit;
  }

  /* Round-up checkbox */
  .check {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 0.7rem;
    padding: 0.75rem 0.85rem;
    border: 1.5px solid #e2e8f0;
    border-radius: 10px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .check:hover {
    border-color: #a7f3d0;
    background: #f0fdf4;
  }
  .check input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
    margin: 0;
  }
  .box {
    flex: none;
    width: 1.2rem;
    height: 1.2rem;
    margin-top: 0.1rem;
    border: 1.5px solid #94a3b8;
    border-radius: 5px;
    display: grid;
    place-items: center;
    color: transparent;
    background: #fff;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .check input:checked + .box {
    background: #059669;
    border-color: #059669;
    color: #fff;
  }
  .check input:focus-visible + .box {
    box-shadow: 0 0 0 3px rgba(5, 150, 105, 0.3);
  }
  .check-text {
    display: flex;
    flex-direction: column;
    font-weight: 600;
    font-size: 0.92rem;
    color: #334155;
  }
  .check-text small {
    font-weight: 400;
    font-size: 0.8rem;
    color: #64748b;
    margin-top: 0.1rem;
  }

  button:focus-visible {
    outline: 3px solid rgba(5, 150, 105, 0.45);
    outline-offset: 2px;
  }
  .results {
    background: #064e3b;
    color: #ecfdf5;
    border-radius: 16px;
    padding: 1.4rem;
    display: flex;
    flex-direction: column;
  }
  .hint {
    margin: 0 0 1rem;
    font-size: 0.88rem;
    color: #a7f3d0;
  }
  dl {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    flex: 1;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding-bottom: 0.8rem;
    border-bottom: 1px solid rgba(167, 243, 208, 0.18);
  }
  .row:last-child {
    border-bottom: none;
  }
  dt {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6ee7b7;
  }
  .badge {
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.72rem;
    background: rgba(110, 231, 183, 0.15);
    color: #a7f3d0;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
  }
  dd {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .highlight dd {
    font-size: 1.6rem;
    color: #fff;
  }
  .reset {
    margin-top: 1rem;
    padding: 0.7rem;
    border-radius: 10px;
    border: none;
    background: #10b981;
    color: #052e1f;
    font-weight: 700;
    font-size: 0.95rem;
    cursor: pointer;
    transition: background 0.15s;
  }
  .reset:hover {
    background: #34d399;
  }
  input[type='number']::-webkit-inner-spin-button,
  input[type='number']::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  input[type='number'] {
    -moz-appearance: textfield;
    appearance: textfield;
  }
</style>
