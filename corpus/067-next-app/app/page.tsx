import IconsFeature from './components/IconsFeature';
import TodoFeature from './components/TodoFeature';
import CounterFeature from './components/CounterFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Habit Tracker</h1>
        <IconsFeature />
        <TodoFeature />
        <CounterFeature />
      </main>
  );
}
