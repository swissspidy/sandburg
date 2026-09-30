import TodoFeature from './components/TodoFeature';
import SearchFeature from './components/SearchFeature';
import TabsFeature from './components/TabsFeature';
import PersistFeature from './components/PersistFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Music Tracker</h1>
        <TodoFeature />
        <SearchFeature />
        <TabsFeature />
        <PersistFeature />
      </main>
  );
}
