'use client';

import { useActionState } from 'react';
import { signGuestbook } from './actions.js';

const initialState = { error: null, values: { name: '', message: '' }, ok: false };

export default function SignForm() {
  const [state, formAction, pending] = useActionState(signGuestbook, initialState);
  const hasError = Boolean(state.error);

  return (
    <form action={formAction} className="card sign-form" noValidate>
      <h2 className="form-title">Leave a note</h2>

      <div className="field">
        <label htmlFor="name">Name</label>
        <input
          id="name"
          name="name"
          type="text"
          maxLength={60}
          autoComplete="name"
          placeholder="Your name (optional)"
          defaultValue={state.values.name}
          key={`name-${state.at ?? 'x'}`}
        />
      </div>

      <div className="field">
        <label htmlFor="message">Message</label>
        <textarea
          id="message"
          name="message"
          rows={4}
          maxLength={500}
          placeholder="Say hello…"
          defaultValue={state.values.message}
          key={`message-${state.at ?? 'x'}`}
          aria-invalid={hasError || undefined}
          aria-describedby={hasError ? 'message-error' : undefined}
        />
      </div>

      {hasError && (
        <p id="message-error" role="alert" className="error">
          {state.error}
        </p>
      )}

      <div className="actions">
        <button type="submit" disabled={pending} aria-busy={pending || undefined}>
          Sign
        </button>
        {state.ok && !pending && (
          <span className="success" aria-live="polite">
            Thanks for signing!
          </span>
        )}
      </div>
    </form>
  );
}
