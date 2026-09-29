import FormFeature from './components/FormFeature';
import ConverterFeature from './components/ConverterFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Chore Tracker</h1>
        <FormFeature />
        <ConverterFeature />
      </main>
  );
}
