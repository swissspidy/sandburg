import TabsFeature from './components/TabsFeature';
import SearchFeature from './components/SearchFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Garden Tracker</h1>
        <TabsFeature />
        <SearchFeature />
      </main>
  );
}
