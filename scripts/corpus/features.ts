/**
 * Building blocks for the synthetic fidelity corpus (ADR 0004). Each feature
 * is a small UI behavior as generated apps typically implement it, in React
 * and in vanilla TypeScript, plus the functional check that verifies it.
 * `bug: true` produces the variant with a seeded logic bug the check catches.
 */

export interface FeatureCode {
  /** React component source (default export named in `component`). */
  react?: (bug: boolean) => string;
  /** Vanilla TS source exporting `mount(root: HTMLElement)`. */
  vanilla?: (bug: boolean) => string;
  /** Body of the check function; `app` and `expect` are in scope. */
  check: string;
  /** Extra dependencies the React variant imports. */
  deps?: Record<string, string>;
  /** Extra files (path → contents), e.g. public data. */
  files?: (framework: string) => Record<string, string>;
  /** Only valid for these targets. */
  targets?: Target[];
}

export type Target = 'vite-react' | 'next-app' | 'next-pages' | 'vite-vanilla';

export const FEATURES: Record<string, FeatureCode> = {
  counter: {
    react: (bug) => `import { useState } from 'react';

export default function Counter() {
  const [count, setCount] = useState(0);
  return (
    <section aria-label="Counter">
      <p data-testid="count">Count: {count}</p>
      <button type="button" onClick={() => setCount((c) => c + ${bug ? 2 : 1})}>Increment</button>
      <button type="button" onClick={() => setCount(0)}>Reset</button>
    </section>
  );
}
`,
    vanilla: (bug) => `export function mount(root: HTMLElement) {
  let count = 0;
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Counter');
  section.innerHTML = '<p data-testid="count">Count: 0</p><button type="button">Increment</button><button type="button">Reset</button>';
  const [inc, reset] = section.querySelectorAll('button');
  const out = section.querySelector('[data-testid="count"]')!;
  inc.addEventListener('click', () => { count += ${bug ? 2 : 1}; out.textContent = 'Count: ' + count; });
  reset.addEventListener('click', () => { count = 0; out.textContent = 'Count: 0'; });
  root.append(section);
}
`,
    check: `const region = app.getByRole('region', { name: 'Counter' });
    await region.getByRole('button', { name: 'Increment' }).click();
    await region.getByRole('button', { name: 'Increment' }).click();
    await expect(region.getByTestId('count')).toHaveText('Count: 2');
    await region.getByRole('button', { name: 'Reset' }).click();
    await expect(region.getByTestId('count')).toHaveText('Count: 0');`,
  },

  todo: {
    react: (bug) => `import { useState } from 'react';

type Todo = { id: number; text: string; done: boolean };

export default function Todos() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [text, setText] = useState('');
  function add(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setTodos((t) => [...t, { id: t.length + 1, text: text.trim(), done: false }]);
    setText('');
  }
  return (
    <section aria-label="Todos">
      <form onSubmit={add}>
        <label htmlFor="todo-input">New todo</label>
        <input id="todo-input" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit">Add todo</button>
      </form>
      <ul aria-label="Todo list">
        {todos.map((t) => (
          <li key={t.id}>
            <label>
              <input type="checkbox" checked={t.done} onChange={() => setTodos((all) => all.map((x) => (x.id === t.id ? { ...x, done: ${bug ? 'x.done' : '!x.done'} } : x)))} />
              {t.text}
            </label>
          </li>
        ))}
      </ul>
      <p data-testid="remaining">{todos.filter((t) => !t.done).length} remaining</p>
    </section>
  );
}
`,
    vanilla: (bug) => `export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Todos');
  section.innerHTML = '<form><label for="todo-input">New todo</label><input id="todo-input"><button type="submit">Add todo</button></form><ul aria-label="Todo list"></ul><p data-testid="remaining">0 remaining</p>';
  const form = section.querySelector('form')!;
  const input = section.querySelector('input')!;
  const list = section.querySelector('ul')!;
  const remaining = section.querySelector('[data-testid="remaining"]')!;
  const update = () => { remaining.textContent = list.querySelectorAll('input:not(:checked)').length + ' remaining'; };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.addEventListener('change', ${bug ? '() => { box.checked = false; update(); }' : 'update'});
    label.append(box, input.value.trim());
    li.append(label);
    list.append(li);
    input.value = '';
    update();
  });
  root.append(section);
}
`,
    check: `const region = app.getByRole('region', { name: 'Todos' });
    await region.getByLabel('New todo').fill('Buy milk');
    await region.getByRole('button', { name: 'Add todo' }).click();
    await region.getByLabel('New todo').fill('Walk dog');
    await region.getByRole('button', { name: 'Add todo' }).click();
    await expect(region.getByRole('listitem')).toHaveCount(2);
    await region.getByRole('checkbox', { name: 'Buy milk' }).check();
    await expect(region.getByTestId('remaining')).toHaveText('1 remaining');`,
  },

  search: {
    react: (bug) => `import { useMemo, useState } from 'react';

const FRUITS = ['Apple', 'Apricot', 'Banana', 'Blueberry', 'Cherry', 'Grape', 'Mango'];

export default function Search() {
  const [q, setQ] = useState('');
  const shown = useMemo(() => FRUITS.filter((f) => ${bug ? 'f.includes(q)' : 'f.toLowerCase().includes(q.toLowerCase())'}), [q]);
  return (
    <section aria-label="Search">
      <input type="search" aria-label="Search fruits" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul aria-label="Results">{shown.map((f) => <li key={f}>{f}</li>)}</ul>
    </section>
  );
}
`,
    vanilla: (bug) => `const FRUITS = ['Apple', 'Apricot', 'Banana', 'Blueberry', 'Cherry', 'Grape', 'Mango'];
export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Search');
  section.innerHTML = '<input type="search" aria-label="Search fruits"><ul aria-label="Results"></ul>';
  const input = section.querySelector('input')!;
  const list = section.querySelector('ul')!;
  const render = () => {
    const q = input.value;
    list.replaceChildren(...FRUITS.filter((f) => ${bug ? 'f.includes(q)' : 'f.toLowerCase().includes(q.toLowerCase())'}).map((f) => Object.assign(document.createElement('li'), { textContent: f })));
  };
  input.addEventListener('input', render);
  render();
  root.append(section);
}
`,
    check: `const region = app.getByRole('region', { name: 'Search' });
    await expect(region.getByRole('listitem')).toHaveCount(7);
    await region.getByRole('searchbox', { name: 'Search fruits' }).fill('ap');
    await expect(region.getByRole('listitem')).toHaveText(['Apple', 'Apricot', 'Grape']);`,
  },

  tabs: {
    react: (bug) => `import { useState } from 'react';

const TABS = [
  { id: 'overview', label: 'Overview', body: 'Project overview' },
  { id: 'specs', label: 'Specs', body: 'Technical specs' },
  { id: 'reviews', label: 'Reviews', body: 'Customer reviews' },
];

export default function Tabs() {
  const [active, setActive] = useState('overview');
  const tab = TABS.find((t) => t.id === active)!;
  return (
    <section aria-label="Details">
      <div role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === active} onClick={() => setActive(${bug ? "'overview'" : 't.id'})}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel">{tab.body}</div>
    </section>
  );
}
`,
    vanilla: (bug) => `const TABS = [['Overview', 'Project overview'], ['Specs', 'Technical specs'], ['Reviews', 'Customer reviews']];
export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Details');
  const list = document.createElement('div');
  list.setAttribute('role', 'tablist');
  const panel = document.createElement('div');
  panel.setAttribute('role', 'tabpanel');
  const select = (i: number) => {
    list.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
    panel.textContent = TABS[i][1];
  };
  TABS.forEach(([label], i) => {
    const b = Object.assign(document.createElement('button'), { textContent: label });
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => select(${bug ? '0' : 'i'}));
    list.append(b);
  });
  section.append(list, panel);
  select(0);
  root.append(section);
}
`,
    check: `const region = app.getByRole('region', { name: 'Details' });
    await expect(region.getByRole('tabpanel')).toHaveText('Project overview');
    await region.getByRole('tab', { name: 'Specs' }).click();
    await expect(region.getByRole('tabpanel')).toHaveText('Technical specs');
    await expect(region.getByRole('tab', { name: 'Specs' })).toHaveAttribute('aria-selected', 'true');`,
  },

  form: {
    react: (bug) => `import { useState } from 'react';

export default function SignupForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$/i.test(email)) { setError('Please enter a valid email'); ${bug ? 'setDone(true); ' : ''}return; }
    setError('');
    setDone(true);
  }
  return (
    <section aria-label="Signup">
      {done ? <p role="status">Thanks for signing up!</p> : null}
      <form onSubmit={submit} noValidate>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit">Sign up</button>
      </form>
    </section>
  );
}
`,
    vanilla: (bug) => `export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Signup');
  section.innerHTML = '<form novalidate><label for="email">Email</label><input id="email" type="email"><button type="submit">Sign up</button></form>';
  const form = section.querySelector('form')!;
  const input = section.querySelector('input')!;
  const show = (role: string, text: string) => {
    section.querySelector('[role="' + role + '"]')?.remove();
    const p = Object.assign(document.createElement('p'), { textContent: text });
    p.setAttribute('role', role);
    role === 'alert' ? form.insertBefore(p, form.lastElementChild) : section.prepend(p);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!/^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$/i.test(input.value)) { show('alert', 'Please enter a valid email'); ${bug ? "show('status', 'Thanks for signing up!'); " : ''}return; }
    section.querySelector('[role="alert"]')?.remove();
    show('status', 'Thanks for signing up!');
  });
  root.append(section);
}
`,
    check: `const region = app.getByRole('region', { name: 'Signup' });
    await region.getByLabel('Email').fill('not-an-email');
    await region.getByRole('button', { name: 'Sign up' }).click();
    await expect(region.getByRole('alert')).toHaveText('Please enter a valid email');
    await expect(region.getByRole('status')).toHaveCount(0);
    await region.getByLabel('Email').fill('ada@example.com');
    await region.getByRole('button', { name: 'Sign up' }).click();
    await expect(region.getByRole('status')).toHaveText('Thanks for signing up!');`,
  },

  modal: {
    react: (bug) => `import { useState } from 'react';

export default function ModalDemo() {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Modal demo">
      <button type="button" onClick={() => setOpen(true)}>Open settings</button>
      {open ? (
        <div role="dialog" aria-label="Settings" aria-modal="true">
          <p>Settings go here.</p>
          <button type="button" onClick={() => setOpen(${bug ? 'true' : 'false'})}>Close</button>
        </div>
      ) : null}
    </section>
  );
}
`,
    vanilla: (bug) => `export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Modal demo');
  section.innerHTML = '<button type="button">Open settings</button><div role="dialog" aria-label="Settings" aria-modal="true" hidden><p>Settings go here.</p><button type="button">Close</button></div>';
  const [open, close] = section.querySelectorAll('button');
  const dialog = section.querySelector('[role="dialog"]') as HTMLElement;
  open.addEventListener('click', () => { dialog.hidden = false; });
  close.addEventListener('click', () => { dialog.hidden = ${bug ? 'false' : 'true'}; });
  root.append(section);
}
`,
    check: `const region = app.getByRole('region', { name: 'Modal demo' });
    await expect(region.getByRole('dialog')).toBeHidden();
    await region.getByRole('button', { name: 'Open settings' }).click();
    await expect(region.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await region.getByRole('button', { name: 'Close' }).click();
    await expect(region.getByRole('dialog')).toBeHidden();`,
  },

  /** A modal toggled with Tailwind's `hidden` utility: only works when Tailwind actually runs. */
  'tailwind-modal': {
    react: (bug) => `import { useState } from 'react';

export default function Drawer() {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Drawer demo" className="p-4">
      <button type="button" className="rounded bg-blue-600 px-3 py-1 text-white" onClick={() => setOpen(true)}>Show menu</button>
      <nav aria-label="Menu" className={open ? 'block border p-2' : 'hidden'}>
        <a href="#home">Home</a>
        <button type="button" onClick={() => setOpen(${bug ? 'true' : 'false'})}>Hide menu</button>
      </nav>
    </section>
  );
}
`,
    check: `const region = app.getByRole('region', { name: 'Drawer demo' });
    await expect(region.getByRole('navigation', { name: 'Menu' })).toBeHidden();
    await region.getByRole('button', { name: 'Show menu' }).click();
    await expect(region.getByRole('navigation', { name: 'Menu' })).toBeVisible();
    await region.getByRole('button', { name: 'Hide menu' }).click();
    await expect(region.getByRole('navigation', { name: 'Menu' })).toBeHidden();`,
    targets: ['vite-react', 'next-app', 'next-pages'],
  },

  persist: {
    react: (bug) => `import { useEffect, useState } from 'react';

export default function Notes() {
  const [notes, setNotes] = useState<string[]>([]);
  const [text, setText] = useState('');
  useEffect(() => {
    const saved = localStorage.getItem('notes');
    if (saved) setNotes(JSON.parse(saved));
  }, []);
  function add() {
    const next = [...notes, text];
    setNotes(next);
    ${bug ? '' : "localStorage.setItem('notes', JSON.stringify(next));"}
    setText('');
  }
  return (
    <section aria-label="Notes">
      <input aria-label="Note" value={text} onChange={(e) => setText(e.target.value)} />
      <button type="button" onClick={add}>Save note</button>
      <ul aria-label="Saved notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
    </section>
  );
}
`,
    vanilla: (bug) => `export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Notes');
  section.innerHTML = '<input aria-label="Note"><button type="button">Save note</button><ul aria-label="Saved notes"></ul>';
  const input = section.querySelector('input')!;
  const list = section.querySelector('ul')!;
  let notes: string[] = JSON.parse(localStorage.getItem('notes') ?? '[]');
  const render = () => list.replaceChildren(...notes.map((n) => Object.assign(document.createElement('li'), { textContent: n })));
  section.querySelector('button')!.addEventListener('click', () => {
    notes = [...notes, input.value];
    ${bug ? '' : "localStorage.setItem('notes', JSON.stringify(notes));"}
    input.value = '';
    render();
  });
  render();
  root.append(section);
}
`,
    check: `await app.getByRole('textbox', { name: 'Note', exact: true }).fill('Remember me');
    await app.getByRole('button', { name: 'Save note' }).click();
    await expect(app.getByRole('list', { name: 'Saved notes' }).getByRole('listitem')).toHaveText(['Remember me']);
    await app.goto(app.url());
    await expect(app.getByRole('list', { name: 'Saved notes' }).getByRole('listitem')).toHaveText(['Remember me'], { timeout: 15000 });`,
  },

  converter: {
    react: (bug) => `import { useState } from 'react';

export default function Converter() {
  const [c, setC] = useState('0');
  const f = (Number(c) * 9) / 5 + ${bug ? '23' : '32'};
  return (
    <section aria-label="Converter">
      <label htmlFor="celsius">Celsius</label>
      <input id="celsius" type="number" value={c} onChange={(e) => setC(e.target.value)} />
      <output data-testid="fahrenheit">{Number.isFinite(f) ? f.toFixed(1) : '—'} °F</output>
    </section>
  );
}
`,
    vanilla: (bug) => `export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Converter');
  section.innerHTML = '<label for="celsius">Celsius</label><input id="celsius" type="number" value="0"><output data-testid="fahrenheit">32.0 °F</output>';
  const input = section.querySelector('input')!;
  const out = section.querySelector('output')!;
  input.addEventListener('input', () => { out.textContent = ((Number(input.value) * 9) / 5 + ${bug ? '23' : '32'}).toFixed(1) + ' °F'; });
  root.append(section);
}
`,
    check: `const region = app.getByRole('region', { name: 'Converter' });
    await region.getByLabel('Celsius').fill('100');
    await expect(region.getByTestId('fahrenheit')).toHaveText('212.0 °F');`,
  },

  /** Loads JSON: from public/ (Vite) or from a route handler (Next.js). */
  fetch: {
    react: (bug) => `import { useEffect, useState } from 'react';

type Product = { id: number; name: string; price: number };

export default function Products({ source }: { source: string }) {
  const [items, setItems] = useState<Product[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(source)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((data: { products: Product[] }) => setItems(data.${bug ? 'items' : 'products'}))
      .catch((e) => setError(String(e)));
  }, [source]);
  if (error) return <p role="alert">Failed to load products: {error}</p>;
  if (!items) return <p>Loading…</p>;
  return (
    <section aria-label="Products">
      <ul>{items.map((p) => <li key={p.id}>{p.name} — \${p.price}</li>)}</ul>
    </section>
  );
}
`,
    vanilla: (bug) => `export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Products');
  section.innerHTML = '<p>Loading…</p>';
  root.append(section);
  fetch('/data/products.json')
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((data) => {
      const ul = document.createElement('ul');
      for (const p of data.${bug ? 'items' : 'products'}) ul.append(Object.assign(document.createElement('li'), { textContent: p.name + ' — $' + p.price }));
      section.replaceChildren(ul);
    })
    .catch((e) => { section.innerHTML = ''; const p = Object.assign(document.createElement('p'), { textContent: 'Failed to load products: ' + e }); p.setAttribute('role', 'alert'); section.append(p); });
}
`,
    check: `const region = app.getByRole('region', { name: 'Products' });
    await expect(region.getByRole('listitem')).toHaveText(['Lamp — $25', 'Chair — $80', 'Desk — $150']);`,
    files: (framework) => {
      const data = JSON.stringify({ products: [{ id: 1, name: 'Lamp', price: 25 }, { id: 2, name: 'Chair', price: 80 }, { id: 3, name: 'Desk', price: 150 }] }, null, 2);
      if (framework === 'next-app') {
        return { 'app/api/products/route.ts': `import { NextResponse } from 'next/server';\n\nconst DATA = ${data};\n\nexport async function GET() {\n  return NextResponse.json(DATA);\n}\n` };
      }
      if (framework === 'next-pages') {
        return { 'pages/api/products.ts': `import type { NextApiRequest, NextApiResponse } from 'next';\n\nconst DATA = ${data};\n\nexport default function handler(_req: NextApiRequest, res: NextApiResponse) {\n  res.status(200).json(DATA);\n}\n` };
      }
      return { 'public/data/products.json': data + '\n' };
    },
  },

  /** date-fns: a very common utility dependency. */
  dates: {
    deps: { 'date-fns': '^4.1.0' },
    react: (bug) => `import { addDays, format } from 'date-fns';

const START = new Date(2025, 0, 30);

export default function Schedule() {
  return (
    <section aria-label="Schedule">
      <p data-testid="due">Due {format(addDays(START, ${bug ? 3 : 2}), 'EEEE, MMMM d')}</p>
    </section>
  );
}
`,
    check: `await expect(app.getByRole('region', { name: 'Schedule' }).getByTestId('due')).toHaveText('Due Saturday, February 1');`,
    targets: ['vite-react', 'next-app', 'next-pages'],
  },

  /** zustand store shared by two components. */
  store: {
    deps: { zustand: '^5.0.3' },
    react: (bug) => `import { create } from 'zustand';

type Cart = { items: string[]; add: (item: string) => void };
const useCart = create<Cart>((set) => ({ items: [], add: (item) => set((s) => ({ items: ${bug ? '[item]' : '[...s.items, item]'} })) }));

function CartBadge() {
  const count = useCart((s) => s.items.length);
  return <span data-testid="cart-count">{count} in cart</span>;
}

export default function Shop() {
  const add = useCart((s) => s.add);
  return (
    <section aria-label="Shop">
      <CartBadge />
      <button type="button" onClick={() => add('Tea')}>Add tea</button>
      <button type="button" onClick={() => add('Coffee')}>Add coffee</button>
    </section>
  );
}
`,
    check: `const region = app.getByRole('region', { name: 'Shop' });
    await region.getByRole('button', { name: 'Add tea' }).click();
    await region.getByRole('button', { name: 'Add coffee' }).click();
    await expect(region.getByTestId('cart-count')).toHaveText('2 in cart');`,
    targets: ['vite-react', 'next-app', 'next-pages'],
  },

  /** lucide-react icons + clsx class names. */
  icons: {
    deps: { 'lucide-react': '^0.468.0', clsx: '^2.1.1' },
    react: (bug) => `import { useState } from 'react';
import { Heart } from 'lucide-react';
import clsx from 'clsx';

export default function LikeButton() {
  const [liked, setLiked] = useState(false);
  return (
    <section aria-label="Likes">
      <button type="button" aria-pressed={liked} className={clsx('like', liked && 'liked')} onClick={() => setLiked(${bug ? 'liked' : '!liked'})}>
        <Heart aria-hidden="true" size={16} /> Like
      </button>
    </section>
  );
}
`,
    check: `const button = app.getByRole('region', { name: 'Likes' }).getByRole('button', { name: 'Like' });
    await expect(button.locator('svg')).toHaveCount(1);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(button).toHaveClass(/liked/);`,
    targets: ['vite-react', 'next-app', 'next-pages'],
  },

  /** Client-side routing with react-router-dom (Vite React only). */
  router: {
    deps: { 'react-router-dom': '^6.28.0' },
    react: (bug) => `import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';

export default function Pages() {
  return (
    <BrowserRouter>
      <nav aria-label="Site">
        <Link to="/">Home</Link> <Link to="${bug ? '/abuot' : '/about'}">About</Link>
      </nav>
      <Routes>
        <Route path="/" element={<h2>Welcome home</h2>} />
        <Route path="/about" element={<h2>About us</h2>} />
        <Route path="*" element={<h2>Not found</h2>} />
      </Routes>
    </BrowserRouter>
  );
}
`,
    check: `await expect(app.getByRole('heading', { level: 2, name: 'Welcome home' })).toBeVisible();
    await app.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'About' }).click();
    await expect(app.getByRole('heading', { level: 2, name: 'About us' })).toBeVisible();`,
    targets: ['vite-react'],
  },
};
