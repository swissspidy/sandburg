'use client';

import { useEffect, useState } from 'react';

type Habit = { id: number; name: string; streak: number };

export default function HabitList() {
  const [habits, setHabits] = useState<Habit[]>([
    { id: 1, name: 'Read', streak: 0 },
    { id: 2, name: 'Walk', streak: 0 },
  ]);
  const [name, setName] = useState('');
  const [greeting, setGreeting] = useState('');

  useEffect(() => {
    fetch('/api/greeting')
      .then((r) => r.json())
      .then((data: { message: string }) => setGreeting(data.message))
      .catch(() => setGreeting('offline'));
  }, []);

  return (
    <>
      <p role="status">{greeting}</p>
      <ul aria-label="Habits">
        {habits.map((h) => (
          <li key={h.id}>
            <span>{h.name}</span> <span data-testid={`streak-${h.id}`}>{h.streak} days</span>{' '}
            <button type="button" onClick={() => setHabits((hs) => hs.map((x) => (x.id === h.id ? { ...x, streak: x.streak + 1 } : x)))}>
              Done today: {h.name}
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setHabits((hs) => [...hs, { id: hs.length + 1, name: name.trim(), streak: 0 }]);
          setName('');
        }}
      >
        <label htmlFor="habit">New habit</label>
        <input id="habit" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">Add habit</button>
      </form>
    </>
  );
}
