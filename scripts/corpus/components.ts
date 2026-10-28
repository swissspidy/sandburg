/**
 * The corpus features (features.ts) in the component styles of the frameworks added in fidelity
 * study v7: Vue single-file components (Vue, Nuxt, the Vue client of Express + SQLite), Svelte 5
 * components (Svelte, SvelteKit), Solid (SolidStart), Angular standalone components and Lit
 * elements. Each renders the same markup as the React and vanilla variants, so the same check
 * verifies it, and `bug: true` seeds the same logic bug (Angular's fetch and the full-stack server
 * excepted: see `angular.fetch` and stacks.ts).
 */

export type Kit = 'vue' | 'svelte' | 'solid' | 'angular' | 'lit';

/** Features every new framework implements (the React-only ones need React). */
export const CORE = ['counter', 'todo', 'search', 'tabs', 'form', 'modal', 'persist', 'converter', 'fetch', 'dates'] as const;
export type CoreFeature = (typeof CORE)[number];

type Source = (bug: boolean, source: string) => string;

const FRUITS = `['Apple', 'Apricot', 'Banana', 'Blueberry', 'Cherry', 'Grape', 'Mango']`;
const EMAIL = `/^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$/i`;
const match = (bug: boolean, q: string) => (bug ? `f.includes(${q})` : `f.toLowerCase().includes(${q}.toLowerCase())`);

const vue: Record<CoreFeature, Source> = {
  counter: (bug) => `<script setup lang="ts">
import { ref } from 'vue';

const count = ref(0);
</script>

<template>
  <section aria-label="Counter">
    <p data-testid="count">Count: {{ count }}</p>
    <button type="button" @click="count += ${bug ? 2 : 1}">Increment</button>
    <button type="button" @click="count = 0">Reset</button>
  </section>
</template>
`,
  todo: (bug) => `<script setup lang="ts">
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
  todo.done = ${bug ? 'todo.done' : '!todo.done'};
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
`,
  search: (bug) => `<script setup lang="ts">
import { computed, ref } from 'vue';

const FRUITS = ${FRUITS};

const q = ref('');
const shown = computed(() => FRUITS.filter((f) => ${match(bug, 'q.value')}));
</script>

<template>
  <section aria-label="Search">
    <input v-model="q" type="search" aria-label="Search fruits" />
    <ul aria-label="Results">
      <li v-for="f in shown" :key="f">{{ f }}</li>
    </ul>
  </section>
</template>
`,
  tabs: (bug) => `<script setup lang="ts">
import { computed, ref } from 'vue';

const TABS = [
  { id: 'overview', label: 'Overview', body: 'Project overview' },
  { id: 'specs', label: 'Specs', body: 'Technical specs' },
  { id: 'reviews', label: 'Reviews', body: 'Customer reviews' },
];

const active = ref('overview');
const tab = computed(() => TABS.find((t) => t.id === active.value)!);
</script>

<template>
  <section aria-label="Details">
    <div role="tablist">
      <button v-for="t in TABS" :key="t.id" role="tab" :aria-selected="t.id === active" @click="active = ${bug ? "'overview'" : 't.id'}">{{ t.label }}</button>
    </div>
    <div role="tabpanel">{{ tab.body }}</div>
  </section>
</template>
`,
  form: (bug) => `<script setup lang="ts">
import { ref } from 'vue';

const email = ref('');
const error = ref('');
const done = ref(false);

function submit() {
  if (!${EMAIL}.test(email.value)) { error.value = 'Please enter a valid email'; ${bug ? 'done.value = true; ' : ''}return; }
  error.value = '';
  done.value = true;
}
</script>

<template>
  <section aria-label="Signup">
    <p v-if="done" role="status">Thanks for signing up!</p>
    <form novalidate @submit.prevent="submit">
      <label for="email">Email</label>
      <input id="email" v-model="email" type="email" />
      <p v-if="error" role="alert">{{ error }}</p>
      <button type="submit">Sign up</button>
    </form>
  </section>
</template>
`,
  modal: (bug) => `<script setup lang="ts">
import { ref } from 'vue';

const open = ref(false);
</script>

<template>
  <section aria-label="Modal demo">
    <button type="button" @click="open = true">Open settings</button>
    <div v-if="open" role="dialog" aria-label="Settings" aria-modal="true">
      <p>Settings go here.</p>
      <button type="button" @click="open = ${bug ? 'true' : 'false'}">Close</button>
    </div>
  </section>
</template>
`,
  persist: (bug) => `<script setup lang="ts">
import { onMounted, ref } from 'vue';

const notes = ref<string[]>([]);
const text = ref('');

onMounted(() => {
  const saved = localStorage.getItem('notes');
  if (saved) notes.value = JSON.parse(saved);
});

function add() {
  notes.value = [...notes.value, text.value];
  ${bug ? '' : "localStorage.setItem('notes', JSON.stringify(notes.value));"}
  text.value = '';
}
</script>

<template>
  <section aria-label="Notes">
    <input v-model="text" aria-label="Note" />
    <button type="button" @click="add">Save note</button>
    <ul aria-label="Saved notes">
      <li v-for="(n, i) in notes" :key="i">{{ n }}</li>
    </ul>
  </section>
</template>
`,
  converter: (bug) => `<script setup lang="ts">
import { computed, ref } from 'vue';

const celsius = ref<number | string>(0);
const fahrenheit = computed(() => {
  const f = (Number(celsius.value) * 9) / 5 + ${bug ? 23 : 32};
  return Number.isFinite(f) ? f.toFixed(1) : '—';
});
</script>

<template>
  <section aria-label="Converter">
    <label for="celsius">Celsius</label>
    <input id="celsius" v-model="celsius" type="number" />
    <output data-testid="fahrenheit">{{ fahrenheit }} °F</output>
  </section>
</template>
`,
  fetch: (bug) => `<script setup lang="ts">
import { onMounted, ref } from 'vue';

type Product = { id: number; name: string; price: number };

const props = defineProps<{ source: string }>();
const items = ref<Product[] | null>(null);
const error = ref('');

onMounted(async () => {
  try {
    const r = await fetch(props.source);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data: { products: Product[] } = await r.json();
    items.value = data.${bug ? 'items' : 'products'};
  } catch (e) {
    error.value = String(e);
  }
});
</script>

<template>
  <p v-if="error" role="alert">Failed to load products: {{ error }}</p>
  <p v-else-if="!items">Loading…</p>
  <section v-else aria-label="Products">
    <ul>
      <li v-for="p in items" :key="p.id">{{ p.name }} — \${{ p.price }}</li>
    </ul>
  </section>
</template>
`,
  dates: (bug) => `<script setup lang="ts">
import { addDays, format } from 'date-fns';

const START = new Date(2025, 0, 30);
const due = format(addDays(START, ${bug ? 3 : 2}), 'EEEE, MMMM d');
</script>

<template>
  <section aria-label="Schedule">
    <p data-testid="due">Due {{ due }}</p>
  </section>
</template>
`,
};

