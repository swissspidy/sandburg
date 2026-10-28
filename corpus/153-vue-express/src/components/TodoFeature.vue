<script setup lang="ts">
import { computed, ref } from 'vue';

type Todo = { id: number; text: string; done: boolean };

const todos = ref<Todo[]>([]);
const text = ref('');
const remaining = computed(() => todos.value.filter((t) => !t.done).length);

function add() {
  if (!text.value.trim()) return;
  todos.value.push({ id: todos.value.length + 1, text: text.value.trim(), done: false });
  text.value = '';
}

function toggle(todo: Todo) {
  todo.done = !todo.done;
}
</script>

<template>
  <section aria-label="Todos">
    <form @submit.prevent="add">
      <label for="todo-input">New todo</label>
      <input id="todo-input" v-model="text" />
      <button type="submit">Add todo</button>
    </form>
    <ul aria-label="Todo list">
      <li v-for="todo in todos" :key="todo.id">
        <label>
          <input type="checkbox" :checked="todo.done" @change="toggle(todo)" />
          {{ todo.text }}
        </label>
      </li>
    </ul>
    <p data-testid="remaining">{{ remaining }} remaining</p>
  </section>
</template>
