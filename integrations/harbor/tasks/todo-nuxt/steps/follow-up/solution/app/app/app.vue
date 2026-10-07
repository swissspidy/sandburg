<script setup>
useHead({ title: 'To-do' });

const PRIORITY_RANK = { high: 2, normal: 1, low: 0 };
const PRIORITY_LABEL = { high: 'High', normal: 'Normal', low: 'Low' };

const { data: tasks, error: loadError } = await useFetch('/api/tasks', { default: () => [] });

const newText = ref('');
const newPriority = ref('normal');
const adding = ref(false);
const errorMsg = ref('');
const input = ref(null);

const sortedTasks = computed(() =>
  [...tasks.value].sort(
    (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.id - b.id
  )
);

const remaining = computed(() => tasks.value.filter((t) => !t.done).length);

function fail(err, fallback) {
  errorMsg.value = err?.data?.statusMessage || err?.statusMessage || fallback;
}

async function addTask() {
  const text = newText.value.trim();
  if (!text || adding.value) return;
  adding.value = true;
  errorMsg.value = '';
  try {
    const task = await $fetch('/api/tasks', {
      method: 'POST',
      body: { text, priority: newPriority.value },
    });
    tasks.value = [...tasks.value, task];
    newText.value = '';
  } catch (err) {
    fail(err, 'Could not add the task.');
  } finally {
    adding.value = false;
    input.value?.focus();
  }
}

async function toggle(task) {
  const done = !task.done;
  task.done = done;
  errorMsg.value = '';
  try {
    await $fetch(`/api/tasks/${task.id}`, { method: 'PATCH', body: { done } });
  } catch (err) {
    task.done = !done;
    fail(err, 'Could not update the task.');
  }
}

async function removeTask(task) {
  errorMsg.value = '';
  const before = tasks.value;
  tasks.value = before.filter((t) => t.id !== task.id);
  try {
    await $fetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
  } catch (err) {
    tasks.value = before;
    fail(err, 'Could not delete the task.');
  }
}
</script>

<template>
  <main class="wrap">
    <header class="head">
      <h1>To-do</h1>
      <p v-if="tasks.length" class="count">
        {{ remaining }} of {{ tasks.length }} left
      </p>
    </header>

    <form class="add" @submit.prevent="addTask">
      <div class="field field-text">
        <label for="new-task" class="field-label">New task</label>
        <input
          id="new-task"
          ref="input"
          v-model="newText"
          type="text"
          maxlength="500"
          placeholder="What needs doing?"
          autocomplete="off"
        />
      </div>
      <div class="field field-priority">
        <label for="new-priority" class="field-label">Priority</label>
        <select id="new-priority" v-model="newPriority">
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </select>
      </div>
      <button type="submit" class="btn-primary" :disabled="adding">Add</button>
    </form>

    <p v-if="errorMsg || loadError" class="error" role="alert">
      {{ errorMsg || 'Could not load tasks.' }}
    </p>

    <ul v-if="tasks.length" class="list" aria-label="Tasks">
      <li v-for="task in sortedTasks" :key="task.id" class="item" :class="{ done: task.done }">
        <label class="check">
          <input type="checkbox" :checked="task.done" @change="toggle(task)" />
          <span class="text">{{ task.text }}</span>
        </label>
        <span class="badge" :class="`badge-${task.priority}`">
          {{ PRIORITY_LABEL[task.priority] }}
        </span>
        <button
          type="button"
          class="btn-delete"
          :aria-label="`Delete ${task.text}`"
          :title="`Delete ${task.text}`"
          @click="removeTask(task)"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </li>
    </ul>
    <section v-else class="empty" aria-label="Tasks">
      <div class="empty-icon" aria-hidden="true">📝</div>
      <p>No tasks yet. Add your first one above.</p>
    </section>
  </main>
</template>