const svelte: Record<CoreFeature, Source> = {
  counter: (bug) => `<script lang="ts">
  let count = $state(0);
</script>

<section aria-label="Counter">
  <p data-testid="count">Count: {count}</p>
  <button type="button" onclick={() => (count += ${bug ? 2 : 1})}>Increment</button>
  <button type="button" onclick={() => (count = 0)}>Reset</button>
</section>
`,
  todo: (bug) => `<script lang="ts">
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
    todo.done = ${bug ? 'todo.done' : '!todo.done'};
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
`,
  search: (bug) => `<script lang="ts">
  const FRUITS = ${FRUITS};

  let q = $state('');
  const shown = $derived(FRUITS.filter((f) => ${match(bug, 'q')}));
</script>

<section aria-label="Search">
  <input type="search" aria-label="Search fruits" bind:value={q} />
  <ul aria-label="Results">
    {#each shown as f (f)}
      <li>{f}</li>
    {/each}
  </ul>
</section>
`,
  tabs: (bug) => `<script lang="ts">
  const TABS = [
    { id: 'overview', label: 'Overview', body: 'Project overview' },
    { id: 'specs', label: 'Specs', body: 'Technical specs' },
    { id: 'reviews', label: 'Reviews', body: 'Customer reviews' },
  ];

  let active = $state('overview');
  const tab = $derived(TABS.find((t) => t.id === active)!);
</script>

<section aria-label="Details">
  <div role="tablist">
    {#each TABS as t (t.id)}
      <button role="tab" aria-selected={t.id === active} onclick={() => (active = ${bug ? "'overview'" : 't.id'})}>{t.label}</button>
    {/each}
  </div>
  <div role="tabpanel">{tab.body}</div>
</section>
`,
  form: (bug) => `<script lang="ts">
  let email = $state('');
  let error = $state('');
  let done = $state(false);

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!${EMAIL}.test(email)) { error = 'Please enter a valid email'; ${bug ? 'done = true; ' : ''}return; }
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
`,
  modal: (bug) => `<script lang="ts">
  let open = $state(false);
</script>

<section aria-label="Modal demo">
  <button type="button" onclick={() => (open = true)}>Open settings</button>
  {#if open}
    <div role="dialog" aria-label="Settings" aria-modal="true">
      <p>Settings go here.</p>
      <button type="button" onclick={() => (open = ${bug ? 'true' : 'false'})}>Close</button>
    </div>
  {/if}
</section>
`,
  persist: (bug) => `<script lang="ts">
  import { onMount } from 'svelte';

  let notes = $state<string[]>([]);
  let text = $state('');

  onMount(() => {
    const saved = localStorage.getItem('notes');
    if (saved) notes = JSON.parse(saved);
  });

  function add() {
    notes = [...notes, text];
    ${bug ? '' : "localStorage.setItem('notes', JSON.stringify(notes));"}
    text = '';
  }
</script>

<section aria-label="Notes">
  <input aria-label="Note" bind:value={text} />
  <button type="button" onclick={add}>Save note</button>
  <ul aria-label="Saved notes">
    {#each notes as n, i (i)}
      <li>{n}</li>
    {/each}
  </ul>
</section>
`,
  converter: (bug) => `<script lang="ts">
  let celsius = $state<number | null>(0);
  const f = $derived((Number(celsius) * 9) / 5 + ${bug ? 23 : 32});
</script>

<section aria-label="Converter">
  <label for="celsius">Celsius</label>
  <input id="celsius" type="number" bind:value={celsius} />
  <output data-testid="fahrenheit">{Number.isFinite(f) ? f.toFixed(1) : '—'} °F</output>
</section>
`,
  fetch: (bug) => `<script lang="ts">
  import { onMount } from 'svelte';

  type Product = { id: number; name: string; price: number };

  let { source }: { source: string } = $props();
  let items = $state<Product[] | null>(null);
  let error = $state('');

  onMount(() => {
    fetch(source)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((data: { products: Product[] }) => (items = data.${bug ? 'items' : 'products'}))
      .catch((e) => (error = String(e)));
  });
</script>

{#if error}
  <p role="alert">Failed to load products: {error}</p>
{:else if !items}
  <p>Loading…</p>
{:else}
  <section aria-label="Products">
    <ul>
      {#each items as p (p.id)}
        <li>{p.name} — \${p.price}</li>
      {/each}
    </ul>
  </section>
{/if}
`,
  dates: (bug) => `<script lang="ts">
  import { addDays, format } from 'date-fns';

  const START = new Date(2025, 0, 30);
  const due = format(addDays(START, ${bug ? 3 : 2}), 'EEEE, MMMM d');
</script>

<section aria-label="Schedule">
  <p data-testid="due">Due {due}</p>
</section>
`,
};

