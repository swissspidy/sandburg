import ConverterFeature from './components/ConverterFeature';
import PersistFeature from './components/PersistFeature';
import CounterFeature from './components/CounterFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Reading Tracker</h1>
        <ConverterFeature />
        <PersistFeature />
        <CounterFeature />
      </main>
  );
}
