<script>
  import { enhance } from '$app/forms';

  let { data, form } = $props();

  let remaining = $derived(data.tasks.filter((t) => !t.done).length);

  const LABELS = { high: 'High', normal: 'Normal', low: 'Low' };

  const keepForm = () => async ({ update }) => {
    await update({ reset: false });
  };

  const addEnhance = () => async ({ result, update, formElement }) => {
    await update();
    if (result.type === 'success') {
      const select = formElement.querySelector('select');
      if (select) select.value = 'normal';
      formElement.querySelector('input[name="text"]')?.focus();
    }
  };
</script>

<svelte:head>
  <title>To-do</title>
</svelte:head>

<main>
  <header>
    <h1>To-do</h1>
    {#if data.tasks.length > 0}
      <p class="count" aria-live="polite">
        {remaining} of {data.tasks.length} remaining
      </p>
    {/if}
  </header>

  <form method="POST" action="?/add" class="add" use:enhance={addEnhance}>
    <label for="new-task" class="visually-hidden">New task</label>
    <input
      id="new-task"
      name="text"
      type="text"
      placeholder="What needs doing?"
      autocomplete="off"
      maxlength="500"
      value={form?.text ?? ''}
      aria-describedby={form?.error ? 'add-error' : undefined}
    />
    <label for="new-priority" class="visually-hidden">Priority</label>
    <select id="new-priority" name="priority" title="Priority">
      <option value="low" selected={form?.priority === 'low'}>Low</option>
      <option value="normal" selected={!form?.priority || form?.priority === 'normal'}>Normal</option>
      <option value="high" selected={form?.priority === 'high'}>High</option>
    </select>
    <button type="submit">Add</button>
  </form>
  {#if form?.error}
    <p id="add-error" class="error" role="alert">{form.error}</p>
  {/if}

  {#if data.tasks.length === 0}
    <div class="empty">
      <span aria-hidden="true">📝</span>
      <p>No tasks yet. Add your first one above.</p>
    </div>
  {/if}

  <ul aria-label="Tasks" class="tasks">
    {#each data.tasks as task (task.id)}
      <li class:done={task.done}>
        <form method="POST" action="?/toggle" class="toggle" use:enhance={keepForm}>
          <input type="hidden" name="id" value={task.id} />
          <label>
            <input
              type="checkbox"
              name="done"
              checked={task.done}
              onchange={(e) => e.currentTarget.form.requestSubmit()}
            />
            <span class="text">{task.text}</span>
          </label>
          <noscript><button type="submit" class="small">Save</button></noscript>
        </form>
        <span class="priority {task.priority}">{LABELS[task.priority]}</span>
        <form method="POST" action="?/delete" use:enhance={keepForm}>
          <input type="hidden" name="id" value={task.id} />
          <button type="submit" class="delete" aria-label={`Delete ${task.text}`} title="Delete">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </form>
      </li>
    {/each}
  </ul>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: #f4f5fb;
    color: #1f2333;
    line-height: 1.5;
  }

  main {
    max-width: 640px;
    margin: 0 auto;
    padding: 2.5rem 1.25rem 4rem;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1.25rem;
  }

  h1 {
    margin: 0;
    font-size: 2rem;
    letter-spacing: -0.02em;
  }

  .count {
    margin: 0;
    color: #6b7084;
    font-size: 0.95rem;
  }

  .add {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .add input,
  .add select {
    padding: 0.75rem 1rem;
    font: inherit;
    border: 1px solid #d3d6e4;
    border-radius: 10px;
    background: #fff;
    color: inherit;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .add input {
    flex: 1 1 220px;
    min-width: 0;
  }

  .add select {
    flex: 0 0 auto;
    padding-right: 0.75rem;
    cursor: pointer;
  }

  .add input:focus,
  .add select:focus {
    outline: none;
    border-color: #5b5bd6;
    box-shadow: 0 0 0 3px rgba(91, 91, 214, 0.2);
  }

  .add select:hover {
    border-color: #b7bad0;
  }

  .add button {
    flex: 0 0 auto;
    padding: 0.75rem 1.4rem;
    font: inherit;
    font-weight: 600;
    color: #fff;
    background: #5b5bd6;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .add button:hover {
    background: #4747c2;
  }

  .add button:focus-visible,
  .delete:focus-visible,
  .small:focus-visible {
    outline: 3px solid rgba(91, 91, 214, 0.45);
    outline-offset: 2px;
  }

  .error {
    margin: 0.5rem 0 0;
    color: #c0392b;
    font-size: 0.9rem;
  }

  .empty {
    margin-top: 2rem;
    padding: 2.5rem 1rem;
    text-align: center;
    color: #6b7084;
    background: #fff;
    border: 2px dashed #d3d6e4;
    border-radius: 14px;
  }

  .empty span {
    font-size: 2rem;
  }

  .empty p {
    margin: 0.5rem 0 0;
  }

  .tasks {
    list-style: none;
    margin: 1.5rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .tasks:empty {
    display: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.5rem 0.5rem 1rem;
    background: #fff;
    border: 1px solid #e4e6f0;
    border-radius: 12px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  li:hover {
    border-color: #c9cbe0;
    box-shadow: 0 2px 8px rgba(31, 35, 51, 0.06);
  }

  .toggle {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .toggle label {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    cursor: pointer;
    padding: 0.35rem 0;
  }

  .toggle input[type='checkbox'] {
    width: 1.2rem;
    height: 1.2rem;
    flex-shrink: 0;
    accent-color: #5b5bd6;
    cursor: pointer;
  }

  .text {
    overflow-wrap: anywhere;
  }

  li.done .text {
    color: #9a9eb2;
    text-decoration: line-through;
  }

  .priority {
    flex-shrink: 0;
    padding: 0.15rem 0.6rem;
    font-size: 0.8rem;
    font-weight: 600;
    border-radius: 999px;
    border: 1px solid transparent;
  }

  .priority.high {
    color: #a3261b;
    background: #fdecea;
    border-color: #f6c6c0;
  }

  .priority.normal {
    color: #3d3dab;
    background: #ececfb;
    border-color: #d3d3f4;
  }

  .priority.low {
    color: #4f5568;
    background: #f0f1f5;
    border-color: #dfe1e9;
  }

  li.done .priority {
    opacity: 0.6;
  }

  .delete {
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    color: #9a9eb2;
    background: transparent;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }

  .delete:hover {
    color: #c0392b;
    background: #fdecea;
  }

  .small {
    font: inherit;
    font-size: 0.85rem;
    padding: 0.25rem 0.6rem;
    border: 1px solid #d3d6e4;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  @media (max-width: 420px) {
    main {
      padding-top: 1.5rem;
    }
    h1 {
      font-size: 1.6rem;
    }
    .add select,
    .add button {
      flex: 1 1 auto;
    }
  }
</style>
