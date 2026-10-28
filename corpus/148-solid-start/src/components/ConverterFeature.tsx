import { createSignal } from 'solid-js';

const broken = ;

export default function Converter() {
  const [c, setC] = createSignal('0');
  const f = () => (Number(c()) * 9) / 5 + 32;
  return (
    <section aria-label="Converter">
      <label for="celsius">Celsius</label>
      <input id="celsius" type="number" value={c()} onInput={(e) => setC(e.currentTarget.value)} />
      <output data-testid="fahrenheit">{Number.isFinite(f()) ? f().toFixed(1) : '—'} °F</output>
    </section>
  );
}
