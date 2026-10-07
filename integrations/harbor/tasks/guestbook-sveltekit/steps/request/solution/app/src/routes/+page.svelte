<script>
  import { enhance } from '$app/forms';

  let { data, form } = $props();
  let submitting = $state(false);

  function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function initial(name) {
    return (name || '?').trim().charAt(0).toUpperCase() || '?';
  }
</script>

<svelte:head>
  <title>Guestbook</title>
</svelte:head>

<main>
  <header>
    <h1>📖 Guestbook</h1>
    <p class="sub">Leave a note for everyone who passes by.</p>
  </header>

  <section class="card" aria-labelledby="sign-heading">
    <h2 id="sign-heading">Sign the guestbook</h2>
    <form
      method="POST"
      novalidate
      use:enhance={() => {
        submitting = true;
        return async ({ update }) => {
          await update();
          submitting = false;
        };
      }}
    >
      <div class="field">
        <label for="name">Name</label>
        <input
          id="name"
          name="name"
          type="text"
          maxlength="60"
          autocomplete="name"
          placeholder="Your name"
          value={form?.name ?? ''}
        />
      </div>
      <div class="field">
        <label for="message">Message</label>
        <textarea
          id="message"
          name="message"
          rows="4"
          maxlength="500"
          placeholder="Say something nice…"
          aria-invalid={form?.error ? 'true' : undefined}
          aria-describedby={form?.error ? 'form-error' : undefined}
        >{form?.message ?? ''}</textarea>
      </div>

      {#if form?.error}
        <p id="form-error" class="error" role="alert">{form.error}</p>
      {/if}

      <div class="actions">
        <button type="submit" disabled={submitting}>{submitting ? 'Signing…' : 'Sign'}</button>
      </div>
    </form>
  </section>

  <section aria-labelledby="entries-heading">
    <h2 id="entries-heading" class="list-title">
      Entries <span class="count">{data.entries.length}</span>
    </h2>
    <ul class="entries" aria-labelledby="entries-heading">
      {#each data.entries as entry (entry.id)}
        <li class="entry">
          <div class="avatar" aria-hidden="true">{initial(entry.name)}</div>
          <div class="body">
            <div class="meta">
              <strong class="name">{entry.name}</strong>
              <time datetime={entry.created_at}>{formatDate(entry.created_at)}</time>
            </div>
            <p class="message">{entry.message}</p>
          </div>
        </li>
      {/each}
    </ul>
    {#if data.entries.length === 0}
      <div class="empty">
        <span aria-hidden="true">✍️</span>
        <p>No entries yet. Be the first to sign!</p>
      </div>
    {/if}
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: #f6f3ee;
    color: #2b2620;
    line-height: 1.5;
  }

  main {
    max-width: 640px;
    margin: 0 auto;
    padding: 2.5rem 1.25rem 4rem;
  }

  header {
    margin-bottom: 1.75rem;
  }

  h1 {
    margin: 0;
    font-size: 2rem;
    letter-spacing: -0.02em;
  }

  .sub {
    margin: 0.25rem 0 0;
    color: #6f6457;
  }

  h2 {
    font-size: 1.1rem;
    margin: 0 0 1rem;
  }

  .card {
    background: #fff;
    border: 1px solid #e7e0d5;
    border-radius: 14px;
    padding: 1.25rem;
    box-shadow: 0 1px 3px rgba(60, 40, 20, 0.06);
    margin-bottom: 2rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-bottom: 0.9rem;
  }

  label {
    font-weight: 600;
    font-size: 0.9rem;
  }

  input,
  textarea {
    font: inherit;
    padding: 0.6rem 0.75rem;
    border: 1px solid #d8cfc2;
    border-radius: 8px;
    background: #fdfcfa;
    color: inherit;
    resize: vertical;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  input:hover,
  textarea:hover {
    border-color: #bfb3a3;
  }

  input:focus,
  textarea:focus {
    outline: none;
    border-color: #b5562b;
    box-shadow: 0 0 0 3px rgba(181, 86, 43, 0.2);
  }

  textarea[aria-invalid='true'] {
    border-color: #c0392b;
  }

  .error {
    margin: 0 0 0.9rem;
    padding: 0.6rem 0.75rem;
    border-radius: 8px;
    background: #fdecea;
    color: #9b2c1f;
    border: 1px solid #f5c2bc;
    font-size: 0.9rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }

  button {
    font: inherit;
    font-weight: 600;
    padding: 0.6rem 1.6rem;
    border: none;
    border-radius: 8px;
    background: #b5562b;
    color: #fff;
    cursor: pointer;
    transition: background 0.15s, transform 0.05s;
  }

  button:hover:not(:disabled) {
    background: #9a4622;
  }

  button:active:not(:disabled) {
    transform: translateY(1px);
  }

  button:focus-visible {
    outline: 3px solid rgba(181, 86, 43, 0.4);
    outline-offset: 2px;
  }

  button:disabled {
    opacity: 0.7;
    cursor: wait;
  }

  .list-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .count {
    font-size: 0.8rem;
    font-weight: 600;
    background: #eadfd1;
    color: #6f5a44;
    padding: 0.05rem 0.55rem;
    border-radius: 999px;
  }

  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .entry {
    display: flex;
    gap: 0.85rem;
    background: #fff;
    border: 1px solid #e7e0d5;
    border-radius: 12px;
    padding: 0.9rem 1rem;
    transition: border-color 0.15s;
  }

  .entry:hover {
    border-color: #d3c5b2;
  }

  .avatar {
    flex: none;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    background: #f1dccd;
    color: #8a3f1d;
    display: grid;
    place-items: center;
    font-weight: 700;
  }

  .body {
    min-width: 0;
    flex: 1;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.6rem;
  }

  .name {
    overflow-wrap: anywhere;
  }

  time {
    font-size: 0.8rem;
    color: #8a7e70;
  }

  .message {
    margin: 0.25rem 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .empty {
    text-align: center;
    padding: 2rem 1rem;
    border: 2px dashed #e0d6c8;
    border-radius: 12px;
    color: #7a6e60;
  }

  .empty span {
    font-size: 1.75rem;
  }

  .empty p {
    margin: 0.4rem 0 0;
  }

  @media (max-width: 480px) {
    main {
      padding-top: 1.5rem;
    }
    h1 {
      font-size: 1.6rem;
    }
    .actions button {
      width: 100%;
    }
  }
</style>