const solid: Record<CoreFeature, Source> = {
  counter: (bug) => `import { createSignal } from 'solid-js';

export default function Counter() {
  const [count, setCount] = createSignal(0);
  return (
    <section aria-label="Counter">
      <p data-testid="count">Count: {count()}</p>
      <button type="button" onClick={() => setCount((c) => c + ${bug ? 2 : 1})}>Increment</button>
      <button type="button" onClick={() => setCount(0)}>Reset</button>
    </section>
  );
}
`,
  todo: (bug) => `import { createSignal, For } from 'solid-js';

type Todo = { id: number; text: string; done: boolean };

export default function Todos() {
  const [todos, setTodos] = createSignal<Todo[]>([]);
  const [text, setText] = createSignal('');
  function add(e: SubmitEvent) {
    e.preventDefault();
    if (!text().trim()) return;
    setTodos((t) => [...t, { id: t.length + 1, text: text().trim(), done: false }]);
    setText('');
  }
  return (
    <section aria-label="Todos">
      <form onSubmit={add}>
        <label for="todo-input">New todo</label>
        <input id="todo-input" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
        <button type="submit">Add todo</button>
      </form>
      <ul aria-label="Todo list">
        <For each={todos()}>
          {(t) => (
            <li>
              <label>
                <input type="checkbox" checked={t.done} onChange={() => setTodos((all) => all.map((x) => (x.id === t.id ? { ...x, done: ${bug ? 'x.done' : '!x.done'} } : x)))} />
                {t.text}
              </label>
            </li>
          )}
        </For>
      </ul>
      <p data-testid="remaining">{todos().filter((t) => !t.done).length} remaining</p>
    </section>
  );
}
`,
  search: (bug) => `import { createSignal, For } from 'solid-js';

const FRUITS = ${FRUITS};

export default function Search() {
  const [q, setQ] = createSignal('');
  const shown = () => FRUITS.filter((f) => ${match(bug, 'q()')});
  return (
    <section aria-label="Search">
      <input type="search" aria-label="Search fruits" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      <ul aria-label="Results">
        <For each={shown()}>{(f) => <li>{f}</li>}</For>
      </ul>
    </section>
  );
}
`,
  tabs: (bug) => `import { createSignal, For } from 'solid-js';

const TABS = [
  { id: 'overview', label: 'Overview', body: 'Project overview' },
  { id: 'specs', label: 'Specs', body: 'Technical specs' },
  { id: 'reviews', label: 'Reviews', body: 'Customer reviews' },
];

export default function Tabs() {
  const [active, setActive] = createSignal('overview');
  const tab = () => TABS.find((t) => t.id === active())!;
  return (
    <section aria-label="Details">
      <div role="tablist">
        <For each={TABS}>
          {(t) => (
            <button role="tab" aria-selected={t.id === active()} onClick={() => setActive(${bug ? "'overview'" : 't.id'})}>
              {t.label}
            </button>
          )}
        </For>
      </div>
      <div role="tabpanel">{tab().body}</div>
    </section>
  );
}
`,
  form: (bug) => `import { createSignal, Show } from 'solid-js';

export default function SignupForm() {
  const [email, setEmail] = createSignal('');
  const [error, setError] = createSignal('');
  const [done, setDone] = createSignal(false);
  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!${EMAIL}.test(email())) { setError('Please enter a valid email'); ${bug ? 'setDone(true); ' : ''}return; }
    setError('');
    setDone(true);
  }
  return (
    <section aria-label="Signup">
      <Show when={done()}>
        <p role="status">Thanks for signing up!</p>
      </Show>
      <form novalidate onSubmit={submit}>
        <label for="email">Email</label>
        <input id="email" type="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
        <button type="submit">Sign up</button>
      </form>
    </section>
  );
}
`,
  modal: (bug) => `import { createSignal, Show } from 'solid-js';

export default function ModalDemo() {
  const [open, setOpen] = createSignal(false);
  return (
    <section aria-label="Modal demo">
      <button type="button" onClick={() => setOpen(true)}>Open settings</button>
      <Show when={open()}>
        <div role="dialog" aria-label="Settings" aria-modal="true">
          <p>Settings go here.</p>
          <button type="button" onClick={() => setOpen(${bug ? 'true' : 'false'})}>Close</button>
        </div>
      </Show>
    </section>
  );
}
`,
  persist: (bug) => `import { createSignal, For, onMount } from 'solid-js';

export default function Notes() {
  const [notes, setNotes] = createSignal<string[]>([]);
  const [text, setText] = createSignal('');
  onMount(() => {
    const saved = localStorage.getItem('notes');
    if (saved) setNotes(JSON.parse(saved));
  });
  function add() {
    const next = [...notes(), text()];
    setNotes(next);
    ${bug ? '' : "localStorage.setItem('notes', JSON.stringify(next));"}
    setText('');
  }
  return (
    <section aria-label="Notes">
      <input aria-label="Note" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
      <button type="button" onClick={add}>Save note</button>
      <ul aria-label="Saved notes">
        <For each={notes()}>{(n) => <li>{n}</li>}</For>
      </ul>
    </section>
  );
}
`,
  converter: (bug) => `import { createSignal } from 'solid-js';

export default function Converter() {
  const [c, setC] = createSignal('0');
  const f = () => (Number(c()) * 9) / 5 + ${bug ? 23 : 32};
  return (
    <section aria-label="Converter">
      <label for="celsius">Celsius</label>
      <input id="celsius" type="number" value={c()} onInput={(e) => setC(e.currentTarget.value)} />
      <output data-testid="fahrenheit">{Number.isFinite(f()) ? f().toFixed(1) : '—'} °F</output>
    </section>
  );
}
`,
  fetch: (bug) => `import { createSignal, For, Match, onMount, Switch } from 'solid-js';

type Product = { id: number; name: string; price: number };

export default function Products(props: { source: string }) {
  const [items, setItems] = createSignal<Product[] | null>(null);
  const [error, setError] = createSignal('');
  onMount(() => {
    fetch(props.source)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((data: { products: Product[] }) => setItems(data.${bug ? 'items' : 'products'}))
      .catch((e) => setError(String(e)));
  });
  return (
    <Switch>
      <Match when={error()}>
        <p role="alert">Failed to load products: {error()}</p>
      </Match>
      <Match when={!items()}>
        <p>Loading…</p>
      </Match>
      <Match when={items()}>
        {(list) => (
          <section aria-label="Products">
            <ul>
              <For each={list()}>{(p) => <li>{p.name} — \${p.price}</li>}</For>
            </ul>
          </section>
        )}
      </Match>
    </Switch>
  );
}
`,
  dates: (bug) => `import { addDays, format } from 'date-fns';

const START = new Date(2025, 0, 30);

export default function Schedule() {
  return (
    <section aria-label="Schedule">
      <p data-testid="due">Due {format(addDays(START, ${bug ? 3 : 2}), 'EEEE, MMMM d')}</p>
    </section>
  );
}
`,
};

