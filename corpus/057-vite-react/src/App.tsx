import TabsFeature from './components/TabsFeature';
import TodoFeature from './components/TodoFeature';
import IconsFeature from './components/IconsFeature';
import SearchFeature from './components/SearchFeature';

export default function App() {
  return (
    <main>
        <h1>Pantry Tracker</h1>
        <TabsFeature />
        <TodoFeature />
        <IconsFeature />
        <SearchFeature />
      </main>
  );
}
