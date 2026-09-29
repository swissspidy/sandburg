import ConverterFeature from '../components/ConverterFeature';
import CounterFeature from '../components/CounterFeature';
import TabsFeature from '../components/TabsFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Travel Tracker</h1>
        <ConverterFeature />
        <CounterFeature />
        <TabsFeature />
      </main>
  );
}
