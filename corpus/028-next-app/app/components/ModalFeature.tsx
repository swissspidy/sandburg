'use client';

import { useState } from 'react';

const budget: number = 'unlimited';
void budget;

export default function ModalDemo() {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Modal demo">
      <button type="button" onClick={() => setOpen(true)}>Open settings</button>
      {open ? (
        <div role="dialog" aria-label="Settings" aria-modal="true">
          <p>Settings go here.</p>
          <button type="button" onClick={() => setOpen(false)}>Close</button>
        </div>
      ) : null}
    </section>
  );
}
