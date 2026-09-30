import { useState } from 'react';

export default function Drawer() {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Drawer demo" className="p-4">
      <button type="button" className="rounded bg-blue-600 px-3 py-1 text-white" onClick={() => setOpen(true)}>Show menu</button>
      <nav aria-label="Menu" className={open ? 'block border p-2' : 'hidden'}>
        <a href="#home">Home</a>
        <button type="button" onClick={() => setOpen(false)}>Hide menu</button>
      </nav>
    </section>
  );
}
