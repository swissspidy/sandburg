import { Title } from '@solidjs/meta';
import PersistFeature from '../components/PersistFeature';
import TodoFeature from '../components/TodoFeature';
import SearchFeature from '../components/SearchFeature';

export default function Home() {
  return (
    <main>
      <Title>Study Tracker</Title>
      <h1>Study Tracker</h1>
      <PersistFeature />
      <TodoFeature />
      <SearchFeature />
    </main>
  );
}
