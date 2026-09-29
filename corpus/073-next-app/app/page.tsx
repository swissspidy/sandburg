import FetchFeature from './components/FetchFeature';
import DatesFeature from './components/DatesFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Workout Tracker</h1>
        <FetchFeature source="/api/products" />
        <DatesFeature />
      </main>
  );
}
