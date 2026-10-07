const form = document.getElementById('note-form');
const titleInput = document.getElementById('title');
const bodyInput = document.getElementById('body');
const saveBtn = document.getElementById('save-btn');
const formError = document.getElementById('form-error');
const searchInput = document.getElementById('search');
const list = document.getElementById('notes');
const empty = document.getElementById('empty');
const count = document.getElementById('count');

let notes = [];

function showError(msg) {
  formError.textContent = msg;
  formError.hidden = !msg;
}

// Append text to an element, wrapping case-insensitive matches of `q` in <mark>.
function appendHighlighted(el, text, q) {
  if (!q) {
    el.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const at = lower.indexOf(q, i);
    if (at === -1) {
      el.append(text.slice(i));
      break;
    }
    if (at > i) el.append(text.slice(i, at));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(at, at + q.length);
    el.append(mark);
    i = at + q.length;
  }
}

function formatDate(sqlDate) {
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  const visible = q
    ? notes.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
    : notes;

  list.replaceChildren(
    ...visible.map((note) => {
      const li = document.createElement('li');
      li.className = 'note';

      const title = document.createElement('h3');
      title.className = 'note-title';
      if (note.title) appendHighlighted(title, note.title, q);
      else {
        title.textContent = 'Untitled';
        title.classList.add('untitled');
      }

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-delete';
      del.textContent = '×';
      del.setAttribute('aria-label', `Delete note: ${note.title || 'Untitled'}`);
      del.title = 'Delete note';
      del.addEventListener('click', () => deleteNote(note.id));

      li.append(title, del);

      if (note.body) {
        const body = document.createElement('p');
        body.className = 'note-body';
        appendHighlighted(body, note.body, q);
        li.append(body);
      }

      const date = document.createElement('time');
      date.className = 'note-date';
      date.dateTime = note.created_at;
      date.textContent = formatDate(note.created_at);
      li.append(date);

      return li;
    }),
  );

  if (notes.length === 0) {
    empty.textContent = 'No notes yet. Write your first one!';
    empty.hidden = false;
  } else if (visible.length === 0) {
    empty.textContent = `No notes match “${searchInput.value.trim()}”.`;
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }

  count.textContent = q
    ? `${visible.length} of ${notes.length}`
    : `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`;
}

async function loadNotes() {
  try {
    const res = await fetch('/api/notes');
    if (!res.ok) throw new Error();
    notes = await res.json();
  } catch {
    notes = [];
    empty.textContent = 'Could not load notes.';
  }
  render();
}

async function deleteNote(id) {
  const res = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
  if (res.ok || res.status === 404) {
    notes = notes.filter((n) => n.id !== id);
    render();
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = titleInput.value.trim();
  const body = bodyInput.value.trim();
  if (!title && !body) {
    showError('Add a title or a body first.');
    titleInput.focus();
    return;
  }
  showError('');
  saveBtn.disabled = true;
  try {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save note.');
    notes.unshift(data);
    form.reset();
    render();
    titleInput.focus();
  } catch (err) {
    showError(err.message || 'Could not save note.');
  } finally {
    saveBtn.disabled = false;
  }
});

searchInput.addEventListener('input', render);

loadNotes();
