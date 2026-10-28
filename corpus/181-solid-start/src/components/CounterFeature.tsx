import { createSignal } from 'solid-js';

export default function Counter() {
  const [count, setCount] = createSignal(0);
  return (
    <section aria-label="Counter">
      <p data-testid="count">Count: {count()}</p>
      <button type="button" onClick={() => setCount((c) => c + 1)}>Increment</button>
      <button type="button" onClick={() => setCount(0)}>Reset</button>
    </section>
  );
}
