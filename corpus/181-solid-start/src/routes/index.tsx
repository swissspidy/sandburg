import { Title } from '@solidjs/meta';
import TodoFeature from '../components/TodoFeature';
import CounterFeature from '../components/CounterFeature';

export default function Home() {
  return (
    <main>
      <Title>Music Tracker</Title>
      <h1>Music Tracker</h1>
      <TodoFeature />
      <CounterFeature />
    </main>
  );
}
