'use client';

import { useState } from 'react';

export default function Converter() {
  const [c, setC] = useState('0');
  const f = (Number(c) * 9) / 5 + 32;
  return (
    <section aria-label="Converter">
      <label htmlFor="celsius">Celsius</label>
      <input id="celsius" type="number" value={c} onChange={(e) => setC(e.target.value)} />
      <output data-testid="fahrenheit">{Number.isFinite(f) ? f.toFixed(1) : '—'} °F</output>
    </section>
  );
}