/** Angular classes are named `<Feature>Feature` (stacks.ts' componentName) and selected as `app-<feature>`. */
const angular: Record<CoreFeature, Source> = {
  counter: (bug) => `import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-counter',
  template: \`
    <section aria-label="Counter">
      <p data-testid="count">Count: {{ count() }}</p>
      <button type="button" (click)="increment()">Increment</button>
      <button type="button" (click)="count.set(0)">Reset</button>
    </section>
  \`,
})
export class CounterFeature {
  readonly count = signal(0);

  increment(): void {
    this.count.update((c) => c + ${bug ? 2 : 1});
  }
}
`,
  todo: (bug) => `import { Component, computed, signal } from '@angular/core';

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

@Component({
  selector: 'app-todo',
  template: \`
    <section aria-label="Todos">
      <form (submit)="add($event)">
        <label for="todo-input">New todo</label>
        <input #input id="todo-input" [value]="text()" (input)="text.set(input.value)" />
        <button type="submit">Add todo</button>
      </form>
      <ul aria-label="Todo list">
        @for (todo of todos(); track todo.id) {
          <li>
            <label><input type="checkbox" [checked]="todo.done" (change)="toggle(todo.id)" /> {{ todo.text }}</label>
          </li>
        }
      </ul>
      <p data-testid="remaining">{{ remaining() }} remaining</p>
    </section>
  \`,
})
export class TodoFeature {
  readonly todos = signal<Todo[]>([]);
  readonly text = signal('');
  readonly remaining = computed(() => this.todos().filter((t) => !t.done).length);

  add(event: Event): void {
    event.preventDefault();
    const text = this.text().trim();
    if (!text) return;
    this.todos.update((todos) => [...todos, { id: todos.length + 1, text, done: false }]);
    this.text.set('');
  }

  toggle(id: number): void {
    this.todos.update((todos) => todos.map((t) => (t.id === id ? { ...t, done: ${bug ? 't.done' : '!t.done'} } : t)));
  }
}
`,
  search: (bug) => `import { Component, computed, signal } from '@angular/core';

const FRUITS = ${FRUITS};

@Component({
  selector: 'app-search',
  template: \`
    <section aria-label="Search">
      <input #box type="search" aria-label="Search fruits" [value]="q()" (input)="q.set(box.value)" />
      <ul aria-label="Results">
        @for (f of shown(); track f) {
          <li>{{ f }}</li>
        }
      </ul>
    </section>
  \`,
})
export class SearchFeature {
  readonly q = signal('');
  readonly shown = computed(() => FRUITS.filter((f) => ${match(bug, 'this.q()')}));
}
`,
  tabs: (bug) => `import { Component, computed, signal } from '@angular/core';

const TABS = [
  { id: 'overview', label: 'Overview', body: 'Project overview' },
  { id: 'specs', label: 'Specs', body: 'Technical specs' },
  { id: 'reviews', label: 'Reviews', body: 'Customer reviews' },
];

@Component({
  selector: 'app-tabs',
  template: \`
    <section aria-label="Details">
      <div role="tablist">
        @for (t of tabs; track t.id) {
          <button role="tab" [attr.aria-selected]="t.id === active()" (click)="active.set(${bug ? "'overview'" : 't.id'})">{{ t.label }}</button>
        }
      </div>
      <div role="tabpanel">{{ tab().body }}</div>
    </section>
  \`,
})
export class TabsFeature {
  readonly tabs = TABS;
  readonly active = signal('overview');
  readonly tab = computed(() => TABS.find((t) => t.id === this.active())!);
}
`,
  form: (bug) => `import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-form',
  template: \`
    <section aria-label="Signup">
      @if (done()) {
        <p role="status">Thanks for signing up!</p>
      }
      <form novalidate (submit)="submit($event)">
        <label for="email">Email</label>
        <input #input id="email" type="email" [value]="email()" (input)="email.set(input.value)" />
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
        <button type="submit">Sign up</button>
      </form>
    </section>
  \`,
})
export class FormFeature {
  readonly email = signal('');
  readonly error = signal('');
  readonly done = signal(false);

  submit(event: Event): void {
    event.preventDefault();
    if (!${EMAIL}.test(this.email())) {
      this.error.set('Please enter a valid email');
      ${bug ? 'this.done.set(true);\n      ' : ''}return;
    }
    this.error.set('');
    this.done.set(true);
  }
}
`,
  modal: (bug) => `import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-modal',
  template: \`
    <section aria-label="Modal demo">
      <button type="button" (click)="open.set(true)">Open settings</button>
      @if (open()) {
        <div role="dialog" aria-label="Settings" aria-modal="true">
          <p>Settings go here.</p>
          <button type="button" (click)="open.set(${bug ? 'true' : 'false'})">Close</button>
        </div>
      }
    </section>
  \`,
})
export class ModalFeature {
  readonly open = signal(false);
}
`,
  persist: (bug) => `import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-persist',
  template: \`
    <section aria-label="Notes">
      <input #input aria-label="Note" [value]="text()" (input)="text.set(input.value)" />
      <button type="button" (click)="add()">Save note</button>
      <ul aria-label="Saved notes">
        @for (n of notes(); track $index) {
          <li>{{ n }}</li>
        }
      </ul>
    </section>
  \`,
})
export class PersistFeature {
  readonly notes = signal<string[]>(JSON.parse(localStorage.getItem('notes') ?? '[]'));
  readonly text = signal('');

  add(): void {
    this.notes.update((notes) => [...notes, this.text()]);
    ${bug ? '' : "localStorage.setItem('notes', JSON.stringify(this.notes()));"}
    this.text.set('');
  }
}
`,
  converter: (bug) => `import { Component, computed, signal } from '@angular/core';

@Component({
  selector: 'app-converter',
  template: \`
    <section aria-label="Converter">
      <label for="celsius">Celsius</label>
      <input #input id="celsius" type="number" [value]="celsius()" (input)="celsius.set(input.value)" />
      <output data-testid="fahrenheit">{{ fahrenheit() }} °F</output>
    </section>
  \`,
})
export class ConverterFeature {
  readonly celsius = signal('0');
  readonly fahrenheit = computed(() => {
    const f = (Number(this.celsius()) * 9) / 5 + ${bug ? 23 : 32};
    return Number.isFinite(f) ? f.toFixed(1) : '—';
  });
}
`,
  /**
   * Angular type-checks while it serves, so reading a field the response type lacks (the other
   * variants' bug) would be a type error: the seeded bug here drops the first product instead.
   */
  fetch: (bug) => `import { Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

interface Product {
  id: number;
  name: string;
  price: number;
}

@Component({
  selector: 'app-fetch',
  template: \`
    @if (error()) {
      <p role="alert">Failed to load products: {{ error() }}</p>
    } @else if (!items()) {
      <p>Loading…</p>
    } @else {
      <section aria-label="Products">
        <ul>
          @for (p of items() ?? []; track p.id) {
            <li>{{ p.name }} — \\\${{ p.price }}</li>
          }
        </ul>
      </section>
    }
  \`,
})
export class FetchFeature {
  private readonly http = inject(HttpClient);
  readonly items = signal<Product[] | null>(null);
  readonly error = signal('');

  constructor() {
    this.http.get<{ products: Product[] }>('/data/products.json').subscribe({
      next: (data) => this.items.set(data.products${bug ? '.slice(1)' : ''}),
      error: (e: unknown) => this.error.set(String(e)),
    });
  }
}
`,
  dates: (bug) => `import { Component } from '@angular/core';
import { addDays, format } from 'date-fns';

const START = new Date(2025, 0, 30);

@Component({
  selector: 'app-dates',
  template: \`
    <section aria-label="Schedule">
      <p data-testid="due">Due {{ due }}</p>
    </section>
  \`,
})
export class DatesFeature {
  readonly due = format(addDays(START, ${bug ? 3 : 2}), 'EEEE, MMMM d');
}
`,
};

