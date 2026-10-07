import { Component, computed, signal } from '@angular/core';

interface Note {
  id: number;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: string;
}

@Component({
  selector: 'app-root',
  template: `
    <main class="page">
      <header class="header">
        <h1><span aria-hidden="true">🗒️</span> Notes</h1>
        <p class="subtitle">Jot it down, find it later.</p>
      </header>

      <section class="card" aria-labelledby="new-note-heading">
        <h2 id="new-note-heading">New note</h2>
        <form (submit)="save($event)" novalidate>
          <div class="field">
            <label for="note-title">Title</label>
            <input
              id="note-title"
              type="text"
              maxlength="200"
              autocomplete="off"
              [value]="title()"
              (input)="title.set(valueOf($event))"
              placeholder="What's this about?"
            />
          </div>
          <div class="field">
            <label for="note-body">Body</label>
            <textarea
              id="note-body"
              rows="4"
              maxlength="10000"
              [value]="body()"
              (input)="body.set(valueOf($event))"
              placeholder="Write your note…"
            ></textarea>
          </div>
          @if (error()) {
            <p class="error" role="alert">{{ error() }}</p>
          }
          <div class="actions">
            <button type="submit" class="primary" [disabled]="saving()">
              {{ saving() ? 'Saving…' : 'Save note' }}
            </button>
          </div>
        </form>
      </section>

      <section class="list-section" aria-labelledby="notes-heading">
        <div class="list-head">
          <h2 id="notes-heading">
            Your notes <span class="count">{{ notes().length }}</span>
          </h2>
          <div class="search">
            <label for="note-search">Search</label>
            <input
              id="note-search"
              type="search"
              autocomplete="off"
              [value]="query()"
              (input)="query.set(valueOf($event))"
              placeholder="Filter by title or body"
            />
          </div>
        </div>

        <ul class="notes" aria-label="Notes">
          @for (note of filtered(); track note.id) {
            <li class="note" [class.pinned]="note.pinned">
              <div class="note-main">
                <h3 class="note-title">
                  @if (note.pinned) {
                    <span class="pin-badge">Pinned</span>
                  }
                  {{ note.title }}
                </h3>
                @if (note.body) {
                  <p class="note-body">{{ note.body }}</p>
                }
                <time class="note-date" [attr.datetime]="note.createdAt">{{ formatDate(note.createdAt) }}</time>
              </div>
              <div class="note-actions">
                <button
                  type="button"
                  class="icon-btn pin"
                  [class.active]="note.pinned"
                  (click)="togglePin(note)"
                  [attr.aria-label]="(note.pinned ? 'Unpin ' : 'Pin ') + note.title"
                  [title]="note.pinned ? 'Unpin note' : 'Pin note'"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      [attr.fill]="note.pinned ? 'currentColor' : 'none'"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linejoin="round"
                      d="M9 3h6l-1 6 4 4H6l4-4z"
                    />
                    <path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 13v8" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="icon-btn delete"
                  (click)="remove(note)"
                  [attr.aria-label]="'Delete note ' + note.title"
                  title="Delete note"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"
                    />
                  </svg>
                </button>
              </div>
            </li>
          }
        </ul>

        @if (loading()) {
          <p class="empty">Loading notes…</p>
        } @else if (notes().length === 0) {
          <div class="empty">
            <p class="empty-icon" aria-hidden="true">✍️</p>
            <p>No notes yet. Write your first one above.</p>
          </div>
        } @else if (filtered().length === 0) {
          <p class="empty">No notes match “{{ query() }}”.</p>
        }
      </section>
    </main>
  `,
  styles: `
    :host {
      --bg: light-dark(#f6f5f1, #16171a);
      --card: light-dark(#ffffff, #212226);
      --text: light-dark(#1f2328, #e8e8ea);
      --muted: light-dark(#667085, #9a9ca5);
      --border: light-dark(#e3e1da, #34363c);
      --accent: light-dark(#4f46e5, #8b85ff);
      --accent-hover: light-dark(#4338ca, #a39eff);
      --pin: light-dark(#b45309, #fbbf24);
      --danger: light-dark(#c62828, #ff7a7a);
      display: block;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }
    .page {
      max-width: 760px;
      margin: 0 auto;
      padding: 2rem 1.25rem 3rem;
    }
    .header h1 {
      margin: 0;
      font-size: 1.9rem;
      letter-spacing: -0.02em;
    }
    .subtitle {
      margin: 0.25rem 0 1.5rem;
      color: var(--muted);
    }
    h2 {
      font-size: 1.05rem;
      margin: 0 0 1rem;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1.25rem;
      box-shadow: 0 1px 3px rgb(0 0 0 / 0.05);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      margin-bottom: 0.9rem;
    }
    label {
      font-size: 0.85rem;
      font-weight: 600;
    }
    input,
    textarea {
      font: inherit;
      color: inherit;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.6rem 0.75rem;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    textarea {
      resize: vertical;
      min-height: 5rem;
    }
    input:focus-visible,
    textarea:focus-visible {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
    }
    .actions {
      display: flex;
      justify-content: flex-end;
    }
    button {
      font: inherit;
      cursor: pointer;
    }
    .primary {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 0.6rem 1.2rem;
      font-weight: 600;
      transition: background 0.15s;
    }
    .primary:hover:not(:disabled) {
      background: var(--accent-hover);
    }
    .primary:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .primary:focus-visible,
    .icon-btn:focus-visible {
      outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent);
      outline-offset: 2px;
    }
    .error {
      color: var(--danger);
      margin: 0 0 0.75rem;
      font-size: 0.9rem;
    }
    .list-section {
      margin-top: 2rem;
    }
    .list-head {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 1rem;
    }
    .list-head h2 {
      margin: 0;
    }
    .count {
      display: inline-block;
      min-width: 1.5rem;
      padding: 0.1rem 0.45rem;
      margin-left: 0.3rem;
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent);
      font-size: 0.8rem;
      text-align: center;
    }
    .search {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      flex: 1 1 220px;
      max-width: 320px;
    }
    .notes {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.75rem;
    }
    .note {
      display: flex;
      gap: 0.75rem;
      align-items: flex-start;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1rem 1.1rem;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .note:hover {
      border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
      box-shadow: 0 2px 8px rgb(0 0 0 / 0.06);
    }
    .note.pinned {
      border-color: color-mix(in srgb, var(--pin) 45%, var(--border));
      background: color-mix(in srgb, var(--pin) 5%, var(--card));
    }
    .note-main {
      flex: 1;
      min-width: 0;
    }
    .note-title {
      margin: 0;
      font-size: 1rem;
      overflow-wrap: anywhere;
    }
    .pin-badge {
      display: inline-block;
      vertical-align: 0.1em;
      margin-right: 0.4rem;
      padding: 0.05rem 0.45rem;
      border-radius: 999px;
      background: color-mix(in srgb, var(--pin) 15%, transparent);
      color: var(--pin);
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .note-body {
      margin: 0.35rem 0 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.5;
    }
    .note-date {
      display: block;
      margin-top: 0.5rem;
      font-size: 0.78rem;
      color: var(--muted);
    }
    .note-actions {
      flex: none;
      display: flex;
      gap: 0.25rem;
    }
    .icon-btn {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: var(--muted);
      transition: color 0.15s, background 0.15s;
    }
    .pin:hover,
    .pin.active {
      color: var(--pin);
    }
    .pin:hover {
      background: color-mix(in srgb, var(--pin) 12%, transparent);
    }
    .delete:hover {
      color: var(--danger);
      background: color-mix(in srgb, var(--danger) 12%, transparent);
    }
    .empty {
      text-align: center;
      color: var(--muted);
      padding: 2rem 1rem;
      border: 1px dashed var(--border);
      border-radius: 12px;
      margin: 0;
    }
    .empty p {
      margin: 0;
    }
    .empty-icon {
      font-size: 2rem;
      margin-bottom: 0.5rem !important;
    }
    @media (max-width: 520px) {
      .search {
        max-width: none;
      }
      .primary {
        width: 100%;
      }
    }
  `,
})
export class App {
  // Kept in base order (newest first); pinned-first ordering is applied in `sorted`.
  protected readonly notes = signal<Note[]>([]);
  protected readonly title = signal('');
  protected readonly body = signal('');
  protected readonly query = signal('');
  protected readonly error = signal('');
  protected readonly saving = signal(false);
  protected readonly loading = signal(true);

