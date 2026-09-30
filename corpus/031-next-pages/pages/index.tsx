import StoreFeature from '../components/StoreFeature';
import TodoFeature from '../components/TodoFeature';
import PersistFeature from '../components/PersistFeature';

export default function Home() {
  return (
    <main>
        <h1>Pantry Tracker</h1>
        <StoreFeature />
        <TodoFeature />
        <PersistFeature />
      </main>
  );
}
