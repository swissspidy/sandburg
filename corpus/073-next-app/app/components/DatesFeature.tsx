'use client';

import { addDays, format } from 'date-fns';

const START = new Date(2025, 0, 30);

export default function Schedule() {
  return (
    <section aria-label="Schedule">
      <p data-testid="due">Due {format(addDays(START, 2), 'EEEE, MMMM d')}</p>
    </section>
  );
}