  private readonly sorted = computed(() => {
    const all = this.notes();
    return [...all.filter((n) => n.pinned), ...all.filter((n) => !n.pinned)];
  });

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const all = this.sorted();
    if (!q) return all;
    return all.filter(
      (n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q),
    );
  });

  constructor() {
    this.load();
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected formatDate(value: string): string {
    const d = new Date(value.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime())
      ? value
      : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch('/api/notes');
      if (!res.ok) throw new Error();
      const data = (await res.json()) as Note[];
      this.notes.set([...data].sort((a, b) => b.id - a.id));
    } catch {
      this.error.set('Could not load notes.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const title = this.title().trim();
    const body = this.body().trim();
    if (!title) {
      this.error.set('Please enter a title.');
      return;
    }
    this.error.set('');
    this.saving.set(true);
    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save note.');
      this.notes.update((list) => [data as Note, ...list]);
      this.title.set('');
      this.body.set('');
    } catch (e) {
      this.error.set(e instanceof Error && e.message ? e.message : 'Could not save note.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async togglePin(note: Note): Promise<void> {
    const pinned = !note.pinned;
    const setPinned = (value: boolean) =>
      this.notes.update((list) =>
        list.map((n) => (n.id === note.id ? { ...n, pinned: value } : n)),
      );
    setPinned(pinned);
    try {
      const res = await fetch(`/api/notes/${note.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setPinned(!pinned);
      this.error.set('Could not update note.');
    }
  }

  protected async remove(note: Note): Promise<void> {
    const previous = this.notes();
    this.notes.update((list) => list.filter((n) => n.id !== note.id));
    try {
      const res = await fetch(`/api/notes/${note.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error();
    } catch {
      this.notes.set(previous);
      this.error.set('Could not delete note.');
    }
  }
}
