import StoreFeature from '../components/StoreFeature';
import FetchFeature from '../components/FetchFeature';
import ConverterFeature from '../components/ConverterFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Habit Tracker</h1>
        <StoreFeature />
        <FetchFeature source="/api/products" />
        <ConverterFeature />
      </main>
  );
}
