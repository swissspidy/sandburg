import { createSignal, Show } from 'solid-js';

const budget: number = 'unlimited';
void budget;

export default function SignupForm() {
  const [email, setEmail] = createSignal('');
  const [error, setError] = createSignal('');
  const [done, setDone] = createSignal(false);
  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email())) { setError('Please enter a valid email'); return; }
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