/** Lit elements are named `<feature>-feature`. */
const lit: Record<CoreFeature, Source> = {
  counter: (bug) => `import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

@customElement('counter-feature')
export class CounterFeature extends LitElement {
  @state() private count = 0;

  render() {
    return html\`
      <section aria-label="Counter">
        <p data-testid="count">Count: \${this.count}</p>
        <button type="button" @click=\${() => (this.count += ${bug ? 2 : 1})}>Increment</button>
        <button type="button" @click=\${() => (this.count = 0)}>Reset</button>
      </section>
    \`;
  }
}
`,
  todo: (bug) => `import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

type Todo = { id: number; text: string; done: boolean };

@customElement('todo-feature')
export class TodoFeature extends LitElement {
  @state() private todos: Todo[] = [];
  @state() private text = '';

  private add(e: SubmitEvent) {
    e.preventDefault();
    if (!this.text.trim()) return;
    this.todos = [...this.todos, { id: this.todos.length + 1, text: this.text.trim(), done: false }];
    this.text = '';
  }

  private toggle(id: number) {
    this.todos = this.todos.map((t) => (t.id === id ? { ...t, done: ${bug ? 't.done' : '!t.done'} } : t));
  }

  render() {
    return html\`
      <section aria-label="Todos">
        <form @submit=\${this.add}>
          <label for="todo-input">New todo</label>
          <input id="todo-input" .value=\${this.text} @input=\${(e: InputEvent) => (this.text = (e.target as HTMLInputElement).value)} />
          <button type="submit">Add todo</button>
        </form>
        <ul aria-label="Todo list">
          \${this.todos.map(
            (t) => html\`<li><label><input type="checkbox" .checked=\${t.done} @change=\${() => this.toggle(t.id)} />\${t.text}</label></li>\`,
          )}
        </ul>
        <p data-testid="remaining">\${this.todos.filter((t) => !t.done).length} remaining</p>
      </section>
    \`;
  }
}
`,
  search: (bug) => `import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

const FRUITS = ${FRUITS};

@customElement('search-feature')
export class SearchFeature extends LitElement {
  @state() private q = '';

  render() {
    const q = this.q;
    return html\`
      <section aria-label="Search">
        <input type="search" aria-label="Search fruits" .value=\${q} @input=\${(e: InputEvent) => (this.q = (e.target as HTMLInputElement).value)} />
        <ul aria-label="Results">
          \${FRUITS.filter((f) => ${match(bug, 'q')}).map((f) => html\`<li>\${f}</li>\`)}
        </ul>
      </section>
    \`;
  }
}
`,
  tabs: (bug) => `import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

const TABS = [
  { id: 'overview', label: 'Overview', body: 'Project overview' },
  { id: 'specs', label: 'Specs', body: 'Technical specs' },
  { id: 'reviews', label: 'Reviews', body: 'Customer reviews' },
];

@customElement('tabs-feature')
export class TabsFeature extends LitElement {
  @state() private active = 'overview';

  render() {
    const tab = TABS.find((t) => t.id === this.active)!;
    return html\`
      <section aria-label="Details">
        <div role="tablist">
          \${TABS.map(
            (t) => html\`<button role="tab" aria-selected=\${String(t.id === this.active)} @click=\${() => (this.active = ${bug ? "'overview'" : 't.id'})}>\${t.label}</button>\`,
          )}
        </div>
        <div role="tabpanel">\${tab.body}</div>
      </section>
    \`;
  }
}
`,
  form: (bug) => `import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

@customElement('form-feature')
export class FormFeature extends LitElement {
  @state() private email = '';
  @state() private error = '';
  @state() private done = false;

  private submit(e: SubmitEvent) {
    e.preventDefault();
    if (!${EMAIL}.test(this.email)) { this.error = 'Please enter a valid email'; ${bug ? 'this.done = true; ' : ''}return; }
    this.error = '';
    this.done = true;
  }

  render() {
    return html\`
      <section aria-label="Signup">
        \${this.done ? html\`<p role="status">Thanks for signing up!</p>\` : nothing}
        <form novalidate @submit=\${this.submit}>
          <label for="email">Email</label>
          <input id="email" type="email" .value=\${this.email} @input=\${(e: InputEvent) => (this.email = (e.target as HTMLInputElement).value)} />
          \${this.error ? html\`<p role="alert">\${this.error}</p>\` : nothing}
          <button type="submit">Sign up</button>
        </form>
      </section>
    \`;
  }
}
`,
  modal: (bug) => `import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

@customElement('modal-feature')
export class ModalFeature extends LitElement {
  @state() private open = false;

  render() {
    return html\`
      <section aria-label="Modal demo">
        <button type="button" @click=\${() => (this.open = true)}>Open settings</button>
        \${this.open
          ? html\`<div role="dialog" aria-label="Settings" aria-modal="true">
              <p>Settings go here.</p>
              <button type="button" @click=\${() => (this.open = ${bug ? 'true' : 'false'})}>Close</button>
            </div>\`
          : nothing}
      </section>
    \`;
  }
}
`,
  persist: (bug) => `import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

@customElement('persist-feature')
export class PersistFeature extends LitElement {
  @state() private notes: string[] = JSON.parse(localStorage.getItem('notes') ?? '[]');
  @state() private text = '';

  private add() {
    this.notes = [...this.notes, this.text];
    ${bug ? '' : "localStorage.setItem('notes', JSON.stringify(this.notes));"}
    this.text = '';
  }

  render() {
    return html\`
      <section aria-label="Notes">
        <input aria-label="Note" .value=\${this.text} @input=\${(e: InputEvent) => (this.text = (e.target as HTMLInputElement).value)} />
        <button type="button" @click=\${this.add}>Save note</button>
        <ul aria-label="Saved notes">
          \${this.notes.map((n) => html\`<li>\${n}</li>\`)}
        </ul>
      </section>
    \`;
  }
}
`,
  converter: (bug) => `import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

@customElement('converter-feature')
export class ConverterFeature extends LitElement {
  @state() private celsius = '0';

  render() {
    const f = (Number(this.celsius) * 9) / 5 + ${bug ? 23 : 32};
    return html\`
      <section aria-label="Converter">
        <label for="celsius">Celsius</label>
        <input id="celsius" type="number" .value=\${this.celsius} @input=\${(e: InputEvent) => (this.celsius = (e.target as HTMLInputElement).value)} />
        <output data-testid="fahrenheit">\${Number.isFinite(f) ? f.toFixed(1) : '—'} °F</output>
      </section>
    \`;
  }
}
`,
  fetch: (bug, source) => `import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

type Product = { id: number; name: string; price: number };

@customElement('fetch-feature')
export class FetchFeature extends LitElement {
  @state() private items: Product[] | null = null;
  @state() private error = '';

  connectedCallback() {
    super.connectedCallback();
    fetch('${source}')
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((data: { products: Product[] }) => (this.items = data.${bug ? 'items' : 'products'}))
      .catch((e) => (this.error = String(e)));
  }

  render() {
    if (this.error) return html\`<p role="alert">Failed to load products: \${this.error}</p>\`;
    if (!this.items) return html\`<p>Loading…</p>\`;
    return html\`
      <section aria-label="Products">
        <ul>
          \${this.items.map((p) => html\`<li>\${p.name} — $\${p.price}</li>\`)}
        </ul>
      </section>
    \`;
  }
}
`,
  dates: (bug) => `import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { addDays, format } from 'date-fns';

const START = new Date(2025, 0, 30);

@customElement('dates-feature')
export class DatesFeature extends LitElement {
  render() {
    return html\`
      <section aria-label="Schedule">
        <p data-testid="due">Due \${format(addDays(START, ${bug ? 3 : 2}), 'EEEE, MMMM d')}</p>
      </section>
    \`;
  }
}
`,
};

export const KITS: Record<Kit, Record<CoreFeature, Source>> = { vue, svelte, solid, angular, lit };

/** The vanilla `dates` feature (Astro); the other vanilla features are in features.ts. */
export const vanillaDates = (bug: boolean) => `import { addDays, format } from 'date-fns';

const START = new Date(2025, 0, 30);

export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Schedule');
  const due = Object.assign(document.createElement('p'), { textContent: 'Due ' + format(addDays(START, ${bug ? 3 : 2}), 'EEEE, MMMM d') });
  due.dataset.testid = 'due';
  section.append(due);
  root.append(section);
}
`;
