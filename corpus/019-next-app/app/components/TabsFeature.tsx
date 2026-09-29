'use client';

import { useState } from 'react';

const TABS = [
  { id: 'overview', label: 'Overview', body: 'Project overview' },
  { id: 'specs', label: 'Specs', body: 'Technical specs' },
  { id: 'reviews', label: 'Reviews', body: 'Customer reviews' },
];

export default function Tabs() {
  const [active, setActive] = useState('overview');
  const tab = TABS.find((t) => t.id === active)!;
  return (
    <section aria-label="Details">
      <div role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === active} onClick={() => setActive(t.id)}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel">{tab.body}</div>
    </section>
  );
}
