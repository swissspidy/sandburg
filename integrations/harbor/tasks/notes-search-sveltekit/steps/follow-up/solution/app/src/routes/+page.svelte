<script>
  import { enhance } from '$app/forms';

  let { data, form } = $props();

  let query = $state('');
  let saving = $state(false);

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data.notes;
    return data.notes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)
    );
  });

  const pinnedCount = $derived(data.notes.filter((n) => n.pinned).length);

  function formatDate(s) {
    const d = new Date(s.replace(' ', 'T') + 'Z');
    return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
</script>

<svelte:head>
  <title>Notes</title>
</svelte:head>

<main>
  <header>
    <h1>📝 Notes</h1>
    <p class="sub">Jot things down. They're saved for next time.</p>
  </header>

  <section class="card" aria-labelledby="new-note-heading">
    <h2 id="new-note-heading">New note</h2>
    <form
      method="POST"
      action="?/create"
      use:enhance={() => {
        saving = true;
        return async ({ update }) => {
          await update();
          saving = false;
        };
      }}
    >
      <div class="field">
        <label for="title">Title</label>
        <input id="title" name="title" type="text" required maxlength="200"
          value={form?.title ?? ''} placeholder="Groceries, ideas, plans…" />
      </div>
      <div class="field">
        <label for="body">Body</label>
        <textarea id="body" name="body" rows="4" value={form?.body ?? ''}
          placeholder="Write your note…"></textarea>
      </div>
      {#if form?.error}
        <p class="error" role="alert">{form.error}</p>
      {/if}
      <div class="actions">
        <button type="submit" class="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save note'}
        </button>
      </div>
    </form>
  </section>

  <section aria-labelledby="notes-heading">
    <div class="list-head">
      <h2 id="notes-heading">
        Your notes <span class="count">{data.notes.length}</span>
        {#if pinnedCount > 0}<span class="count pinned-count">📌 {pinnedCount}</span>{/if}
      </h2>
      <div class="search">
        <label for="search">Search</label>
        <input id="search" type="search" bind:value={query} placeholder="Filter by title or body" />
      </div>
    </div>

    <ul aria-label="Notes" class="notes">
      {#each filtered as note (note.id)}
        <li class="note" class:pinned={note.pinned}>
          <div class="note-main">
            <h3>
              {#if note.pinned}<span class="pin-badge" aria-hidden="true">📌</span>{/if}
              {note.title}
            </h3>
            {#if note.body}<p class="body">{note.body}</p>{/if}
            <time datetime={note.created_at}>{formatDate(note.created_at)}</time>
          </div>
          <div class="note-actions">
            <form method="POST" action="?/pin" use:enhance>
              <input type="hidden" name="id" value={note.id} />
              <button
                type="submit"
                class="icon-btn pin"
                class:active={note.pinned}
                aria-label={`${note.pinned ? 'Unpin' : 'Pin'} ${note.title}`}
                title={note.pinned ? 'Unpin' : 'Pin'}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path fill="currentColor" d="M15 3l6 6-2 2-1-1-4 4 .5 4.5L13 20l-4-4-5 5-1-1 5-5-4-4 1.5-1.5L10 10l4-4-1-1 2-2Z"/>
                </svg>
              </button>
            </form>
            <form method="POST" action="?/delete" use:enhance>
              <input type="hidden" name="id" value={note.id} />
              <button type="submit" class="icon-btn delete" aria-label={`Delete note ${note.title}`} title="Delete">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z"/>
                </svg>
              </button>
            </form>
          </div>
        </li>
      {/each}
    </ul>

    {#if data.notes.length === 0}
      <div class="empty">
        <p class="emoji" aria-hidden="true">🗒️</p>
        <p>No notes yet. Write your first one above.</p>
      </div>
    {:else if filtered.length === 0}
      <div class="empty">
        <p class="emoji" aria-hidden="true">🔍</p>
        <p>No notes match “{query}”.</p>
      </div>
    {/if}
  </section>
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: #f5f3ef;
    color: #2a2622;
    line-height: 1.5;
  }
  main { max-width: 760px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  header { margin-bottom: 1.5rem; }
  h1 { margin: 0; font-size: 2rem; letter-spacing: -0.02em; }
  .sub { margin: 0.25rem 0 0; color: #6f665c; }
  h2 { font-size: 1.1rem; margin: 0 0 1rem; }

  .card {
    background: #fff; border: 1px solid #e6e0d7; border-radius: 14px;
    padding: 1.25rem; margin-bottom: 2rem; box-shadow: 0 1px 2px rgb(0 0 0 / 0.04);
  }
  .field { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.9rem; }
  label { font-weight: 600; font-size: 0.9rem; }
  input, textarea {
    font: inherit; padding: 0.6rem 0.75rem; border: 1px solid #d8d0c4;
    border-radius: 10px; background: #fffdfa; color: inherit; width: 100%;
  }
  textarea { resize: vertical; }
  input:hover, textarea:hover { border-color: #bfb3a3; }
  input:focus-visible, textarea:focus-visible, button:focus-visible {
    outline: 3px solid #f2b84b; outline-offset: 1px; border-color: #d9962a;
  }
  .actions { display: flex; justify-content: flex-end; }
  button { font: inherit; cursor: pointer; }
  .primary {
    background: #2a2622; color: #fff; border: none; border-radius: 10px;
    padding: 0.6rem 1.2rem; font-weight: 600;
  }
  .primary:hover { background: #463f38; }
  .primary:disabled { opacity: 0.6; cursor: progress; }
  .error { color: #b3261e; margin: 0 0 0.75rem; font-size: 0.9rem; }

  .list-head {
    display: flex; align-items: flex-end; justify-content: space-between;
    gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem;
  }
  .list-head h2 { margin: 0; }
  .count {
    display: inline-block; background: #ece5da; color: #6f665c; border-radius: 999px;
    padding: 0 0.55rem; font-size: 0.8rem; margin-left: 0.3rem; vertical-align: middle;
  }
  .pinned-count { background: #fde7c4; color: #8a5a10; }
  .search { display: flex; flex-direction: column; gap: 0.3rem; flex: 1 1 220px; max-width: 320px; }

  .notes { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.75rem; }
  .note {
    display: flex; gap: 0.75rem; align-items: flex-start; background: #fffbea;
    border: 1px solid #efe2b5; border-radius: 12px; padding: 1rem 1rem 0.85rem;
    transition: box-shadow 0.15s, transform 0.15s;
  }
  .note:hover { box-shadow: 0 4px 14px rgb(0 0 0 / 0.07); transform: translateY(-1px); }
  .note.pinned { background: #fff3d6; border-color: #e9c477; box-shadow: inset 4px 0 0 #e0a43a; }
  .note-main { flex: 1; min-width: 0; }
  .note h3 { margin: 0 0 0.25rem; font-size: 1.05rem; overflow-wrap: anywhere; }
  .pin-badge { font-size: 0.9rem; margin-right: 0.2rem; }
  .body { margin: 0 0 0.5rem; white-space: pre-wrap; overflow-wrap: anywhere; color: #3d3730; }
  time { font-size: 0.8rem; color: #8a7f72; }
  .note-actions { display: flex; gap: 0.25rem; flex-shrink: 0; }
  .note-actions form { margin: 0; }
  .icon-btn {
    background: transparent; border: 1px solid transparent; color: #8a7f72;
    border-radius: 8px; padding: 0.35rem; display: grid; place-items: center;
  }
  .pin:hover { color: #a86a0c; background: #fdf0d6; border-color: #f0d49e; }
  .pin.active { color: #b5730d; background: #fde7c4; border-color: #edc98a; }
  .pin.active:hover { background: #fadcae; }
  .delete:hover { color: #b3261e; background: #fbe9e7; border-color: #f3c9c4; }

  .empty {
    text-align: center; color: #6f665c; padding: 2.5rem 1rem;
    border: 2px dashed #e0d8cc; border-radius: 14px;
  }
  .empty p { margin: 0; }
  .emoji { font-size: 2rem; margin-bottom: 0.5rem !important; }

  @media (max-width: 520px) {
    main { padding: 1.25rem 0.9rem 3rem; }
    h1 { font-size: 1.6rem; }
    .search { max-width: none; }
    .primary { width: 100%; }
    .note-actions { flex-direction: column; }
  }
</style>
