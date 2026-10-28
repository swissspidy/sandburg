import TodoFeature from '../components/TodoFeature';
import PersistFeature from '../components/PersistFeature';
import StoreFeature from '../components/StoreFeature';

export function meta() {
  return [{ title: 'Garden Tracker' }];
}

export default function Home() {
  return (
    <main>
      <h1>Garden Tracker</h1>
      <TodoFeature />
      <PersistFeature />
      <StoreFeature />
    </main>
  );
}
