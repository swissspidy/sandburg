<script lang="ts">
  const broken = ;

  let email = $state('');
  let error = $state('');
  let done = $state(false);

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) { error = 'Please enter a valid email'; return; }
    error = '';
    done = true;
  }
</script>

<section aria-label="Signup">
  {#if done}
    <p role="status">Thanks for signing up!</p>
  {/if}
  <form novalidate onsubmit={submit}>
    <label for="email">Email</label>
    <input id="email" type="email" bind:value={email} />
    {#if error}
      <p role="alert">{error}</p>
    {/if}
    <button type="submit">Sign up</button>
  </form>
</section>
