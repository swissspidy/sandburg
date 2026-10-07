const form = document.getElementById('sign-form');
const nameInput = document.getElementById('name');
const messageInput = document.getElementById('message');
const errorEl = document.getElementById('error');
const button = document.getElementById('sign-button');
const list = document.getElementById('entries');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');

let entries = [];

function showError(text) {
  errorEl.textContent = text;
  errorEl.hidden = false;
  messageInput.setAttribute('aria-invalid', 'true');
}

function clearError() {
  errorEl.textContent = '';
  errorEl.hidden = true;
  messageInput.removeAttribute('aria-invalid');
}

function formatDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function initial(name) {
  return (name.trim()[0] || '?').toUpperCase();
}

function render() {
  list.replaceChildren(
    ...entries.map((entry) => {
      const li = document.createElement('li');
      li.className = 'entry';

      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = initial(entry.name);

      const body = document.createElement('div');
      body.className = 'entry-body';

      const meta = document.createElement('div');
      meta.className = 'entry-meta';
      const name = document.createElement('strong');
      name.className = 'entry-name';
      name.textContent = entry.name;
      const time = document.createElement('time');
      time.dateTime = entry.createdAt;
      time.textContent = formatDate(entry.createdAt);
      meta.append(name, time);

      const message = document.createElement('p');
      message.className = 'entry-message';
      message.textContent = entry.message;

      body.append(meta, message);
      li.append(avatar, body);
      return li;
    })
  );
  emptyEl.hidden = entries.length > 0;
  countEl.textContent = entries.length ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}` : '';
}

async function load() {
  try {
    const res = await fetch('/api/entries');
    if (!res.ok) throw new Error();
    entries = await res.json();
  } catch {
    entries = [];
    showError('Could not load entries. Please refresh the page.');
  }
  render();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const message = messageInput.value.trim();

  if (!message) {
    showError('Please write a message before signing.');
    messageInput.focus();
    return;
  }

  clearError();
  button.disabled = true;
  try {
    const res = await fetch('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(data.error || 'Something went wrong. Please try again.');
      return;
    }
    entries.unshift(data);
    render();
    form.reset();
    nameInput.focus();
  } catch {
    showError('Network error. Please try again.');
  } finally {
    button.disabled = false;
  }
});

messageInput.addEventListener('input', () => {
  if (!errorEl.hidden && messageInput.value.trim()) clearError();
});

load();
