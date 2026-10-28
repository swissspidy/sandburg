import { Title } from '@solidjs/meta';
import PersistFeature from '../components/PersistFeature';
import FetchFeature from '../components/FetchFeature';
import TodoFeature from '../components/TodoFeature';
import SearchFeature from '../components/SearchFeature';

export default function Home() {
  return (
    <main>
      <Title>Workout Tracker</Title>
      <h1>Workout Tracker</h1>
      <PersistFeature />
      <FetchFeature source="/api/products" />
      <TodoFeature />
      <SearchFeature />
    </main>
  );
}
