import TabsFeature from './components/TabsFeature';
import TodoFeature from './components/TodoFeature';
import StoreFeature from './components/StoreFeature';
import SearchFeature from './components/SearchFeature';

export default function Home() {
  return (
    <main>
        <h1>Garden Tracker</h1>
        <TabsFeature />
        <TodoFeature />
        <StoreFeature />
        <SearchFeature />
      </main>
  );
}
