<script lang="ts">
  import { addTodo, remaining, todos } from './todos.svelte'

  let draft = $state('')
  const left = $derived(remaining())

  function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!draft.trim()) return
    addTodo(draft.trim())
    draft = ''
  }
</script>

<section>
  <form onsubmit={submit}>
    <label>New todo <input bind:value={draft} /></label>
    <button type="submit">Add</button>
  </form>
  <p role="status">{left} left</p>
  <ul>
    {#each todos as todo (todo.id)}
      <li class:done={todo.done}>
        <label><input type="checkbox" bind:checked={todo.done} /> {todo.text}</label>
      </li>
    {/each}
  </ul>
</section>

<style>
  .done {
    text-decoration: line-through;
  }
</style>
