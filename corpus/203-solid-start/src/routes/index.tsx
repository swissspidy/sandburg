import { Title } from '@solidjs/meta';
import CounterFeature from '../components/CounterFeature';
import FormFeature from '../components/FormFeature';
import TodoFeature from '../components/TodoFeature';

export default function Home() {
  return (
    <main>
      <Title>Study Tracker</Title>
      <h1>Study Tracker</h1>
      <CounterFeature />
      <FormFeature />
      <TodoFeature />
    </main>
  );
}
