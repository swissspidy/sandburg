import StoreFeature from '../components/StoreFeature';
import TodoFeature from '../components/TodoFeature';
import SearchFeature from '../components/SearchFeature';
import TabsFeature from '../components/TabsFeature';

export default function Home() {
  return (
    <main>
        <h1>Habit Tracker</h1>
        <StoreFeature />
        <TodoFeature />
        <SearchFeature />
        <TabsFeature />
      </main>
  );
}
