import TabsFeature from './components/TabsFeature';
import TodoFeature from './components/TodoFeature';
import StoreFeature from './components/StoreFeature';
import SearchFeature from './components/SearchFeature';

export default function App() {
  return (
    <main>
        <h1>Recipe Tracker</h1>
        <TabsFeature />
        <TodoFeature />
        <StoreFeature />
        <SearchFeature />
      </main>
  );
}
