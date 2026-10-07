const form = document.getElementById('new-task-form');
const input = document.getElementById('new-task');
const prioritySelect = document.getElementById('priority');
const list = document.getElementById('tasks');
const empty = document.getElementById('empty');
const summary = document.getElementById('summary');
const errorEl = document.getElementById('error');

const PRIORITY_RANK = { high: 2, normal: 1, low: 0 };
const PRIORITY_LABEL = { high: 'High', normal: 'Normal', low: 'Low' };

let tasks = [];

function sortTasks() {
  tasks.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.id - b.id);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

function showError(err) {
  errorEl.textContent = err ? err.message || String(err) : '';
  errorEl.hidden = !err;
}

const trashIcon = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>`;

function render() {
  list.replaceChildren(
    ...tasks.map((task) => {
      const li = document.createElement('li');
      li.className = 'task' + (task.done ? ' done' : '');

      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = task.done;
      box.addEventListener('change', () => toggle(task, box.checked));
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = task.text;
      label.append(box, text);

      const badge = document.createElement('span');
      badge.className = `priority priority-${task.priority}`;
      badge.textContent = PRIORITY_LABEL[task.priority];

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'delete';
      del.setAttribute('aria-label', `Delete ${task.text}`);
      del.title = 'Delete';
      del.innerHTML = trashIcon;
      del.addEventListener('click', () => remove(task));

      li.append(label, badge, del);
      return li;
    })
  );

  empty.hidden = tasks.length > 0;
  list.hidden = tasks.length === 0;
  const remaining = tasks.filter((t) => !t.done).length;
  summary.textContent = tasks.length ? `${remaining} of ${tasks.length} remaining` : '';
}

async function load() {
  try {
    tasks = await api('/api/tasks');
    sortTasks();
    showError(null);
  } catch (err) {
    showError(err);
  }
  render();
}

async function toggle(task, done) {
  try {
    const updated = await api(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ done }),
    });
    tasks = tasks.map((t) => (t.id === task.id ? updated : t));
    showError(null);
  } catch (err) {
    showError(err);
  }
  render();
}

async function remove(task) {
  try {
    await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
    tasks = tasks.filter((t) => t.id !== task.id);
    showError(null);
    render();
    input.focus();
  } catch (err) {
    showError(err);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) {
    input.value = '';
    input.focus();
    return;
  }
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ text, priority: prioritySelect.value }),
    });
    tasks.push(task);
    sortTasks();
    input.value = '';
    showError(null);
    render();
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
    input.focus();
  }
});

load();
