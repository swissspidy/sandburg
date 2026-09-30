'use client';

import { useState } from 'react';

const broken = ;

export default function SignupForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) { setError('Please enter a valid email'); return; }
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
