import CounterFeature from '../components/CounterFeature';
import FormFeature from '../components/FormFeature';
import TodoFeature from '../components/TodoFeature';

export function meta() {
  return [{ title: 'Habit Tracker' }];
}

export default function Home() {
  return (
    <main>
      <h1>Habit Tracker</h1>
      <CounterFeature />
      <FormFeature />
      <TodoFeature />
    </main>
  );
}
