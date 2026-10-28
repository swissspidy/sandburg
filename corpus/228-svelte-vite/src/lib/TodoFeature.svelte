<script lang="ts">
  type Todo = { id: number; text: string; done: boolean };

  let todos = $state<Todo[]>([]);
  let text = $state('');
  const remaining = $derived(todos.filter((t) => !t.done).length);

  function add(e: SubmitEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    todos.push({ id: todos.length + 1, text: text.trim(), done: false });
    text = '';
  }

  function toggle(todo: Todo) {
    todo.done = !todo.done;
  }
</script>

<section aria-label="Todos">
  <form onsubmit={add}>
    <label for="todo-input">New todo</label>
    <input id="todo-input" bind:value={text} />
    <button type="submit">Add todo</button>
  </form>
  <ul aria-label="Todo list">
    {#each todos as todo (todo.id)}
      <li>
        <label>
          <input type="checkbox" checked={todo.done} onchange={() => toggle(todo)} />
          {todo.text}
        </label>
      </li>
    {/each}
  </ul>
  <p data-testid="remaining">{remaining} remaining</p>
</section>
