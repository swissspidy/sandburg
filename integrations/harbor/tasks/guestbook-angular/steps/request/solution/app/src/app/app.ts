import { Component, signal } from '@angular/core';

interface Entry {
  id: number;
  name: string;
  message: string;
  createdAt: string;
}

@Component({
  selector: 'app-root',
  template: `
    <main class="page">
      <header class="hero">
        <span class="logo" aria-hidden="true">📖</span>
        <div>
          <h1>Guestbook</h1>
          <p class="sub">Leave a note for everyone who stops by.</p>
        </div>
      </header>

      <section class="card" aria-labelledby="sign-heading">
        <h2 id="sign-heading">Sign the guestbook</h2>
        <form (submit)="sign($event)" novalidate>
          <div class="field">
            <label for="name">Name</label>
            <input
              id="name"
              #nameInput
              type="text"
              maxlength="80"
              autocomplete="name"
              placeholder="Your name (optional)"
              [value]="name()"
              (input)="name.set(nameInput.value)"
            />
          </div>
          <div class="field">
            <label for="message">Message</label>
            <textarea
              id="message"
              #messageInput
              rows="4"
              maxlength="1000"
              placeholder="Say hello…"
              [value]="message()"
              [attr.aria-invalid]="error() ? 'true' : null"
              [attr.aria-describedby]="error() ? 'form-error' : null"
              (input)="message.set(messageInput.value); error.set('')"
            ></textarea>
          </div>
          @if (error()) {
            <p id="form-error" class="error" role="alert">{{ error() }}</p>
          }
          <div class="actions">
            <button type="submit" [disabled]="saving()">
              {{ saving() ? 'Signing…' : 'Sign' }}
            </button>
          </div>
        </form>
      </section>

      <section class="entries" aria-labelledby="entries-heading">
        <h2 id="entries-heading">
          Entries
          @if (entries().length) {
            <span class="count">{{ entries().length }}</span>
          }
        </h2>
        @if (loadError()) {
          <p class="error" role="alert">{{ loadError() }}</p>
        }
        <ul class="list" aria-label="Entries">
          @for (entry of entries(); track entry.id) {
            <li class="entry">
              <span class="avatar" aria-hidden="true">{{ initial(entry.name) }}</span>
              <div class="body">
                <div class="meta">
                  <strong class="name">{{ entry.name }}</strong>
                  <time [attr.datetime]="entry.createdAt">{{ formatDate(entry.createdAt) }}</time>
                </div>
                <p class="message">{{ entry.message }}</p>
              </div>
            </li>
          }
        </ul>
        @if (loaded() && !entries().length && !loadError()) {
          <div class="empty">
            <span aria-hidden="true">✍️</span>
            <p>No entries yet. Be the first to sign!</p>
          </div>
        }
      </section>
    </main>
  `,
  styles: `
    :host { display: block; }
    .page {
      max-width: 680px;
      margin: 0 auto;
      padding: 32px 20px 64px;
    }
    .hero { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; }
    .logo {
      font-size: 28px; width: 52px; height: 52px; display: grid; place-items: center;
      border-radius: 14px; background: var(--accent-soft);
    }
    h1 { margin: 0; font-size: 1.75rem; letter-spacing: -0.02em; }
    .sub { margin: 2px 0 0; color: var(--muted); }
    h2 { font-size: 1.05rem; margin: 0 0 14px; display: flex; align-items: center; gap: 8px; }
    .count {
      font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 999px;
      background: var(--accent-soft); color: var(--accent);
    }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 16px; padding: 20px; box-shadow: var(--shadow); margin-bottom: 32px;
    }
    .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
    label { font-weight: 600; font-size: 0.9rem; }
    input, textarea {
      font: inherit; color: inherit; background: var(--bg);
      border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    textarea { resize: vertical; min-height: 96px; }
    input:hover, textarea:hover { border-color: var(--border-strong); }
    input:focus-visible, textarea:focus-visible {
      outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft);
    }
    textarea[aria-invalid='true'] { border-color: var(--danger); }
    .actions { display: flex; justify-content: flex-end; }
    button {
      font: inherit; font-weight: 600; color: #fff; background: var(--accent);
      border: none; border-radius: 10px; padding: 10px 22px; cursor: pointer;
      transition: background 0.15s, transform 0.05s;
    }
    button:hover:not(:disabled) { background: var(--accent-strong); }
    button:active:not(:disabled) { transform: translateY(1px); }
    button:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 2px; }
    button:disabled { opacity: 0.6; cursor: progress; }
    .error {
      margin: 0 0 14px; padding: 10px 12px; border-radius: 10px;
      background: var(--danger-soft); color: var(--danger); font-size: 0.9rem;
    }
    .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
    .entry {
      display: flex; gap: 12px; padding: 14px 16px; border-radius: 14px;
      background: var(--surface); border: 1px solid var(--border);
      transition: border-color 0.15s;
    }
    .entry:hover { border-color: var(--border-strong); }
    .avatar {
      flex: none; width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center;
      background: var(--accent-soft); color: var(--accent); font-weight: 700;
    }
    .body { min-width: 0; flex: 1; }
    .meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
    .name { overflow-wrap: anywhere; }
    time { color: var(--muted); font-size: 0.8rem; }
    .message { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
    .empty {
      text-align: center; padding: 32px 16px; color: var(--muted);
      border: 1px dashed var(--border-strong); border-radius: 14px;
    }
    .empty span { font-size: 28px; }
    .empty p { margin: 8px 0 0; }
    @media (max-width: 480px) {
      .page { padding: 20px 14px 48px; }
      .card { padding: 16px; }
      .actions button { width: 100%; }
    }
  `,
})
export class App {
  protected readonly entries = signal<Entry[]>([]);
  protected readonly name = signal('');
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected readonly loadError = signal('');
  protected readonly saving = signal(false);
  protected readonly loaded = signal(false);

  constructor() {
    this.load();
  }

  private async load() {
    try {
      const res = await fetch('/api/entries');
      if (!res.ok) throw new Error();
      this.entries.set(await res.json());
      this.loadError.set('');
    } catch {
      this.loadError.set('Could not load entries. Please try again later.');
    } finally {
      this.loaded.set(true);
    }
  }

  protected async sign(event: Event) {
    event.preventDefault();
    const message = this.message().trim();
    if (!message) {
      this.error.set('Please write a message before signing.');
      return;
    }
    this.error.set('');
    this.saving.set(true);
    try {
      const res = await fetch('/api/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.name().trim(), message }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.error.set(data.error || 'Could not save your entry.');
        return;
      }
      this.entries.update((list) => [data as Entry, ...list]);
      this.message.set('');
      this.name.set('');
    } catch {
      this.error.set('Could not save your entry. Check your connection.');
    } finally {
      this.saving.set(false);
    }
  }

  protected initial(name: string) {
    return (name.trim()[0] || '?').toUpperCase();
  }

  protected formatDate(iso: string) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
}
